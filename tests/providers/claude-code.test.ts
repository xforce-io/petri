import { describe, it, expect } from "vitest";
import { spawn, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { killProcessTree, isProcessAlive } from "../../src/engine/lock.js";

/**
 * Claude-code timeout/abort must use the shared killProcessTree helper so
 * grandchildren that escape the bash process group still die (issue #6).
 * These tests drive the production kill path, not a parallel reimplementation.
 */
describe("claude-code kill path (killProcessTree)", () => {
  it("wires production killProcessTree into the provider source", () => {
    const src = readFileSync(join(__dirname, "../../src/providers/claude-code.ts"), "utf-8");
    expect(src).toMatch(/import\s*\{[^}]*killProcessTree[^}]*\}\s*from\s*["']\.\.\/engine\/lock\.js["']/);
    expect(src).toMatch(/killProcessTree\s*\(/);
  });

  it("kills detached process-group members via production killProcessTree", async () => {
    const child = spawn("/bin/bash", ["-c", "sh -c 'sleep 30' &\nwait"], {
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });
    expect(child.pid).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 200));
    let descendants: number[] = [];
    try {
      const out = execSync(`pgrep -g ${child.pid}`, { encoding: "utf-8" }).trim();
      descendants = out
        .split("\n")
        .map((s) => parseInt(s, 10))
        .filter((n) => Number.isFinite(n));
    } catch {
      /* none */
    }
    expect(descendants.length).toBeGreaterThan(0);

    // Same helper claude-code provider calls on abort/timeout
    killProcessTree(child.pid!);
    await new Promise((r) => setTimeout(r, 400));

    for (const pid of descendants) {
      expect(isProcessAlive(pid), `pid ${pid} should be killed`).toBe(false);
    }
  }, 10_000);

  it("kills a grandchild in a different process group (pgid kill alone is insufficient)", async () => {
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
        if (/^\d+$/.test(buf.trim())) {
          grandchildPid = parseInt(buf.trim(), 10);
          resolve();
        }
      });
      child.once("error", reject);
      setTimeout(() => reject(new Error("no grandchild pid")), 3000);
    });

    // Group kill on parent must NOT remove detached grandchild
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      /* parent may die */
    }
    await new Promise((r) => setTimeout(r, 200));
    // Parent may be dead; grandchild with its own pgid should still be alive
    // if only group kill was used on the parent.
    // Re-spawn a controlled tree for the positive path:
    const parent2 = spawn(
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
    let g2 = 0;
    await new Promise<void>((resolve, reject) => {
      let buf = "";
      parent2.stdout!.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        if (/^\d+$/.test(buf.trim())) {
          g2 = parseInt(buf.trim(), 10);
          resolve();
        }
      });
      parent2.once("error", reject);
      setTimeout(() => reject(new Error("no g2")), 3000);
    });

    killProcessTree(parent2.pid!);
    await new Promise((r) => setTimeout(r, 400));
    expect(isProcessAlive(parent2.pid!)).toBe(false);
    expect(isProcessAlive(g2), `detached grandchild ${g2} must die via tree walk`).toBe(false);

    // Cleanup any leftover from the first half
    if (grandchildPid && isProcessAlive(grandchildPid)) {
      try {
        process.kill(grandchildPid, "SIGKILL");
      } catch {
        /* */
      }
    }
    if (child.pid && isProcessAlive(child.pid)) {
      try {
        killProcessTree(child.pid);
      } catch {
        /* */
      }
    }
  }, 15_000);
});
