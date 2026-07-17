import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveTemplatesDir } from "./paths.js";

/** Project directory name under the workspace root. */
const PROJECT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function isValidProjectName(name: string): boolean {
  return typeof name === "string" && PROJECT_NAME_RE.test(name);
}

export class TemplateError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_FOUND" | "EXISTS" | "INVALID_NAME" | "PATH_ESCAPE" | "NO_TEMPLATES",
  ) {
    super(message);
    this.name = "TemplateError";
  }
}

/**
 * Copy a preset template into `targetDir` (must not already contain petri.yaml).
 * Shared by CLI `petri init` and Web `POST /api/projects`.
 */
export function applyTemplate(templateId: string, targetDir: string): void {
  const templatesDir = resolveTemplatesDir();
  if (!templatesDir) {
    throw new TemplateError("No templates directory found", "NO_TEMPLATES");
  }

  const templateDir = join(templatesDir, templateId);
  if (!existsSync(templateDir) || !existsSync(join(templateDir, "pipeline.yaml"))) {
    throw new TemplateError(`Template "${templateId}" not found`, "NOT_FOUND");
  }

  const absTarget = resolve(targetDir);
  const configPath = join(absTarget, "petri.yaml");
  if (existsSync(configPath)) {
    throw new TemplateError(`petri.yaml already exists in ${absTarget}`, "EXISTS");
  }

  mkdirSync(absTarget, { recursive: true });
  cpSync(templateDir, absTarget, { recursive: true });
}

/**
 * Resolve a project path under workspaceRoot and ensure it cannot escape.
 */
export function resolveProjectPath(workspaceRoot: string, name: string): string {
  if (!isValidProjectName(name)) {
    throw new TemplateError(
      `Invalid project name "${name}". Use letters, numbers, _ or - (max 64 chars).`,
      "INVALID_NAME",
    );
  }
  const root = resolve(workspaceRoot);
  const target = resolve(root, name);
  if (target !== root && !target.startsWith(root + "/") && !target.startsWith(root + "\\")) {
    throw new TemplateError("Project path escapes workspace root", "PATH_ESCAPE");
  }
  if (target === root) {
    throw new TemplateError("Project name resolves to workspace root", "INVALID_NAME");
  }
  return target;
}
