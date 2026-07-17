import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the preset templates directory (bundled dist or src).
 */
export function resolveTemplatesDir(): string | null {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // This file is under src/templates/ (dev) or dist/ next to copied templates
    resolve(__dirname),
    resolve(__dirname, "..", "templates"),
    resolve(__dirname, "..", "..", "src", "templates"),
    resolve(__dirname, "..", "src", "templates"),
  ];

  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      if (
        entries.some(
          (e) => e.isDirectory() && existsSync(join(dir, e.name, "pipeline.yaml")),
        )
      ) {
        return dir;
      }
    } catch {
      /* try next */
    }
  }
  return candidates.find((d) => existsSync(d)) ?? null;
}
