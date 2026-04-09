import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";

interface LockData {
  pid: number;
  runId: string;
  startedAt: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively kill a process and all its descendants (leaf-first).
 * Uses pgrep to discover children — available on macOS and Linux.
 */
export function killProcessTree(pid: number): void {
  // First, recursively kill all children
  try {
    const out = execSync(`pgrep -P ${pid}`, { encoding: "utf-8", timeout: 5000 });
    const children = out.trim().split("\n").filter(Boolean).map(Number);
    for (const child of children) {
      killProcessTree(child);
    }
  } catch {
    // No children or pgrep failed — that's fine
  }
  // Then kill the process itself
  try {
    process.kill(pid, "SIGTERM");
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
