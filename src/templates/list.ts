import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveTemplatesDir } from "./paths.js";

export interface PresetTemplateInfo {
  id: string;
  name: string;
  description: string;
  stages: string[];
  roles: string[];
}

/**
 * List preset pipeline templates shipped with Petri (read-only assets).
 */
export function listPresetTemplates(): PresetTemplateInfo[] {
  const templatesDir = resolveTemplatesDir();
  if (!templatesDir) return [];

  const templates: PresetTemplateInfo[] = [];
  for (const entry of readdirSync(templatesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // Skip non-template modules living under templates/ (e.g. list.ts compiled)
    const pipelinePath = join(templatesDir, entry.name, "pipeline.yaml");
    if (!existsSync(pipelinePath)) continue;

    try {
      const content = readFileSync(pipelinePath, "utf-8");
      type RawStage = { name?: string; roles?: string[] };
      type RawEntry = RawStage & { repeat?: { stages?: RawStage[] } };
      const parsed = parseYaml(content) as {
        name?: string;
        description?: string;
        stages?: RawEntry[];
      };

      const stageNames: string[] = [];
      const rolesSet = new Set<string>();
      if (Array.isArray(parsed.stages)) {
        for (const stage of parsed.stages) {
          if (stage.repeat && Array.isArray(stage.repeat.stages)) {
            for (const nestedStage of stage.repeat.stages) {
              if (nestedStage.name) stageNames.push(nestedStage.name);
              if (Array.isArray(nestedStage.roles)) {
                for (const role of nestedStage.roles) rolesSet.add(role);
              }
            }
          }
          if (!stage.repeat && stage.name) {
            stageNames.push(stage.name);
            if (Array.isArray(stage.roles)) {
              for (const role of stage.roles) rolesSet.add(role);
            }
          }
        }
      }

      templates.push({
        id: entry.name,
        name: parsed.name ?? entry.name,
        description: parsed.description ?? "",
        stages: stageNames,
        roles: Array.from(rolesSet),
      });
    } catch {
      /* skip malformed templates */
    }
  }

  return templates;
}
