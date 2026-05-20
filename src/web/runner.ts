import * as path from "node:path";
import { loadPetriConfig, loadPipelineConfig, loadRole, collectRoleNames } from "../config/loader.js";
import { RunLogger } from "../engine/logger.js";
import { Engine } from "../engine/engine.js";
import { createProviderFromConfig } from "../util/provider.js";
import type { AgentProvider } from "../types.js";

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

export function startRun(opts: StartRunOpts): StartRunResult {
  const { projectDir, pipelineFile, input, activeRuns } = opts;

  // 1. Load configs
  const petriConfig = loadPetriConfig(projectDir);
  const pipelineConfig = loadPipelineConfig(projectDir, pipelineFile);

  // 2. Collect role names
  const roleNames = collectRoleNames(pipelineConfig.stages);
  const defaultModel = petriConfig.defaults.model;

  // 3. Load all roles
  const roles: Record<string, ReturnType<typeof loadRole>> = {};
  for (const name of roleNames) {
    roles[name] = loadRole(projectDir, name, defaultModel);
  }

  // 4. Create provider
  const provider: AgentProvider = createProviderFromConfig(projectDir);

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
    .then((runResult) => {
      if (runResult.status === "done") {
        logger.finish("done");
      } else {
        logger.finish("blocked", runResult.stage, runResult.reason);
      }
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
