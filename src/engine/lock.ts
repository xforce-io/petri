import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";

interface LockData {
  pid: number;
  runId: string;
  startedAt: string;
}

/**
 * True if the OS reports the pid as signalable (process exists).
 * Exported for tests and for providers that need post-kill assertions.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Collect every descendant PID of `rootPid` via repeated `pgrep -P` (BFS).
 * Order is breadth-first discovery order (parents before children within a level).
 */
export function collectDescendantPids(rootPid: number): number[] {
  const found: number[] = [];
  const seen = new Set<number>();
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    let children: number[] = [];
    try {
      const out = execSync(`pgrep -P ${pid}`, { encoding: "utf-8", timeout: 5000 });
      children = out
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0);
    } catch {
      // No children or pgrep failed
    }
    for (const child of children) {
      if (!seen.has(child)) {
        seen.add(child);
        found.push(child);
        queue.push(child);
      }
    }
  }
  return found;
}

/**
 * Recursively kill a process and all its descendants (leaf-first), then the root.
 *
 * Uses PPID tree discovery (`pgrep -P`) so descendants that left the process
 * group (e.g. `detached: true` / new session while still parented) are still
 * targeted — group SIGKILL alone is insufficient (issue #6).
 *
 * Default signal is SIGKILL because SIGTERM is often ignored by long-running
 * agent subprocesses (observed with claude-code grandchildren).
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
  if (!Number.isFinite(pid) || pid <= 0) return;

  const descendants = collectDescendantPids(pid);
  // Leaf-first: reverse BFS order so children die before parents.
  for (const child of descendants.slice().reverse()) {
    try {
      process.kill(child, signal);
    } catch {
      // Already dead
    }
  }

  // If the root is a process-group leader, also clear its group (covers peers
  // not visible as PPID children in some edge cases).
  try {
    process.kill(-pid, signal);
  } catch {
    // Not a group leader or group already gone
  }

  try {
    process.kill(pid, signal);
  } catch {
    // Already dead
  }
}

/**
 * Acquire a run lock. Throws if another run is already active.
 * Stale locks (dead PID) are automatically cleaned up, including orphaned child processes.
 */
export function acquireLock(lockFile: string, runId: string): void {
  if (existsSync(lockFile)) {
    try {
      const existing: LockData = JSON.parse(readFileSync(lockFile, "utf-8"));
      if (isProcessAlive(existing.pid)) {
        throw new Error(
          `Another pipeline run is already active (run-${existing.runId}, PID ${existing.pid}, started ${existing.startedAt}). ` +
          `If this is stale, delete ${lockFile} and retry.`,
        );
      }
      // Stale lock — process is dead, but children may still be alive
      console.log(`  Cleaning up stale lock from run-${existing.runId} (PID ${existing.pid} is dead)`);
      killProcessTree(existing.pid);
    } catch (e) {
      if (e instanceof Error && e.message.includes("Another pipeline")) throw e;
      // Malformed lock file — remove it
    }
    unlinkSync(lockFile);
  }

  const lock: LockData = {
    pid: process.pid,
    runId,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(lockFile, JSON.stringify(lock, null, 2), "utf-8");
}

/**
 * Release the run lock. Safe to call multiple times.
 */
export function releaseLock(lockFile: string): void {
  try {
    if (existsSync(lockFile)) {
      unlinkSync(lockFile);
    }
  } catch {
    // Best-effort cleanup
  }
}
