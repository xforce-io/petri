import { describe, it, expect } from "vitest";
import { spawn, execSync } from "node:child_process";
import { killProcessTree, isProcessAlive } from "../../src/engine/lock.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function listChildren(pid: number): number[] {
  try {
    const out = execSync(`pgrep -P ${pid}`, { encoding: "utf-8" }).trim();
    return out
      .split("\n")
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n));
  } catch {
    return [];
  }
}

/** Collect full descendant tree (BFS via pgrep -P). */
function collectTree(rootPid: number): number[] {
  const found: number[] = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    for (const child of listChildren(pid)) {
      if (!found.includes(child)) {
        found.push(child);
        queue.push(child);
      }
    }
  }
  return found;
}

describe("killProcessTree", () => {
  it("kills multi-level descendants including a child that left the process group", async () => {
    // Parent node stays in our group; it spawns a *detached* sleep so the
    // grandchild has a different pgid. Group-SIGKILL on the parent alone
    // must not be sufficient — tree walk via PPID is required (issue #6).
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
const { spawn } = require("node:child_process");
const g = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
g.unref();
process.stdout.write(String(g.pid) + "\\n");
setInterval(() => {}, 1000);
`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    expect(child.pid).toBeGreaterThan(0);

    let grandchildPid = 0;
    await new Promise<void>((resolve, reject) => {
      let buf = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const line = buf.trim();
        if (/^\d+$/.test(line)) {
          grandchildPid = parseInt(line, 10);
          resolve();
        }
      });
      child.once("error", reject);
      setTimeout(() => reject(new Error("timed out waiting for grandchild pid")), 3000);
    });
    expect(grandchildPid).toBeGreaterThan(0);
    expect(isProcessAlive(grandchildPid)).toBe(true);

    // Sanity: grandchild is NOT in the parent's process group
    let parentGroup: number[] = [];
    try {
      const out = execSync(`pgrep -g ${child.pid}`, { encoding: "utf-8" }).trim();
      parentGroup = out.split("\n").map((s) => parseInt(s, 10)).filter(Number.isFinite);
    } catch {
      /* empty */
    }
    expect(parentGroup.includes(grandchildPid)).toBe(false);

    // Production kill path — must walk the tree, not only -pgid
    killProcessTree(child.pid!);
    await sleep(400);

    expect(isProcessAlive(child.pid!), `parent ${child.pid} should be dead`).toBe(false);
    expect(isProcessAlive(grandchildPid), `grandchild ${grandchildPid} should be dead`).toBe(false);
  }, 15_000);

  it("kills a SIGTERM-resistant descendant (requires SIGKILL)", async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
process.on("SIGTERM", () => {}); // ignore soft kill
setInterval(() => {}, 1000);
`,
      ],
      { stdio: "ignore" },
    );
    expect(child.pid).toBeGreaterThan(0);
    await sleep(150);
    expect(isProcessAlive(child.pid!)).toBe(true);

    killProcessTree(child.pid!);
    await sleep(400);

    expect(isProcessAlive(child.pid!), `SIGTERM-resistant pid ${child.pid} must die under killProcessTree`).toBe(
      false,
    );
  }, 10_000);

  it("kills a three-level bash→sh→sleep tree", async () => {
    // Outer bash keeps the tree rooted; inner sh runs sleep. Use & wait so
    // the outer process stays alive as parent while children run.
    const child = spawn("/bin/bash", ["-c", "sh -c 'sleep 60' & wait"], {
      stdio: "ignore",
      detached: true,
    });
    expect(child.pid).toBeGreaterThan(0);
    await sleep(300);
    const tree = collectTree(child.pid!);
    // At least sleep (and usually sh) should be descendants
    expect(tree.length).toBeGreaterThan(0);

    killProcessTree(child.pid!);
    await sleep(400);

    for (const pid of [child.pid!, ...tree]) {
      expect(isProcessAlive(pid), `pid ${pid} should be dead`).toBe(false);
    }
  }, 10_000);
});

describe("isProcessAlive", () => {
  it("returns false for a non-existent pid", () => {
    expect(isProcessAlive(2_147_483_647)).toBe(false);
  });

  it("returns true for the current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  acquireLock,
  inspectLock,
  listProjectLockFiles,
  releaseLock,
  resolveRunRoot,
  workspaceLockKey,
} from "../../src/engine/lock.js";

describe("per-workspace run locks (issue #78)", () => {
  it("assigns different lock keys for different worktree paths", () => {
    const a = workspaceLockKey("/repo/.worktrees/issue-60");
    const b = workspaceLockKey("/repo/.worktrees/issue-63");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^wt-issue-60$/);
    expect(b).toMatch(/^wt-issue-63$/);
  });

  it("resolveRunRoot isolates worktree storage from in-place", () => {
    const root = "/proj";
    expect(resolveRunRoot({ projectRoot: root, workspaceDir: root })).toBe(
      path.join(root, ".petri"),
    );
    expect(
      resolveRunRoot({
        projectRoot: root,
        workspaceDir: path.join(root, ".worktrees", "issue-A"),
      }),
    ).toBe(path.join(root, ".petri", "ws", "wt-issue-A"));
    expect(
      resolveRunRoot({
        projectRoot: root,
        workspaceDir: path.join(root, ".worktrees", "issue-B"),
      }),
    ).toBe(path.join(root, ".petri", "ws", "wt-issue-B"));
  });

  it("allows two different lock files to be held concurrently", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "petri-lock-"));
    try {
      const lockA = path.join(tmp, "ws", "a", "run.lock");
      const lockB = path.join(tmp, "ws", "b", "run.lock");
      acquireLock(lockA, "001", { workspace: "/ws/a" });
      acquireLock(lockB, "002", { workspace: "/ws/b" });
      expect(fs.existsSync(lockA)).toBe(true);
      expect(fs.existsSync(lockB)).toBe(true);
      releaseLock(lockA);
      releaseLock(lockB);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("same lock key still rejects a second active acquire", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "petri-lock2-"));
    const lockFile = path.join(tmp, "run.lock");
    try {
      acquireLock(lockFile, "001", { workspace: "/same" });
      expect(() => acquireLock(lockFile, "002", { workspace: "/same" })).toThrow(
        /Another pipeline run is already active/,
      );
      expect(() => acquireLock(lockFile, "002")).toThrow(/Lock file:/);
      releaseLock(lockFile);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("inspectLock reports active vs stale and cleanup hints", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "petri-lock3-"));
    const lockFile = path.join(tmp, "run.lock");
    try {
      expect(inspectLock(lockFile).status).toBe("absent");
      acquireLock(lockFile, "009", { workspace: "/w" });
      const active = inspectLock(lockFile);
      expect(active.status).toBe("active");
      if (active.status === "active") {
        expect(active.runId).toBe("009");
        expect(active.cleanupHint).toMatch(/Wait for PID|Do not delete/i);
      }
      releaseLock(lockFile);
      // Stale: write dead pid
      fs.writeFileSync(
        lockFile,
        JSON.stringify({
          pid: 99999999,
          runId: "010",
          startedAt: new Date().toISOString(),
        }),
      );
      const stale = inspectLock(lockFile);
      expect(stale.status).toBe("stale");
      if (stale.status === "stale") {
        expect(stale.cleanupHint).toMatch(/rm /);
      }
      const listed = listProjectLockFiles(tmp);
      // listProjectLockFiles expects project .petri layout; root lock at tmp/run.lock
      expect(listed).toContain(lockFile);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
