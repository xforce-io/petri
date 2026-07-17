import { loadPetriConfig, loadPipelineConfig, loadRole } from "../config/loader.js";
import { isRepeatBlock, isCommandStage, type GateCheck, type GateCheckClause, type GateConfig, type LoadedRole, type StageEntry } from "../types.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateProject(projectDir: string, pipelineFile: string = "pipeline.yaml"): ValidationResult {
  const errors: string[] = [];
  const pipeLabel = pipelineFile || "pipeline.yaml";

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
  let commandStageCount = 0;
  try {
    const pipelineConfig = loadPipelineConfig(projectDir, pipelineFile);
    function walk(stages: StageEntry[]): void {
      for (const entry of stages) {
        if (isRepeatBlock(entry)) {
          const r = entry.repeat as Partial<typeof entry.repeat>;
          const labeledName = typeof r.name === "string" && r.name.length > 0 ? r.name : "(unnamed)";
          if (typeof r.name !== "string" || r.name.length === 0) {
            errors.push(`${pipeLabel}: repeat block missing required "name" field (string)`);
          }
          if (
            typeof r.max_iterations !== "number"
            || !Number.isInteger(r.max_iterations)
            || r.max_iterations < 1
          ) {
            errors.push(
              `${pipeLabel}: repeat block "${labeledName}" missing or invalid "max_iterations" (must be positive integer ≥ 1)`,
            );
          }
          if (typeof r.until !== "string" || r.until.length === 0) {
            errors.push(`${pipeLabel}: repeat block "${labeledName}" missing required "until" field (gate id string)`);
          }
          repeatBlocks.push({ name: labeledName, until: typeof r.until === "string" ? r.until : "" });
          walk(Array.isArray(r.stages) ? r.stages : []);
        } else if (isCommandStage(entry)) {
          const cmdName = typeof entry.name === "string" && entry.name.length > 0 ? entry.name : "(unnamed)";
          if (typeof entry.name !== "string" || entry.name.length === 0) {
            errors.push(`${pipeLabel}: command stage missing required "name" field (string)`);
          }
          if (typeof entry.command !== "string" || entry.command.length === 0) {
            errors.push(`${pipeLabel}: command stage "${cmdName}" missing required "command" field (non-empty string)`);
          }
          if (entry.gate !== undefined) {
            const g = entry.gate as Partial<GateConfig>;
            if (!g || typeof g !== "object" || typeof g.id !== "string" || g.id.length === 0) {
              errors.push(`${pipeLabel}: command stage "${cmdName}" gate must have a non-empty string "id"`);
            }
            if (!g || typeof g !== "object" || !g.evidence || typeof g.evidence !== "object" || typeof g.evidence.path !== "string" || g.evidence.path.length === 0) {
              errors.push(`${pipeLabel}: command stage "${cmdName}" gate must have "evidence.path" (string)`);
            }
          }
          commandStageCount++;
        } else {
          const stageName = typeof entry.name === "string" && entry.name.length > 0 ? entry.name : "(unnamed)";
          if (typeof entry.name !== "string" || entry.name.length === 0) {
            errors.push(`${pipeLabel}: stage missing required "name" field (string)`);
          }
          if (!Array.isArray(entry.roles) || entry.roles.length === 0) {
            errors.push(
              `${pipeLabel}: stage "${stageName}" missing required "roles" field (non-empty list of role names, e.g. roles: [<name>] — note plural "roles", not "role")`,
            );
            continue;
          }
          for (const role of entry.roles) {
            roleNames.add(role);
          }
        }
      }
    }
    if (!Array.isArray(pipelineConfig.stages) || pipelineConfig.stages.length === 0) {
      errors.push(
        `${pipeLabel}: top-level "stages" must be a non-empty list of stages and/or repeat blocks. If you placed "repeat:" at the top level, wrap it: stages: [- repeat: {...}]`,
      );
    } else {
      walk(pipelineConfig.stages);
      if (repeatBlocks.length === 0 && commandStageCount === 0) {
        errors.push(
          `${pipeLabel}: pipeline must contain at least one repeat: block or command stage (no feedback loop and no deterministic step = empty workflow)`,
        );
      }
    }
  } catch (err: unknown) {
    errors.push(`${pipeLabel}: ${err instanceof Error ? err.message : String(err)}`);
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
  // check is not only self-report booleans. Keep regex in sync with summary.ts.
  const WEAK_BOOLEAN_FIELD = /(^|_)(completed?|done|finished|ready|written)$/i;
  const isWeakSelfReport = (check: GateCheckClause): boolean =>
    check.equals === true && WEAK_BOOLEAN_FIELD.test(check.field);
  const renderFields = (check: GateCheck): string => {
    const checks = Array.isArray(check) ? check : [check];
    return checks.map((c) => c.field).join(", ");
  };
  const hasRealSignal = (check: GateCheck): boolean => {
    const checks = Array.isArray(check) ? check : [check];
    return checks.some((c) => !isWeakSelfReport(c));
  };
  const gateById = new Map<string, LoadedRole>();
  for (const role of loadedRoles) {
    if (role.gate) gateById.set(role.gate.id, role);
  }
  for (const block of repeatBlocks) {
    const role = gateById.get(block.until);
    if (!role || !role.gate) continue; // missing-gate is a separate concern; don't double-report
    const check = role.gate.evidence.check;
    if (check && !hasRealSignal(check)) {
      errors.push(
        `${pipeLabel}: repeat block "${block.name}" exits only on self-report boolean checks (gate "${block.until}", fields: ${renderFields(check)}) — loop has no real signal, exits after first iteration`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}
