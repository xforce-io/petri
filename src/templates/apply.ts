import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
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

export type ApplyTemplateResult = {
  /** Files newly written from the template. */
  created: string[];
  /** Existing paths skipped (never overwritten). Issue #77. */
  skipped: string[];
};

/**
 * Walk templateDir and list relative file paths (posix-style separators).
 */
export function listTemplateFiles(templateDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) out.push(relative(templateDir, full).split("\\").join("/"));
    }
  };
  walk(templateDir);
  return out.sort();
}

/**
 * Copy a preset template into `targetDir` without overwriting existing files (#77).
 * Still refuses when `petri.yaml` already exists (Petri project already initialized).
 * Shared by CLI `petri init` and Web `POST /api/projects`.
 */
export function applyTemplate(
  templateId: string,
  targetDir: string,
): ApplyTemplateResult {
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

  const created: string[] = [];
  const skipped: string[] = [];
  const files = listTemplateFiles(templateDir);

  for (const rel of files) {
    const src = join(templateDir, rel);
    const dest = join(absTarget, rel);
    if (existsSync(dest)) {
      skipped.push(dest);
      continue;
    }
    mkdirSync(join(dest, ".."), { recursive: true });
    copyFileSync(src, dest);
    created.push(dest);
  }

  // Empty project path: if nothing was created and nothing skipped, still ok
  // (should not happen for valid templates). If only skipped, scaffold may be incomplete
  // but we never overwrite.
  return { created, skipped };
}

/**
 * Format skip notices for operators (issue #77 S3).
 */
export function formatSkippedTemplateFiles(skipped: string[]): string[] {
  return skipped.map(
    (p) => `Skipped existing file (not overwritten): ${p}`,
  );
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
