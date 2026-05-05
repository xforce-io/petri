import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import chalk from "chalk";
import {
  loadPetriConfig,
  loadPipelineConfig,
  loadRole,
} from "../config/loader.js";
import { Engine } from "../engine/engine.js";
import { RunLogger } from "../engine/logger.js";
import { currentGeneratedHashes, loadGeneratedManifest, sha256 } from "../engine/manifest.js";
import { acquireLock, releaseLock, killProcessTree } from "../engine/lock.js";
import { PiProvider } from "../providers/pi.js";
import { ClaudeCodeProvider } from "../providers/claude-code.js";
import { isRepeatBlock } from "../types.js";
import type { AgentProvider, LoadedRole } from "../types.js";

interface RunOptions {
  pipeline: string;
  input?: string;
  from?: string;
  skipTo?: string;
  requireClean?: boolean;
  worktree?: string | boolean;
}

export async function runCommand(opts: RunOptions): Promise<void> {
  const cwd = process.cwd();
  let executionCwd = cwd;

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

  // 2. Resolve input: --input > --from > persisted goal > pipeline goal
  let input: string | undefined;
  if (opts.input) {
    input = opts.input;
  } else if (opts.from) {
    const inputPath = path.resolve(cwd, opts.from);
    if (!fs.existsSync(inputPath)) {
      console.error(chalk.red(`Input file not found: ${inputPath}`));
      process.exit(1);
    }
    input = fs.readFileSync(inputPath, "utf-8");
  } else {
    const persistedGoal = path.join(cwd, ".petri", "goal.md");
    if (fs.existsSync(persistedGoal)) {
      input = fs.readFileSync(persistedGoal, "utf-8");
    } else if (pipelineConfig.goal) {
      input = pipelineConfig.goal;
    }
  }

  if (!input) {
    console.error(chalk.red("No input provided. Use --input, --from, or set 'goal' in pipeline.yaml."));
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

  // 3. Collect all role names from pipeline stages (recursing into nested repeats)
  const roleNames = new Set<string>();
  function collectRoles(stages: import("../types.js").StageEntry[]): void {
    for (const entry of stages) {
      if (isRepeatBlock(entry)) {
        collectRoles(entry.repeat.stages);
      } else {
        for (const role of entry.roles) {
          roleNames.add(role);
        }
      }
    }
  }
  collectRoles(pipelineConfig.stages);

  // 4. Load all roles (from pipeline.yaml's directory if it has a roles/ sibling, else cwd)
  const defaultModel = petriConfig.defaults.model;
  const roles: Record<string, LoadedRole> = {};
  for (const name of roleNames) {
    roles[name] = loadRole(rolesBase, name, defaultModel);
  }

  // 5. Create provider based on config
  const defaultProviderType = Object.values(petriConfig.providers)[0]?.type ?? "pi";
  let provider: AgentProvider;

  if (defaultProviderType === "claude_code") {
    provider = new ClaudeCodeProvider(defaultModel);
  } else {
    const modelMappings: Record<string, { piProvider: string; piModel: string }> = {};
    for (const [alias, mc] of Object.entries(petriConfig.models)) {
      modelMappings[alias] = {
        piProvider: "anthropic",
        piModel: mc.model,
      };
    }
    provider = new PiProvider(modelMappings);
  }

  // 6. Create logger and engine
  const petriDir = path.join(cwd, ".petri");
  const artifactBaseDir = path.join(petriDir, "artifacts");
  const logger = new RunLogger(petriDir, pipelineConfig.name, input, pipelineConfig.goal);
  const engine = new Engine({
    provider,
    roles,
    artifactBaseDir,
    defaultGateStrategy: petriConfig.defaults.gate_strategy,
    defaultMaxRetries: petriConfig.defaults.max_retries,
    logger,
    skipTo: opts.skipTo,
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
  console.log(chalk.blue(`Running pipeline: ${pipelineConfig.name} (run-${logger.runId})`));
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
