/**
 * Shared helpers for CLI-backed AgentProviders (claude_code / codex / grok).
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { killProcessTree } from "../engine/lock.js";

export function scanArtifacts(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => !name.startsWith("."))
      .filter((name) => {
        try {
          return statSync(join(dir, name)).isFile();
        } catch {
          return false;
        }
      })
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

export function firstExistingBinary(candidates: string[], fallback: string): string {
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return fallback;
}

export interface CliSpawnResult {
  exitCode: number | null;
  timedOut: boolean;
  exitErr: Error | null;
}

/**
 * Spawn a shell command in a detached process group, honor AbortSignal and
 * wall-clock timeout, and kill the full process tree (same contract as
 * ClaudeCodeProvider).
 */
export async function spawnCliCommand(
  cmd: string,
  options: {
    cwd: string;
    timeoutMs: number;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
  },
): Promise<CliSpawnResult> {
  let timedOut = false;
  let exitCode: number | null = null;
  let exitErr: Error | null = null;

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/bin/bash", ["-c", cmd], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["ignore", "ignore", "inherit"],
        detached: true,
      });
      const killChildTree = () => {
        if (child.pid !== undefined) {
          killProcessTree(child.pid);
        }
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      };
      const onAbort = () => {
        timedOut = true;
        killChildTree();
      };
      if (options.signal?.aborted) {
        onAbort();
      } else {
        options.signal?.addEventListener("abort", onAbort, { once: true });
      }
      const timer = setTimeout(() => {
        timedOut = true;
        killChildTree();
      }, options.timeoutMs);
      const forceSettle = setTimeout(() => {
        if (exitCode === null && !exitErr) {
          timedOut = true;
          killChildTree();
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          resolve();
        }
      }, options.timeoutMs + 5_000);
      forceSettle.unref?.();
      child.once("exit", (code) => {
        clearTimeout(timer);
        clearTimeout(forceSettle);
        options.signal?.removeEventListener("abort", onAbort);
        exitCode = code;
        resolve();
      });
      child.once("error", (err) => {
        clearTimeout(timer);
        clearTimeout(forceSettle);
        options.signal?.removeEventListener("abort", onAbort);
        exitErr = err;
        reject(err);
      });
    });
  } catch (err) {
    exitErr = err instanceof Error ? err : new Error(String(err));
  }

  return { exitCode, timedOut, exitErr };
}
