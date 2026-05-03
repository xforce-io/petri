import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type {
  PetriConfig,
  PipelineConfig,
  RoleConfig,
  GateConfig,
  LoadedRole,
} from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
 * Reads role.yaml, soul.md, skills/, and gate.yaml.
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

  // Resolve skills
  const skills: string[] = (roleConfig.skills ?? []).map((skillRef) => {
    if (skillRef.startsWith("petri:")) {
      const builtinName = skillRef.slice("petri:".length);
      return loadBuiltinSkill(builtinName);
    }
    // Local skill: read from roles/{roleName}/skills/{name}.md
    const skillPath = path.join(roleDir, "skills", `${skillRef}.md`);
    if (!fs.existsSync(skillPath)) {
      throw new Error(`Skill not found: ${skillPath}`);
    }
    return fs.readFileSync(skillPath, "utf-8");
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
      const c = raw.evidence.check;
      if (!c || typeof c !== "object" || typeof c.field !== "string") {
        throw new Error("gate.yaml: 'evidence.check.field' must be a string when 'evidence.check' is set");
      }
      const hasComparator = ["equals", "gt", "lt", "in"].some((k) => k in c);
      if (!hasComparator) {
        throw new Error("gate.yaml: 'evidence.check' must include at least one of equals/gt/lt/in");
      }
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
    skills,
    gate,
  };
}

/**
 * Load a built-in skill from src/skills/{name}.md.
 */
export function loadBuiltinSkill(name: string): string {
  // Resolve relative to this file — check multiple candidates for bundled vs dev
  const candidates = [
    path.join(__dirname, "..", "skills", `${name}.md`),             // dev: src/config/../skills
    path.join(__dirname, "..", "src", "skills", `${name}.md`),      // bundled: dist/../src/skills
    path.join(__dirname, "..", "..", "src", "skills", `${name}.md`), // bundled: dist/../../src/skills
  ];
  const skillPath = candidates.find((p) => fs.existsSync(p));
  if (!skillPath) {
    throw new Error(`Built-in skill not found: ${name} (looked at ${candidates.join(", ")})`);
  }
  return fs.readFileSync(skillPath, "utf-8");
}
