import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type {
  PetriConfig,
  PipelineConfig,
  RoleConfig,
  GateConfig,
  GateCheck,
  GateCheckClause,
  LoadedRole,
} from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const COMPARATORS = ["equals", "gt", "gte", "lt", "lte", "in"] as const;

function validateGateCheckClause(c: unknown, label: string): asserts c is GateCheckClause {
  if (!c || typeof c !== "object" || Array.isArray(c) || typeof (c as any).field !== "string") {
    throw new Error(`gate.yaml: '${label}.field' must be a string when 'evidence.check' is set`);
  }
  const hasComparator = COMPARATORS.some((k) => k in (c as any));
  if (!hasComparator) {
    throw new Error(`gate.yaml: '${label}' must include at least one of equals/gt/gte/lt/lte/in`);
  }
}

function validateGateCheck(check: unknown): asserts check is GateCheck {
  if (Array.isArray(check)) {
    if (check.length === 0) {
      throw new Error("gate.yaml: 'evidence.check' array must contain at least one check");
    }
    check.forEach((c, i) => validateGateCheckClause(c, `evidence.check[${i}]`));
    return;
  }
  validateGateCheckClause(check, "evidence.check");
}

/**
 * Load petri.yaml from the project directory. Throws if missing.
 */
export function loadPetriConfig(projectDir: string): PetriConfig {
  const configPath = path.join(projectDir, "petri.yaml");
  if (!fs.existsSync(configPath)) {
    throw new Error(`petri.yaml not found in ${projectDir}`);
  }
  const raw = fs.readFileSync(configPath, "utf-8");
  return parseYaml(raw) as PetriConfig;
}

/**
 * Load a pipeline config. Defaults to pipeline.yaml.
 */
export function loadPipelineConfig(
  projectDir: string,
  filename: string = "pipeline.yaml"
): PipelineConfig {
  const configPath = path.join(projectDir, filename);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Pipeline config not found: ${configPath}`);
  }
  const raw = fs.readFileSync(configPath, "utf-8");
  return parseYaml(raw) as PipelineConfig;
}

/**
 * Load a role by name from roles/{roleName}/.
 * Reads role.yaml, soul.md, playbooks/, and gate.yaml.
 */
export function loadRole(
  projectDir: string,
  roleName: string,
  defaultModel: string
): LoadedRole {
  const roleDir = path.join(projectDir, "roles", roleName);
  const roleYamlPath = path.join(roleDir, "role.yaml");

  if (!fs.existsSync(roleYamlPath)) {
    throw new Error(`Role config not found: ${roleYamlPath}`);
  }

  const roleConfig = parseYaml(
    fs.readFileSync(roleYamlPath, "utf-8")
  ) as RoleConfig;

  // Read soul.md for the persona text
  const soulPath = path.join(roleDir, "soul.md");
  let persona = roleConfig.persona;
  if (fs.existsSync(soulPath)) {
    persona = fs.readFileSync(soulPath, "utf-8");
  }

  if (!Array.isArray(roleConfig.playbooks)) {
    throw new Error(`roles/${roleName}/role.yaml: 'playbooks' must be an array`);
  }
  const playbookRefs = roleConfig.playbooks;
  const playbooks: string[] = playbookRefs.map((playbookRef) => {
    if (playbookRef.startsWith("petri:")) {
      const builtinName = playbookRef.slice("petri:".length);
      return loadBuiltinPlaybook(builtinName);
    }
    // Local playbook: read from roles/{roleName}/playbooks/{name}.md.
    const playbookPath = path.join(roleDir, "playbooks", `${playbookRef}.md`);
    if (!fs.existsSync(playbookPath)) {
      throw new Error(`Playbook not found: ${playbookPath}`);
    }
    return fs.readFileSync(playbookPath, "utf-8");
  });

  // Load gate.yaml if present
  let gate: GateConfig | null = null;
  const gatePath = path.join(roleDir, "gate.yaml");
  if (fs.existsSync(gatePath)) {
    const raw = parseYaml(fs.readFileSync(gatePath, "utf-8")) as any;
    // Resolve gate id: new format uses "id", legacy uses "requires" (string or object key)
    let gateId = raw.id;
    if (!gateId && raw.requires) {
      gateId = typeof raw.requires === "string"
        ? raw.requires
        : Object.keys(raw.requires)[0];
    }
    if (!gateId || typeof gateId !== "string") {
      throw new Error("gate.yaml: missing required 'id' field");
    }
    if (!raw.evidence || typeof raw.evidence !== "object" || Array.isArray(raw.evidence)) {
      throw new Error("gate.yaml: 'evidence' must be an object with a 'path' field");
    }
    if (!raw.evidence.path || typeof raw.evidence.path !== "string") {
      throw new Error("gate.yaml: 'evidence.path' is required (string). Note: 'check' must be nested under 'evidence', not a top-level field.");
    }
    if (raw.evidence.check !== undefined) {
      validateGateCheck(raw.evidence.check);
    }
    gate = {
      id: gateId,
      description: raw.description,
      evidence: raw.evidence,
    };
  }

  return {
    name: roleName,
    persona,
    model: roleConfig.model ?? defaultModel,
    playbooks,
    gate,
  };
}

/**
 * Load a built-in playbook from src/playbooks/{name}.md.
 */
export function loadBuiltinPlaybook(name: string): string {
  // Resolve relative to this file — check multiple candidates for bundled vs dev
  const candidates = [
    path.join(__dirname, "..", "playbooks", `${name}.md`),             // dev: src/config/../playbooks
    path.join(__dirname, "..", "src", "playbooks", `${name}.md`),      // bundled: dist/../src/playbooks
    path.join(__dirname, "..", "..", "src", "playbooks", `${name}.md`), // bundled: dist/../../src/playbooks
  ];
  const playbookPath = candidates.find((p) => fs.existsSync(p));
  if (!playbookPath) {
    throw new Error(`Built-in playbook not found: ${name} (looked at ${candidates.join(", ")})`);
  }
  return fs.readFileSync(playbookPath, "utf-8");
}
