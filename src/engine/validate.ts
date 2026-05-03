import { loadPetriConfig, loadPipelineConfig, loadRole } from "../config/loader.js";
import { isRepeatBlock, type StageEntry } from "../types.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateProject(projectDir: string): ValidationResult {
  const errors: string[] = [];

  // 1. Load petri.yaml
  let defaultModel = "default";
  try {
    const petriConfig = loadPetriConfig(projectDir);
    defaultModel = petriConfig.defaults.model;
  } catch (err: unknown) {
    errors.push(`petri.yaml: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Load pipeline.yaml
  const roleNames = new Set<string>();
  let repeatBlockCount = 0;
  try {
    const pipelineConfig = loadPipelineConfig(projectDir);
    function walk(stages: StageEntry[]): void {
      for (const entry of stages) {
        if (isRepeatBlock(entry)) {
          repeatBlockCount += 1;
          walk(entry.repeat.stages);
        } else {
          for (const role of entry.roles) {
            roleNames.add(role);
          }
        }
      }
    }
    walk(pipelineConfig.stages);
    if (repeatBlockCount === 0) {
      errors.push(
        "pipeline.yaml: pipeline must contain at least one repeat: block (no feedback loop = workflow, not training pipeline)",
      );
    }
  } catch (err: unknown) {
    errors.push(`pipeline.yaml: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Load each role
  for (const name of roleNames) {
    try {
      loadRole(projectDir, name, defaultModel);
    } catch (err: unknown) {
      errors.push(`role "${name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { valid: errors.length === 0, errors };
}
