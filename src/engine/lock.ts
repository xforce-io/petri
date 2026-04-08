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
 * Acquire a run lock. Throws if another run is already active.
 * Stale locks (dead PID) are automatically cleaned up.
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
      // Stale lock — process is dead, clean up
      console.log(`  Cleaning up stale lock from run-${existing.runId} (PID ${existing.pid} is dead)`);
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
