import { loadPetriConfig, loadPipelineConfig, loadRole } from "../config/loader.js";
import { isRepeatBlock, type LoadedRole, type StageEntry } from "../types.js";

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

  // 2. Load pipeline.yaml — walk tree, count repeat blocks, collect (repeatName, untilId)
  const roleNames = new Set<string>();
  const repeatBlocks: { name: string; until: string }[] = [];
  try {
    const pipelineConfig = loadPipelineConfig(projectDir);
    function walk(stages: StageEntry[]): void {
      for (const entry of stages) {
        if (isRepeatBlock(entry)) {
          repeatBlocks.push({ name: entry.repeat.name, until: entry.repeat.until });
          walk(entry.repeat.stages);
        } else {
          for (const role of entry.roles) {
            roleNames.add(role);
          }
        }
      }
    }
    walk(pipelineConfig.stages);
    if (repeatBlocks.length === 0) {
      errors.push(
        "pipeline.yaml: pipeline must contain at least one repeat: block (no feedback loop = workflow, not training pipeline)",
      );
    }
  } catch (err: unknown) {
    errors.push(`pipeline.yaml: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Load each role; remember loaded roles for gate lookup in step 4
  const loadedRoles: LoadedRole[] = [];
  for (const name of roleNames) {
    try {
      loadedRoles.push(loadRole(projectDir, name, defaultModel));
    } catch (err: unknown) {
      errors.push(`role "${name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 4. Loop-trivial check: each repeat.until must reference a gate whose
  // evidence.check.field is not literally "completed".
  const gateById = new Map<string, LoadedRole>();
  for (const role of loadedRoles) {
    if (role.gate) gateById.set(role.gate.id, role);
  }
  for (const block of repeatBlocks) {
    const role = gateById.get(block.until);
    if (!role || !role.gate) continue; // missing-gate is a separate concern; don't double-report
    const field = role.gate.evidence.check?.field;
    if (field === "completed") {
      errors.push(
        `pipeline.yaml: repeat block "${block.name}" exits on completed=true (gate "${block.until}") — loop has no real signal, exits after first iteration`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}
