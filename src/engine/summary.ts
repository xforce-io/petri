import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import type { GateCheckClause } from "../types.js";

export interface PipelineSummaryRole {
  name: string;
  personaFirstLine: string;
  playbooks: string[];
}

export type GateStrength = "strong" | "weak" | "none";

export interface StageSummary {
  kind: "stage" | "repeat";
  // For "stage":
  name?: string;
  roles?: string[];
  gateStrength?: GateStrength;
  gateCheck?: string;
  // For "repeat":
  repeatName?: string;
  maxIterations?: number;
  until?: string;
  innerStages?: StageSummary[];
}

export interface PipelineSummary {
  name: string;
  goal?: string;
  description?: string;
  stages: StageSummary[];
  roles: PipelineSummaryRole[];
}

const PERSONA_MAX = 80;

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "...";
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.length > 0) return t;
  }
  return "";
}

interface RoleGateInfo {
  strength: GateStrength;
  check: string; // human-readable: "approved = true (strong)" or "no gate"
}

const WEAK_BOOLEAN_FIELD = /(^|_)(completed?|done|finished|ready|written)$/i;

function renderOneCheck(check: GateCheckClause): { strength: GateStrength; check: string } {
  const field = typeof check.field === "string" ? check.field : "?";
  let strength: GateStrength = "strong";
  let renderedCheck: string;
  if ("equals" in check) {
    renderedCheck = `${field} = ${JSON.stringify(check.equals)}`;
    if (check.equals === true && WEAK_BOOLEAN_FIELD.test(field)) strength = "weak";
  } else if ("gt" in check) {
    renderedCheck = `${field} > ${check.gt}`;
  } else if ("gte" in check) {
    renderedCheck = `${field} >= ${check.gte}`;
  } else if ("lt" in check) {
    renderedCheck = `${field} < ${check.lt}`;
  } else if ("lte" in check) {
    renderedCheck = `${field} <= ${check.lte}`;
  } else if ("in" in check) {
    renderedCheck = `${field} in ${JSON.stringify(check.in)}`;
  } else {
    renderedCheck = `${field} (no comparator)`;
    strength = "weak";
  }
  return { strength, check: renderedCheck };
}

function renderCheck(check: unknown): RoleGateInfo {
  const checks = Array.isArray(check) ? check : [check];
  if (checks.length === 0) return { strength: "weak", check: "empty check" };
  const rendered = checks.map((c) => renderOneCheck(c as GateCheckClause));
  return {
    strength: rendered.some((r) => r.strength === "strong") ? "strong" : "weak",
    check: rendered.map((r) => r.check).join(" AND "),
  };
}

function loadRoleGateInfo(generatedDir: string, roleName: string): RoleGateInfo {
  const gatePath = path.join(generatedDir, "roles", roleName, "gate.yaml");
  if (!fs.existsSync(gatePath)) return { strength: "none", check: "no gate" };
  let parsed: any;
  try {
    parsed = parseYaml(fs.readFileSync(gatePath, "utf-8"));
  } catch {
    return { strength: "none", check: "gate.yaml unparseable" };
  }
  const ev = parsed?.evidence;
  if (!ev || typeof ev !== "object") return { strength: "none", check: "no evidence" };
  const check = ev.check;
  if (!check || typeof check !== "object") {
    return { strength: "weak", check: "file-existence only" };
  }
  return renderCheck(check);
}

function summarizeStages(generatedDir: string, raw: any[]): { stages: StageSummary[]; roleNames: Set<string> } {
  const out: StageSummary[] = [];
  const roleNames = new Set<string>();
  for (const entry of raw ?? []) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.repeat && typeof entry.repeat === "object") {
      const r = entry.repeat;
      const inner = summarizeStages(generatedDir, Array.isArray(r.stages) ? r.stages : []);
      for (const n of inner.roleNames) roleNames.add(n);
      out.push({
        kind: "repeat",
        repeatName: typeof r.name === "string" ? r.name : undefined,
        maxIterations: typeof r.max_iterations === "number" ? r.max_iterations : undefined,
        until: typeof r.until === "string" ? r.until : undefined,
        innerStages: inner.stages,
      });
      continue;
    }
    if (typeof entry.name !== "string") continue;
    const roles = Array.isArray(entry.roles)
      ? entry.roles.filter((x: unknown) => typeof x === "string")
      : [];
    for (const r of roles) roleNames.add(r);
    // Gate strength = strongest among the stage's roles.
    let strength: GateStrength = "none";
    let renderedCheck: string | undefined;
    for (const r of roles) {
      const info = loadRoleGateInfo(generatedDir, r);
      if (info.strength === "strong" || (info.strength === "weak" && strength === "none")) {
        strength = info.strength;
        renderedCheck = info.check;
      }
    }
    out.push({
      kind: "stage",
      name: entry.name,
      roles,
      gateStrength: strength,
      gateCheck: renderedCheck,
    });
  }
  return { stages: out, roleNames };
}

export function buildPipelineSummary(generatedDir: string): PipelineSummary | null {
  const pipelinePath = path.join(generatedDir, "pipeline.yaml");
  if (!fs.existsSync(pipelinePath)) return null;

  let pipeline: any;
  try {
    pipeline = parseYaml(fs.readFileSync(pipelinePath, "utf-8"));
  } catch {
    return null;
  }
  if (!pipeline || typeof pipeline !== "object") return null;

  const { stages, roleNames } = summarizeStages(generatedDir, pipeline.stages ?? []);

  const roles: PipelineSummaryRole[] = [];
  for (const name of roleNames) {
    const roleDir = path.join(generatedDir, "roles", name);
    let playbooks: string[] = [];
    let personaPath = path.join(roleDir, "soul.md");
    try {
      const roleYaml = parseYaml(fs.readFileSync(path.join(roleDir, "role.yaml"), "utf-8")) as any;
      const playbookRefs = roleYaml?.playbooks;
      if (Array.isArray(playbookRefs)) {
        playbooks = playbookRefs.filter((s: unknown) => typeof s === "string");
      }
      if (typeof roleYaml?.persona === "string") {
        personaPath = path.join(roleDir, roleYaml.persona);
      }
    } catch { /* role.yaml missing or malformed */ }

    let personaFirstLine = "";
    try {
      personaFirstLine = truncate(firstNonEmptyLine(fs.readFileSync(personaPath, "utf-8")), PERSONA_MAX);
    } catch { /* soul.md missing */ }

    roles.push({ name, personaFirstLine, playbooks });
  }

  return {
    name: typeof pipeline.name === "string" ? pipeline.name : "(unnamed)",
    goal: typeof pipeline.goal === "string" ? pipeline.goal : undefined,
    description: typeof pipeline.description === "string" ? pipeline.description : undefined,
    stages,
    roles,
  };
}
