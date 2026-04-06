import * as path from "node:path";
import { loadPetriConfig, loadPipelineConfig, loadRole } from "../config/loader.js";
import { RunLogger } from "../engine/logger.js";
import { Engine } from "../engine/engine.js";
import { isRepeatBlock } from "../types.js";
import { PiProvider } from "../providers/pi.js";
import { ClaudeCodeProvider } from "../providers/claude-code.js";
import type { AgentProvider, PipelineConfig, StageConfig } from "../types.js";

export interface StartRunOpts {
  projectDir: string;
  pipelineFile: string;
  input: string;
  activeRuns: Map<string, RunLogger>;
}

export interface StartRunResult {
  runId: string;
  logger: RunLogger;
}

/**
 * Collect all role names referenced in pipeline stages,
 * including those inside repeat blocks.
 */
function collectRoleNames(pipeline: PipelineConfig): string[] {
  const names = new Set<string>();

  function fromStages(stages: StageConfig[]): void {
    for (const stage of stages) {
      for (const role of stage.roles) {
        names.add(role);
      }
    }
  }

  for (const entry of pipeline.stages) {
    if (isRepeatBlock(entry)) {
      fromStages(entry.repeat.stages);
    } else {
      for (const role of entry.roles) {
        names.add(role);
      }
    }
  }

  return Array.from(names);
}

export function startRun(opts: StartRunOpts): StartRunResult {
  const { projectDir, pipelineFile, input, activeRuns } = opts;

  // 1. Load configs
  const petriConfig = loadPetriConfig(projectDir);
  const pipelineConfig = loadPipelineConfig(projectDir, pipelineFile);

  // 2. Collect role names
  const roleNames = collectRoleNames(pipelineConfig);
  const defaultModel = petriConfig.defaults.model;

  // 3. Load all roles
  const roles: Record<string, ReturnType<typeof loadRole>> = {};
  for (const name of roleNames) {
    roles[name] = loadRole(projectDir, name, defaultModel);
  }

  // 4. Create provider
  let provider: AgentProvider;
  const providerEntries = Object.entries(petriConfig.providers);
  const hasClaudeCode = providerEntries.some(([, v]) => v.type === "claude_code");

  if (hasClaudeCode) {
    provider = new ClaudeCodeProvider(defaultModel);
  } else {
    // Build model mappings for PiProvider
    const modelMappings: Record<string, { piProvider: string; piModel: string }> = {};
    for (const [modelAlias, modelCfg] of Object.entries(petriConfig.models ?? {})) {
      const provCfg = petriConfig.providers[modelCfg.provider];
      if (provCfg) {
        modelMappings[modelAlias] = {
          piProvider: modelCfg.provider,
          piModel: modelCfg.model,
        };
      }
    }
    provider = new PiProvider(modelMappings);
  }

  // 5. Create logger and engine
  const petriDir = path.join(projectDir, ".petri");
  const logger = new RunLogger(petriDir, pipelineConfig.name, input, pipelineConfig.goal);
  const artifactBaseDir = path.join(petriDir, "artifacts");

  const engine = new Engine({
    provider,
    roles,
    artifactBaseDir,
    defaultGateStrategy: petriConfig.defaults.gate_strategy,
    defaultMaxRetries: petriConfig.defaults.max_retries,
    logger,
  });

  // 6. Register in activeRuns
  activeRuns.set(logger.runId, logger);

  // 7. Fire and forget engine.run()
  engine
    .run(pipelineConfig, input)
    .then(() => {
      logger.finish("done");
      activeRuns.delete(logger.runId);
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.finish("blocked", undefined, message);
      activeRuns.delete(logger.runId);
    });

  // 8. Return immediately
  return { runId: logger.runId, logger };
}
