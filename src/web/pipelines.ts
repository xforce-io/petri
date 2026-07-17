import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface PipelineStageMeta {
  name: string;
  roles: string[];
}

export interface ProjectPipelineInfo {
  /** Relative path under project dir (value for POST /api/runs) */
  file: string;
  /** YAML top-level name, or file stem fallback */
  name: string;
  description: string;
  stages: PipelineStageMeta[];
}

function extractStages(rawStages: unknown): PipelineStageMeta[] {
  if (!Array.isArray(rawStages)) return [];
  const out: PipelineStageMeta[] = [];
  for (const entry of rawStages) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as {
      name?: string;
      roles?: unknown;
      repeat?: { name?: string; stages?: unknown };
    };
    if (e.repeat && Array.isArray(e.repeat.stages)) {
      // Surface nested stages; optional synthetic label via repeat.name is not a stage file
      for (const nested of e.repeat.stages) {
        if (!nested || typeof nested !== "object") continue;
        const n = nested as { name?: string; roles?: unknown };
        if (typeof n.name === "string" && n.name) {
          out.push({
            name: n.name,
            roles: Array.isArray(n.roles)
              ? n.roles.filter((r): r is string => typeof r === "string")
              : [],
          });
        }
      }
      continue;
    }
    if (typeof e.name === "string" && e.name && !e.repeat) {
      out.push({
        name: e.name,
        roles: Array.isArray(e.roles)
          ? e.roles.filter((r): r is string => typeof r === "string")
          : [],
      });
    }
  }
  return out;
}

/**
 * List pipeline YAML files in a project with logical names and stage/role structure.
 * Pure FS helper — shared by Run selector and Config navigation.
 */
export function listProjectPipelines(projectDir: string): ProjectPipelineInfo[] {
  if (!existsSync(projectDir)) return [];

  const files: string[] = [];
  try {
    for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (/^pipeline.*\.ya?ml$/i.test(entry.name)) {
        files.push(entry.name);
      }
    }
  } catch {
    return [];
  }

  files.sort();
  const result: ProjectPipelineInfo[] = [];

  for (const file of files) {
    const abs = join(projectDir, file);
    let name = file.replace(/\.ya?ml$/i, "");
    let description = "";
    let stages: PipelineStageMeta[] = [];
    try {
      const content = readFileSync(abs, "utf-8");
      const parsed = parseYaml(content) as {
        name?: string;
        description?: string;
        stages?: unknown;
      };
      if (typeof parsed?.name === "string" && parsed.name.trim()) {
        name = parsed.name.trim();
      }
      if (typeof parsed?.description === "string") {
        description = parsed.description;
      }
      stages = extractStages(parsed?.stages);
    } catch {
      // keep fallback name = stem
    }
    result.push({ file, name, description, stages });
  }

  return result;
}

/** Display label for UI: logical name, with file disambiguation when needed. */
export function pipelineDisplayLabel(
  p: ProjectPipelineInfo,
  all: ProjectPipelineInfo[],
): string {
  const sameName = all.filter((x) => x.name === p.name).length > 1;
  if (sameName && p.name !== p.file) {
    return `${p.name} (${p.file})`;
  }
  return p.name;
}
