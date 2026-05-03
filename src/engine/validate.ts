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
          const r = entry.repeat as Partial<typeof entry.repeat>;
          const labeledName = typeof r.name === "string" && r.name.length > 0 ? r.name : "(unnamed)";
          if (typeof r.name !== "string" || r.name.length === 0) {
            errors.push(`pipeline.yaml: repeat block missing required "name" field (string)`);
          }
          if (
            typeof r.max_iterations !== "number"
            || !Number.isInteger(r.max_iterations)
            || r.max_iterations < 1
          ) {
            errors.push(
              `pipeline.yaml: repeat block "${labeledName}" missing or invalid "max_iterations" (must be positive integer ≥ 1)`,
            );
          }
          if (typeof r.until !== "string" || r.until.length === 0) {
            errors.push(`pipeline.yaml: repeat block "${labeledName}" missing required "until" field (gate id string)`);
          }
          repeatBlocks.push({ name: labeledName, until: typeof r.until === "string" ? r.until : "" });
          walk(Array.isArray(r.stages) ? r.stages : []);
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
  // check is not a self-report boolean. Keep regex in sync with summary.ts.
  const WEAK_BOOLEAN_FIELD = /(^|_)(completed?|done|finished|ready|written)$/i;
  const gateById = new Map<string, LoadedRole>();
  for (const role of loadedRoles) {
    if (role.gate) gateById.set(role.gate.id, role);
  }
  for (const block of repeatBlocks) {
    const role = gateById.get(block.until);
    if (!role || !role.gate) continue; // missing-gate is a separate concern; don't double-report
    const check = role.gate.evidence.check;
    if (check && check.equals === true && WEAK_BOOLEAN_FIELD.test(check.field)) {
      errors.push(
        `pipeline.yaml: repeat block "${block.name}" exits on self-report boolean (gate "${block.until}", field "${check.field}=true") — loop has no real signal, exits after first iteration`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}
