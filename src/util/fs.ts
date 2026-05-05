import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Recursively list all files under `dir`, returning relative paths.
 */
export function listFilesRecursive(dir: string, prefix = ""): string[] {
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

/** Internal files that should not be exposed or promoted from .petri/generated/ */
const GENERATED_INTERNAL_PATTERNS = ["_llm_work", "petri.yaml", "manifest.json"];

/**
 * Filter out internal/staging files from a generated file list.
 * Removes files under _llm_work/ and the copied petri.yaml.
 */
export function filterGeneratedFiles(files: string[]): string[] {
  return files.filter((f) => {
    for (const pattern of GENERATED_INTERNAL_PATTERNS) {
      if (f === pattern || f.startsWith(pattern + "/")) return false;
    }
    return true;
  });
}
