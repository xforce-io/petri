import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import chalk from "chalk";
import {
  loadPetriConfig,
  loadPipelineConfig,
  loadRole,
  collectRoleNames,
} from "../config/loader.js";
import { Engine } from "../engine/engine.js";
import { RunLogger, loadRunLog } from "../engine/logger.js";
import { currentGeneratedHashes, loadGeneratedManifest, sha256 } from "../engine/manifest.js";
import {
  acquireLock,
  releaseLock,
  killProcessTree,
  lockFilePath,
  resolveRunRoot,
} from "../engine/lock.js";
import { loadBranch, normalizeRunId, runRootForBranch } from "../engine/branch.js";
import { createProviderRegistryFromConfig, validateRoleProviderConfig } from "../util/provider.js";
import { resolveIssueInput } from "../input/issue-input.js";
import type { LoadedRole } from "../types.js";

interface RunOptions {
  pipeline: string;
  input?: string;
  from?: string;
  skipTo?: string;
  resumeRun?: string;
  requireClean?: boolean;
  /** Optional worktree directory name under .worktrees/; presence still implies worktree mode. */
  worktree?: string | boolean;
  /** Run in the current working tree (main/trunk). Overrides default worktree isolation. */
  inPlace?: boolean;
  /**
   * Reuse an existing `.worktrees/<name>` directory (keep WIP).
   * Resume (`--resume-run`) also enables reuse when the named path exists (issue #74).
   */
  reuseWorktree?: boolean;
  branch?: string;
}

/** Resolved workspace execution mode for `petri run` (issue #71). */
export type WorkspaceMode =
  | { mode: "in-place" }
  | { mode: "worktree"; name: string };

export const IN_PLACE_WORKTREE_CONFLICT =
  "--in-place cannot be combined with --worktree. Use --in-place for the current working tree, or omit it (optionally with --worktree [name]) for isolation.";

/**
 * Worktree names must be a single directory segment under `.worktrees/`
 * (no path separators / traversal).
 */
export function assertWorktreeDirName(name: string): void {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    throw new Error(
      `Invalid --worktree name "${name}". Use a single directory segment under .worktrees/ (no path separators).`,
    );
  }
}

/**
 * Default is worktree isolation; only --in-place runs on the current tree (trunk).
 * --worktree [name] remains for naming the auto worktree directory.
 */
export function resolveWorkspaceMode(
  opts: { inPlace?: boolean; worktree?: string | boolean },
  now: () => number = Date.now,
): WorkspaceMode {
  if (opts.inPlace) {
    if (opts.worktree !== undefined) {
      throw new Error(IN_PLACE_WORKTREE_CONFLICT);
    }
    return { mode: "in-place" };
  }
  const name =
    typeof opts.worktree === "string" && opts.worktree.length > 0
      ? opts.worktree
      : `run-${now()}`;
  assertWorktreeDirName(name);
  return { mode: "worktree", name };
}

/** Decision for create vs reuse vs refuse when resolving a named worktree (issue #74). */
export type WorktreeLifecycle =
  | { action: "create"; path: string; name: string }
  | { action: "reuse"; path: string; name: string; reason: "resume" | "flag" }
  | { action: "refuse"; path: string; name: string };

/**
 * Pure policy: existing worktree is reused only with `--resume-run` or
 * `--reuse-worktree`; otherwise refuse (never silent overwrite). Missing path → create.
 */
export function resolveWorktreeLifecycle(opts: {
  cwd: string;
  name: string;
  pathExists: boolean;
  resumeRun?: string;
  reuseWorktree?: boolean;
}): WorktreeLifecycle {
  const worktreePath = path.resolve(opts.cwd, ".worktrees", opts.name);
  if (!opts.pathExists) {
    return { action: "create", path: worktreePath, name: opts.name };
  }
  if (opts.resumeRun) {
    return { action: "reuse", path: worktreePath, name: opts.name, reason: "resume" };
  }
  if (opts.reuseWorktree) {
    return { action: "reuse", path: worktreePath, name: opts.name, reason: "flag" };
  }
  return { action: "refuse", path: worktreePath, name: opts.name };
}

/** Actionable error when an existing worktree would be clobbered (issue #74 S2). */
export function buildWorktreeRefuseMessage(decision: {
  path: string;
  name: string;
}): string {
  return [
    `Error: Worktree directory already exists at ${decision.path}`,
    `Refusing to recreate from HEAD (would risk losing WIP). To continue with existing sources:`,
    `  petri run --reuse-worktree --worktree ${decision.name} ...`,
    `  petri run --resume-run <id> --skip-to <stage> --worktree ${decision.name} ...`,
    `Or pick a new name: --worktree <other-name>`,
    `To discard and recreate: git worktree remove ${decision.path}  (only if WIP is safe to drop)`,
  ].join("\n");
}

/** Parsed WIP signal for a worktree (issue #74 S3). */
export type WorktreeWip = {
  path: string;
  hasChanges: boolean;
  fileCount: number;
  /** Raw `git diff --stat` (may be empty when only untracked files exist). */
  diffStat: string;
  /** Paths from `git status --porcelain` (tracked + untracked). */
  changedPaths: string[];
};

/**
 * Derive WIP from git porcelain + diff --stat. Untracked-only trees count as
 * non-empty even when `git diff --stat` is blank.
 */
export function parseWorktreeWip(opts: {
  worktreePath: string;
  porcelain: string;
  diffStat: string;
}): WorktreeWip {
  const changedPaths: string[] = [];
  for (const line of opts.porcelain.split("\n")) {
    if (!line.trim()) continue;
    // porcelain: XY PATH or XY ORIG -> PATH
    const rest = line.slice(3);
    const arrow = rest.indexOf(" -> ");
    const filePath = (arrow >= 0 ? rest.slice(arrow + 4) : rest).trim();
    if (filePath) changedPaths.push(filePath);
  }
  const fileCount = changedPaths.length;
  const hasChanges = fileCount > 0 || opts.diffStat.trim().length > 0;
  return {
    path: opts.worktreePath,
    hasChanges,
    fileCount,
    diffStat: opts.diffStat,
    changedPaths,
  };
}

/** Operator-visible lines for end-of-run worktree summary (issue #74 S3). */
export function formatWorktreeWipReport(wip: WorktreeWip): string[] {
  const lines: string[] = [`Path: ${wip.path}`];
  if (!wip.hasChanges) {
    lines.push("", "No code changes made.");
    return lines;
  }
  lines.push("", `WIP: ${wip.fileCount} file(s) with uncommitted changes`);
  if (wip.diffStat.trim()) {
    lines.push("", "Changes:", wip.diffStat.trimEnd());
  }
  // When diff --stat is empty (typical untracked-only WIP), list paths so operators
  // never see "Path + No code changes" while porcelain is non-empty.
  if (!wip.diffStat.trim() && wip.changedPaths.length > 0) {
    lines.push("", "Untracked / dirty paths:");
    for (const p of wip.changedPaths) {
      lines.push(`  ${p}`);
    }
  } else if (wip.diffStat.trim()) {
    const missingFromStat = wip.changedPaths.filter(
      (p) => !wip.diffStat.includes(p) && !wip.diffStat.includes(path.basename(p)),
    );
    if (missingFromStat.length > 0) {
      lines.push("", "Also untracked / unstaged paths:");
      for (const p of missingFromStat) {
        lines.push(`  ${p}`);
      }
    }
  }
  return lines;
}

/** Collect WIP via git in a worktree directory; empty on failure. */
export function collectWorktreeWip(worktreePath: string): WorktreeWip {
  let porcelain = "";
  let diffStat = "";
  try {
    porcelain = execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
      cwd: worktreePath,
    });
  } catch {
    porcelain = "";
  }
  try {
    diffStat = execFileSync("git", ["diff", "--stat"], {
      encoding: "utf8",
      cwd: worktreePath,
    });
  } catch {
    diffStat = "";
  }
  // Also include staged+unstaged in diff --stat for a fuller picture
  try {
    const all = execFileSync("git", ["diff", "--stat", "HEAD"], {
      encoding: "utf8",
      cwd: worktreePath,
    });
    if (all.trim().length > diffStat.trim().length) {
      diffStat = all;
    }
  } catch {
    // ignore
  }
  return parseWorktreeWip({ worktreePath, porcelain, diffStat });
}

/** Validate and normalize the source run that an explicit resume continues from. */
export function resolveResumeSource(
  petriDir: string,
  resumeRun?: string,
  skipTo?: string,
): { runId: string; stage: string } | undefined {
  if (!resumeRun) return undefined;
  if (!skipTo) {
    throw new Error("--resume-run requires --skip-to <stage>.");
  }
  const runDirName = normalizeRunId(resumeRun);
  const source = loadRunLog(path.join(petriDir, "runs", runDirName));
  if (!source) {
    throw new Error(`Resume source run not found: ${runDirName}`);
  }
  return { runId: source.runId, stage: skipTo };
}

/**
 * Inherit pipeline input from a prior run's run.json (issue #58).
 * Used when --resume-run is set and the operator did not pass --input/--from.
 */
export function inheritInputFromResumeRun(
  petriDir: string,
  resumeRun?: string,
): string | undefined {
  if (!resumeRun) return undefined;
  const runDirName = normalizeRunId(resumeRun);
  const source = loadRunLog(path.join(petriDir, "runs", runDirName));
  if (!source) return undefined;
  const text = typeof source.input === "string" ? source.input.trim() : "";
  return text || undefined;
}

/** Actionable error when no input source is available (including resume inherit). */
export const NO_INPUT_MESSAGE =
  "No input provided. Use --input, --from, set .petri/goal.md or pipeline 'goal', " +
  "or pass --resume-run <id> with --skip-to to inherit the source run's input.";

export async function runCommand(opts: RunOptions): Promise<void> {
  const cwd = process.cwd();
  let executionCwd = cwd;
  const branchConfig = opts.branch ? loadBranch(cwd, opts.branch) : undefined;

  if (opts.requireClean) {
    try {
      const status = execSync("git status --porcelain", { encoding: "utf8", cwd });
      if (status.trim() !== "") {
        console.error(chalk.red("Error: Working tree is not clean. Commit or stash your changes, or run without --require-clean."));
        process.exit(1);
      }
    } catch (e) {}
  }

  let worktreePath: string | undefined;
  let workspaceMode: WorkspaceMode;
  try {
    workspaceMode = resolveWorkspaceMode(opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(message));
    process.exit(1);
  }

  if (workspaceMode.mode === "worktree") {
    const lifecycle = resolveWorktreeLifecycle({
      cwd,
      name: workspaceMode.name,
      pathExists: fs.existsSync(path.resolve(cwd, ".worktrees", workspaceMode.name)),
      resumeRun: opts.resumeRun,
      reuseWorktree: opts.reuseWorktree,
    });
    worktreePath = lifecycle.path;

    if (lifecycle.action === "refuse") {
      console.error(chalk.red(buildWorktreeRefuseMessage(lifecycle)));
      process.exit(1);
    }

    if (lifecycle.action === "reuse") {
      console.log(
        chalk.blue(
          `Reusing existing worktree at ${worktreePath} (${lifecycle.reason === "resume" ? "resume" : "--reuse-worktree"}; keeping WIP)...`,
        ),
      );
      executionCwd = worktreePath;
    } else {
      try {
        const status = execSync("git status --porcelain", { encoding: "utf8", cwd });
        if (status.trim() !== "") {
          console.log(
            chalk.yellow(
              "Warning: You have uncommitted changes in your working tree. The worktree is created from HEAD and will not include them.",
            ),
          );
        }
      } catch {
        // Not a git repo or git unavailable — worktree add below will fail with guidance.
      }

      try {
        fs.mkdirSync(path.join(cwd, ".worktrees"), { recursive: true });
        console.log(chalk.blue(`Creating temporary worktree at ${worktreePath}...`));
        execFileSync("git", ["worktree", "add", worktreePath, "HEAD"], {
          stdio: "ignore",
          cwd,
        });
        executionCwd = worktreePath;
      } catch {
        console.error(
          chalk.red(
            "Error: Failed to create git worktree (is this a git repository?). " +
              "Use --in-place to run in the current working tree.",
          ),
        );
        process.exit(1);
      }
    }
  }

  // 1. Load configs.
  // petri.yaml stays at cwd. pipeline.yaml may be in a subdir (e.g. .petri/generated/);
  // when so, roles are loaded from that subdir's roles/ if it exists, else cwd's roles/.
  // This bridges `petri create` output (.petri/generated/{pipeline.yaml,roles/}) to
  // `petri run` without requiring a manual promote step.
  const petriConfig = loadPetriConfig(cwd);
  const pipelineConfig = loadPipelineConfig(cwd, opts.pipeline);
  const pipelineAbs = path.resolve(cwd, opts.pipeline);
  const pipelineDir = path.dirname(pipelineAbs);
  const rolesBase = fs.existsSync(path.join(pipelineDir, "roles"))
    ? pipelineDir
    : cwd;

  // 2. Resolve run storage + lock namespace from the *execution* workspace (#78).
  // Worktrees get `.petri/ws/<key>` so concurrent issue worktrees do not share one lock.
  const branchRoot = opts.branch ? runRootForBranch(cwd, opts.branch) : undefined;
  const petriDir = resolveRunRoot({
    projectRoot: cwd,
    workspaceDir: executionCwd,
    branchRoot,
  });
  const legacyPetriDir = runRootForBranch(cwd, opts.branch);

  // Resume source: prefer workspace-scoped runs, fall back to project `.petri` (pre-#78).
  let resumedFrom: { runId: string; stage: string } | undefined;
  try {
    if (opts.resumeRun) {
      try {
        resumedFrom = resolveResumeSource(petriDir, opts.resumeRun, opts.skipTo);
      } catch (first) {
        if (legacyPetriDir !== petriDir) {
          resumedFrom = resolveResumeSource(legacyPetriDir, opts.resumeRun, opts.skipTo);
        } else {
          throw first;
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(message));
    process.exit(1);
  }

  // 3. Resolve input: --input > --from > goal.md > pipeline.goal > resume run input
  let input: string | undefined;
  let inputSource: "input" | "from" | "goal.md" | "pipeline.goal" | "resume" | undefined;
  if (opts.input) {
    input = opts.input;
    inputSource = "input";
  } else if (opts.from) {
    const inputPath = path.resolve(cwd, opts.from);
    if (!fs.existsSync(inputPath)) {
      console.error(chalk.red(`Input file not found: ${inputPath}`));
      process.exit(1);
    }
    input = fs.readFileSync(inputPath, "utf-8");
    inputSource = "from";
  } else {
    const persistedGoal = path.join(cwd, ".petri", "goal.md");
    if (fs.existsSync(persistedGoal)) {
      input = fs.readFileSync(persistedGoal, "utf-8");
      inputSource = "goal.md";
    } else if (pipelineConfig.goal) {
      input = pipelineConfig.goal;
      inputSource = "pipeline.goal";
    } else if (opts.resumeRun) {
      input =
        inheritInputFromResumeRun(petriDir, opts.resumeRun) ??
        (legacyPetriDir !== petriDir
          ? inheritInputFromResumeRun(legacyPetriDir, opts.resumeRun)
          : undefined);
      if (input) inputSource = "resume";
    }
  }

  if (!input) {
    console.error(chalk.red(NO_INPUT_MESSAGE));
    process.exit(1);
  }

  if (inputSource === "resume") {
    console.log(
      chalk.blue(
        `Inheriting input from resume run-${resumedFrom?.runId ?? normalizeRunId(opts.resumeRun!)}`,
      ),
    );
  }

  try {
    input = resolveIssueInput({ projectDir: cwd, input }).input;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(message));
    process.exit(1);
  }

  const generatedManifest = loadGeneratedManifest(pipelineDir);
  if (generatedManifest) {
    const currentGoalHash = sha256(input.trim());
    const generatedHashes = currentGeneratedHashes(pipelineDir);
    if (currentGoalHash !== generatedManifest.goal_hash) {
      console.log(chalk.yellow(
        "Warning: current goal differs from the goal used to generate this pipeline. Regenerate with `petri create --from .petri/goal.md` before relying on old artifacts.",
      ));
    }
    if (
      generatedHashes.pipeline_hash !== generatedManifest.pipeline_hash
      || generatedHashes.roles_hash !== generatedManifest.roles_hash
    ) {
      console.log(chalk.yellow(
        "Warning: generated pipeline/roles changed since manifest creation. Existing artifacts may not match current stages or gates; start a fresh run for reliable results.",
      ));
    }
  }

  // 4. Collect all role names from pipeline stages (recursing into nested
  //    repeats; command stages have no roles and are skipped)
  const roleNames = new Set<string>(collectRoleNames(pipelineConfig.stages));

  // 5. Load all roles (from pipeline.yaml's directory if it has a roles/ sibling, else cwd)
  const defaultModel = petriConfig.defaults.model;
  const roles: Record<string, LoadedRole> = {};
  for (const name of roleNames) {
    roles[name] = loadRole(rolesBase, name, defaultModel);
  }
  validateRoleProviderConfig(Object.values(roles), petriConfig);

  // 6. Create every configured provider; Engine resolves the role's named one.
  const providerRegistry = createProviderRegistryFromConfig(cwd);

  // 7. Create logger and engine
  const artifactBaseDir = path.join(petriDir, "artifacts");
  const logger = new RunLogger(petriDir, pipelineConfig.name, input, pipelineConfig.goal, {
    branchId: branchConfig?.branch_id,
    branchObjective: branchConfig?.objective,
    branchBaseline: branchConfig?.baseline,
    resumedFrom,
  });
  const engine = new Engine({
    providers: providerRegistry.providers,
    defaultProviderName: providerRegistry.defaultProviderName,
    roles,
    artifactBaseDir,
    defaultGateStrategy: petriConfig.defaults.gate_strategy,
    defaultMaxRetries: petriConfig.defaults.max_retries,
    logger,
    skipTo: opts.skipTo,
    workspaceDir: executionCwd,
  });

  // 7. Acquire per-workspace lock (issue #78) — different worktrees do not block each other
  const lockFile = lockFilePath(petriDir);
  acquireLock(lockFile, logger.runId, { workspace: executionCwd });
  if (petriDir !== legacyPetriDir) {
    console.log(chalk.gray(`Run storage: ${petriDir}`));
  }

  // Ensure cleanup on signals — kill entire process tree so child processes (e.g. python training) are also terminated
  const cleanup = (signal: string) => {
    console.log(chalk.yellow(`\nReceived ${signal}, shutting down...`));
    logger.finish("blocked", undefined, `Interrupted by ${signal}`);
    killProcessTree(process.pid);
    releaseLock(lockFile);
    process.exit(1);
  };
  process.on("SIGINT", () => cleanup("SIGINT"));
  process.on("SIGTERM", () => cleanup("SIGTERM"));

  // 8. Run and print result
  const branchLabel = branchConfig ? ` branch=${branchConfig.branch_id}` : "";
  console.log(chalk.blue(`Running pipeline: ${pipelineConfig.name} (run-${logger.runId}${branchLabel})`));
  if (resumedFrom) {
    console.log(chalk.blue(`Resuming from run-${resumedFrom.runId} at stage: ${resumedFrom.stage}`));
  }
  if (executionCwd !== cwd) {
    process.chdir(executionCwd);
  }

  try {
    const result = await engine.run(pipelineConfig, input);

    if (result.status === "done") {
      logger.finish("done");
      console.log(chalk.green("Pipeline completed successfully."));
      console.log(chalk.gray(`Run: ${logger.runDir}`));
    } else {
      logger.finish("blocked", result.stage, result.reason);
      console.log(chalk.red(`Pipeline blocked at stage: ${result.stage}`));
      if (result.reason) {
        console.log(chalk.red(`Reason: ${result.reason}`));
      }
      console.log(chalk.gray(`Run: ${logger.runDir}`));
    }

    if (worktreePath) {
      console.log(chalk.blue(`\n--- Worktree Summary ---`));
      const wip = collectWorktreeWip(worktreePath);
      for (const line of formatWorktreeWipReport(wip)) {
        console.log(line);
      }
      console.log(chalk.gray(`To keep these changes, commit them or merge the branch.`));
      if (wip.hasChanges) {
        console.log(
          chalk.gray(
            `To continue with this WIP: petri run --reuse-worktree --worktree ${path.basename(worktreePath)} ...`,
          ),
        );
        console.log(
          chalk.gray(
            `  or: petri run --resume-run ${logger.runId} --skip-to <stage> --worktree ${path.basename(worktreePath)} ...`,
          ),
        );
      }
      console.log(chalk.gray(`To discard, run: git worktree remove ${worktreePath}`));
    }

    if (result.status !== "done") {
      process.exit(1);
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.finish("blocked", undefined, `Unexpected error: ${msg}`);
    console.error(chalk.red(`Pipeline failed: ${msg}`));
    process.exit(1);
  } finally {
    releaseLock(lockFile);
  }
}
