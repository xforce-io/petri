import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

export interface LockData {
  pid: number;
  runId: string;
  startedAt: string;
  /** Absolute workspace path this lock guards (issue #78). */
  workspace?: string;
}

/**
 * Stable lock / run-storage namespace for a source workspace (issue #78).
 * Different worktrees get different keys so concurrent runs do not share one global lock.
 */
export function workspaceLockKey(workspaceAbs: string): string {
  const abs = resolve(workspaceAbs);
  const worktreeSeg = abs.match(/[/\\]\.worktrees[/\\]([^/\\]+)$/);
  if (worktreeSeg) {
    const name = worktreeSeg[1].replace(/[^a-zA-Z0-9._-]+/g, "-");
    return `wt-${name}`;
  }
  return `ws-${createHash("sha256").update(abs).digest("hex").slice(0, 12)}`;
}

/**
 * Where run artifacts + run.lock live for a given project root and execution workspace.
 * - In-place (workspace === project root): `.petri`
 * - Worktree / other path: `.petri/ws/<key>` so locks and artifacts do not collide
 * - Named exploration branch: existing branch root (unchanged)
 */
export function resolveRunRoot(opts: {
  projectRoot: string;
  workspaceDir: string;
  branchRoot?: string;
}): string {
  if (opts.branchRoot) return opts.branchRoot;
  const projectRoot = resolve(opts.projectRoot);
  const workspaceDir = resolve(opts.workspaceDir);
  if (workspaceDir === projectRoot) {
    return join(projectRoot, ".petri");
  }
  return join(projectRoot, ".petri", "ws", workspaceLockKey(workspaceDir));
}

export function lockFilePath(runRoot: string): string {
  return join(runRoot, "run.lock");
}

export type LockInspection =
  | { status: "absent"; lockFile: string }
  | {
      status: "active" | "stale" | "malformed";
      lockFile: string;
      pid?: number;
      runId?: string;
      startedAt?: string;
      workspace?: string;
      cleanupHint: string;
    };

/** Read and classify a lock file for status / diagnostics (issue #78 S3). */
export function inspectLock(lockFile: string): LockInspection {
  if (!existsSync(lockFile)) {
    return { status: "absent", lockFile };
  }
  try {
    const data = JSON.parse(readFileSync(lockFile, "utf-8")) as LockData;
    const alive = isProcessAlive(data.pid);
    return {
      status: alive ? "active" : "stale",
      lockFile,
      pid: data.pid,
      runId: data.runId,
      startedAt: data.startedAt,
      workspace: data.workspace,
      cleanupHint: alive
        ? `Wait for PID ${data.pid} to finish, or stop that process. Do not delete an active lock.`
        : `Stale lock (PID ${data.pid} is dead). Safe to delete: rm ${lockFile}`,
    };
  } catch {
    return {
      status: "malformed",
      lockFile,
      cleanupHint: `Malformed lock file. Safe to delete: rm ${lockFile}`,
    };
  }
}

/** List lock files under a project `.petri` tree (root + ws/*). */
export function listProjectLockFiles(projectPetriDir: string): string[] {
  const files: string[] = [];
  const rootLock = join(projectPetriDir, "run.lock");
  if (existsSync(rootLock)) files.push(rootLock);
  const wsDir = join(projectPetriDir, "ws");
  if (existsSync(wsDir)) {
    for (const name of readdirSync(wsDir)) {
      const lf = join(wsDir, name, "run.lock");
      if (existsSync(lf)) files.push(lf);
    }
  }
  return files;
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
 * Acquire a run lock. Throws if another run is already active on the same lock file.
 * Stale locks (dead PID) are automatically cleaned up, including orphaned child processes.
 * Different workspaces use different lock files via resolveRunRoot (issue #78).
 */
export function acquireLock(
  lockFile: string,
  runId: string,
  opts?: { workspace?: string },
): void {
  mkdirSync(join(lockFile, ".."), { recursive: true });
  if (existsSync(lockFile)) {
    try {
      const existing: LockData = JSON.parse(readFileSync(lockFile, "utf-8"));
      if (isProcessAlive(existing.pid)) {
        throw new Error(
          `Another pipeline run is already active (run-${existing.runId}, PID ${existing.pid}, started ${existing.startedAt}` +
            (existing.workspace ? `, workspace ${existing.workspace}` : "") +
            `). Lock file: ${lockFile}. ` +
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
    workspace: opts?.workspace,
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
