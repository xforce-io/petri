import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Copy files from .petri/generated/ to the project root directory.
 * Returns list of relative file paths that were promoted.
 */
export function promoteGenerated(projectDir: string): string[] {
  const generatedDir = path.join(projectDir, ".petri", "generated");
  if (!fs.existsSync(generatedDir)) return [];

  const files = listFilesRecursive(generatedDir);
  for (const relPath of files) {
    const src = path.join(generatedDir, relPath);
    const dest = path.join(projectDir, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }

  return files;
}

function listFilesRecursive(dir: string, prefix = ""): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(path.join(dir, entry.name), rel));
    } else {
      results.push(rel);
    }
  }
  return results;
}
