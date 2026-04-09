import * as fs from "node:fs";
import * as path from "node:path";
import { listFilesRecursive } from "../util/fs.js";

/**
 * Copy files from .petri/generated/ to the project root directory.
 * Returns list of relative file paths that were promoted.
 */
export function promoteGenerated(projectDir: string): string[] {
  const generatedDir = path.join(projectDir, ".petri", "generated");
  if (!fs.existsSync(generatedDir)) return [];

  const files = listFilesRecursive(generatedDir)
    .filter((f) => !f.startsWith("_") && f !== "petri.yaml");
  for (const relPath of files) {
    const src = path.join(generatedDir, relPath);
    const dest = path.join(projectDir, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }

  return files;
}
