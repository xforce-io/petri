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
