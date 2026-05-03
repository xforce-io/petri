import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

export interface PipelineSummaryRole {
  name: string;
  personaFirstLine: string;
  skills: string[];
}

export interface PipelineSummaryStage {
  name: string;
  roles: string[];
}

export interface PipelineSummary {
  name: string;
  goal?: string;
  description?: string;
  stages: PipelineSummaryStage[];
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

  const stages: PipelineSummaryStage[] = [];
  const roleNames = new Set<string>();

  // Extract stages from pipeline.stages (handles both linear stages and repeat blocks)
  function extractStages(stagesArray: any[]) {
    for (const stage of stagesArray ?? []) {
      if (!stage || typeof stage !== "object") continue;

      // Handle repeat blocks: extract nested stages
      if (stage.repeat && Array.isArray(stage.repeat.stages)) {
        for (const nestedStage of stage.repeat.stages) {
          if (!nestedStage || typeof nestedStage !== "object" || !nestedStage.name) continue;
          const roles = Array.isArray(nestedStage.roles) ? nestedStage.roles.filter((r: unknown) => typeof r === "string") : [];
          stages.push({ name: nestedStage.name, roles });
          for (const r of roles) roleNames.add(r);
        }
      }

      // Handle regular stages
      if (!stage.repeat && stage.name) {
        const roles = Array.isArray(stage.roles) ? stage.roles.filter((r: unknown) => typeof r === "string") : [];
        stages.push({ name: stage.name, roles });
        for (const r of roles) roleNames.add(r);
      }
    }
  }

  extractStages(pipeline.stages ?? []);

  const roles: PipelineSummaryRole[] = [];
  for (const name of roleNames) {
    const roleDir = path.join(generatedDir, "roles", name);
    let skills: string[] = [];
    let personaPath = path.join(roleDir, "soul.md");
    try {
      const roleYaml = parseYaml(fs.readFileSync(path.join(roleDir, "role.yaml"), "utf-8")) as any;
      if (Array.isArray(roleYaml?.skills)) {
        skills = roleYaml.skills.filter((s: unknown) => typeof s === "string");
      }
      if (typeof roleYaml?.persona === "string") {
        personaPath = path.join(roleDir, roleYaml.persona);
      }
    } catch { /* role.yaml missing or malformed: leave defaults */ }

    let personaFirstLine = "";
    try {
      personaFirstLine = truncate(firstNonEmptyLine(fs.readFileSync(personaPath, "utf-8")), PERSONA_MAX);
    } catch { /* soul.md missing */ }

    roles.push({ name, personaFirstLine, skills });
  }

  return {
    name: typeof pipeline.name === "string" ? pipeline.name : "(unnamed)",
    goal: typeof pipeline.goal === "string" ? pipeline.goal : undefined,
    description: typeof pipeline.description === "string" ? pipeline.description : undefined,
    stages,
    roles,
  };
}
