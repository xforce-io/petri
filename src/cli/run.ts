import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import {
  loadPetriConfig,
  loadPipelineConfig,
  loadRole,
} from "../config/loader.js";
import { Engine } from "../engine/engine.js";
import { RunLogger } from "../engine/logger.js";
import { PiProvider } from "../providers/pi.js";
import { ClaudeCodeProvider } from "../providers/claude-code.js";
import { isRepeatBlock } from "../types.js";
import type { AgentProvider, LoadedRole } from "../types.js";

interface RunOptions {
  pipeline: string;
  input?: string;
  from?: string;
}

export async function runCommand(opts: RunOptions): Promise<void> {
  const cwd = process.cwd();

  // 1. Load configs
  const petriConfig = loadPetriConfig(cwd);
  const pipelineConfig = loadPipelineConfig(cwd, opts.pipeline);

  // 2. Resolve input: --input > --from > pipeline goal
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
  } else if (pipelineConfig.goal) {
    input = pipelineConfig.goal;
  }

  if (!input) {
    console.error(chalk.red("No input provided. Use --input, --from, or set 'goal' in pipeline.yaml."));
    process.exit(1);
  }

  // 3. Collect all role names from pipeline stages
  const roleNames = new Set<string>();
  for (const entry of pipelineConfig.stages) {
    if (isRepeatBlock(entry)) {
      for (const stage of entry.repeat.stages) {
        for (const role of stage.roles) {
          roleNames.add(role);
        }
      }
    } else {
      for (const role of entry.roles) {
        roleNames.add(role);
      }
    }
  }

  // 4. Load all roles
  const defaultModel = petriConfig.defaults.model;
  const roles: Record<string, LoadedRole> = {};
  for (const name of roleNames) {
    roles[name] = loadRole(cwd, name, defaultModel);
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
  });

  // 7. Run and print result
  console.log(chalk.blue(`Running pipeline: ${pipelineConfig.name}`));
  const result = await engine.run(pipelineConfig, input);

  if (result.status === "done") {
    logger.finish("done");
    console.log(chalk.green("Pipeline completed successfully."));
    console.log(chalk.gray(`Log: ${path.join(petriDir, "run.log")}`));
  } else {
    logger.finish("blocked", result.stage, result.reason);
    console.log(chalk.red(`Pipeline blocked at stage: ${result.stage}`));
    if (result.reason) {
      console.log(chalk.red(`Reason: ${result.reason}`));
    }
    console.log(chalk.gray(`Log: ${path.join(petriDir, "run.log")}`));
    process.exit(1);
  }
}
