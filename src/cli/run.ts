import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
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
import { acquireLock, releaseLock, killProcessTree } from "../engine/lock.js";
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
  worktree?: string | boolean;
  branch?: string;
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
  if (opts.worktree) {
    try {
      const status = execSync("git status --porcelain", { encoding: "utf8", cwd });
      if (status.trim() !== "") {
        console.log(chalk.yellow("Warning: You have uncommitted changes in your working tree. The worktree is created from HEAD and will not include them."));
      }
    } catch (e) {}

    const dirName = typeof opts.worktree === "string" ? opts.worktree : `run-${Date.now()}`;
    worktreePath = path.resolve(cwd, ".worktrees", dirName);
    if (fs.existsSync(worktreePath)) {
      console.error(chalk.red(`Error: Worktree directory already exists at ${worktreePath}`));
      process.exit(1);
    }
    try {
      fs.mkdirSync(path.join(cwd, ".worktrees"), { recursive: true });
      console.log(chalk.blue(`Creating temporary worktree at ${worktreePath}...`));
      execSync(`git worktree add ${worktreePath} HEAD`, { stdio: "ignore", cwd });
      executionCwd = worktreePath;
    } catch (e) {
      console.error(chalk.red(`Error: Failed to create git worktree.`));
      process.exit(1);
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

  // 2. Resolve resume source early so input can inherit from the source run (issue #58)
  const petriDir = runRootForBranch(cwd, opts.branch);
  let resumedFrom: { runId: string; stage: string } | undefined;
  try {
    resumedFrom = resolveResumeSource(petriDir, opts.resumeRun, opts.skipTo);
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
      input = inheritInputFromResumeRun(petriDir, opts.resumeRun);
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

  // 7. Acquire lock to prevent concurrent runs
  const lockFile = path.join(petriDir, "run.lock");
  acquireLock(lockFile, logger.runId);

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
      console.log(`Path: ${worktreePath}`);
      try {
        const diff = execSync("git diff --stat", { encoding: "utf8", cwd: worktreePath });
        if (diff.trim()) {
          console.log(`\nChanges:`);
          console.log(diff);
        } else {
          console.log(`\nNo code changes made.`);
        }
      } catch (e) {}
      console.log(chalk.gray(`To keep these changes, commit them or merge the branch.`));
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
