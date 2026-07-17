import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function looksLikeTemplatesRoot(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries.some(
      (e) => e.isDirectory() && existsSync(join(dir, e.name, "pipeline.yaml")),
    );
  } catch {
    return false;
  }
}

/**
 * Resolve the preset templates directory (bundled dist or src).
 * When code is bundled into dist/index.js, prefer dist/templates (postbuild).
 */
export function resolveTemplatesDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Bundled: dist/templates (postbuild copies code-dev etc.)
    resolve(here, "templates"),
    // This module under src/templates/ (dev): here is already the templates root
    resolve(here),
    resolve(here, "..", "templates"),
    resolve(here, "..", "src", "templates"),
    resolve(here, "..", "..", "src", "templates"),
  ];

  for (const dir of candidates) {
    if (looksLikeTemplatesRoot(dir)) return dir;
  }
  return candidates.find((d) => existsSync(d)) ?? null;
}
