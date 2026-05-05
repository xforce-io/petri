import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";

/**
 * Sanity check the kill-process-group mechanism that ClaudeCodeProvider uses
 * on timeout. The provider previously used execSync + default SIGTERM, which
 * left orphan claude subprocesses alive past the timeout. Fix: detached
 * spawn + process.kill(-pid, "SIGKILL") on the entire group.
 *
 * This test directly exercises that primitive on a sleep subprocess so the
 * regression is caught even if the provider's surface (claude binary lookup,
 * pipe wrapping, etc.) changes.
 */
describe("process-group SIGKILL mechanism (used by claude-code provider)", () => {
  it("kills detached process and all descendants on timeout", async () => {
    // bash spawns sh, sh runs sleep 30 — three-process tree to simulate
    // bash → claude → grandchild. SIGTERM on bash often leaves grand-children
    // orphaned; SIGKILL on the process group cleans up the whole tree.
    const child = spawn("/bin/bash", ["-c", "sh -c 'sleep 30' &\nwait"], {
      stdio: ["ignore", "ignore", "ignore"],
      detached: true, // new process group
    });
    expect(child.pid).toBeGreaterThan(0);

    // Capture descendant PIDs while still alive
    await new Promise((r) => setTimeout(r, 200));
    const { execSync } = await import("node:child_process");
    let descendants: number[] = [];
    try {
      const out = execSync(`pgrep -g ${child.pid}`, { encoding: "utf-8" }).trim();
      descendants = out.split("\n").map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n));
    } catch {
      // pgrep returns non-zero if no match
    }
    expect(descendants.length).toBeGreaterThan(0);

    // Kill the group with SIGKILL — identical to the provider's timeout path
    process.kill(-child.pid!, "SIGKILL");

    // Wait for OS to reap
    await new Promise((r) => setTimeout(r, 300));

    // Every descendant must be gone. process.kill(pid, 0) throws if dead.
    for (const pid of descendants) {
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      expect(alive, `pid ${pid} should be killed by SIGKILL on group ${child.pid}`).toBe(false);
    }
  });
});
