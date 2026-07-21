import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { listFilesRecursive } from "../util/fs.js";
import type { ArtifactEntry } from "../types.js";

export class ArtifactManifest {
  private readonly baseDir: string;
  private artifacts: ArtifactEntry[] = [];

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  collect(stage: string, role: string, filePaths: string[]): void {
    for (const filePath of filePaths) {
      const relPath = path.relative(this.baseDir, filePath);
      if (this.artifacts.some((a) => a.path === relPath)) {
        continue;
      }
      this.artifacts.push({ stage, role, path: relPath });
    }
  }

  entries(): ArtifactEntry[] {
    return [...this.artifacts];
  }

  /**
   * Update a collected path after Engine archives a failed attempt. Keeping the
   * manifest pointed at the moved file lets subsequent repeat iterations read
   * the actual prior evidence instead of a stale, missing path.
   */
  relocate(fromAbsolutePath: string, toAbsolutePath: string): void {
    const from = path.relative(this.baseDir, fromAbsolutePath);
    const to = path.relative(this.baseDir, toAbsolutePath);
    if (from.startsWith("..") || to.startsWith("..") || path.isAbsolute(from) || path.isAbsolute(to)) {
      throw new Error("Artifact relocation must stay within the artifact base directory");
    }
    for (const artifact of this.artifacts) {
      if (artifact.path === from) artifact.path = to;
    }
  }

  /** Return the most recently collected artifact matching the stage/role/file. */
  latestPath(stage: string, role: string, fileName: string): string | undefined {
    for (let index = this.artifacts.length - 1; index >= 0; index--) {
      const artifact = this.artifacts[index];
      if (artifact.stage === stage && artifact.role === role && path.basename(artifact.path) === fileName) {
        return path.join(this.baseDir, artifact.path);
      }
    }
    return undefined;
  }

  formatForContext(): string {
    if (this.artifacts.length === 0) {
      return "No artifacts.";
    }
    const lines = this.artifacts.map(
      (a) => `- [${a.stage}/${a.role}] ${path.resolve(this.baseDir, a.path)} (relative: ${a.path})`
    );
    return ["Artifacts (read the absolute paths below):", ...lines].join("\n");
  }

  save(): void {
    const filePath = path.join(this.baseDir, "manifest.json");
    fs.mkdirSync(this.baseDir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(this.artifacts, null, 2), "utf-8");
  }

  static load(baseDir: string): ArtifactManifest {
    const manifest = new ArtifactManifest(baseDir);
    const filePath = path.join(baseDir, "manifest.json");
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as ArtifactEntry[];
      manifest.artifacts = data;
    }
    return manifest;
  }
}

export interface GeneratedManifest {
  goal_path: string;
  goal_hash: string;
  pipeline_hash: string;
  roles_hash: string;
  created_at: string;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function hashFile(absPath: string, relPath: string): string {
  const content = fs.readFileSync(absPath, "utf-8");
  return sha256(`${relPath}\n${content}`);
}

function hashFiles(baseDir: string, relPaths: string[]): string {
  const h = createHash("sha256");
  for (const relPath of relPaths.sort()) {
    h.update(relPath);
    h.update("\n");
    h.update(fs.readFileSync(path.join(baseDir, relPath)));
    h.update("\n");
  }
  return h.digest("hex");
}

export function buildGeneratedManifest(generatedDir: string, goalText: string): GeneratedManifest {
  const pipelineRel = "pipeline.yaml";
  const rolesRel = listFilesRecursive(path.join(generatedDir, "roles"))
    .map((rel) => path.join("roles", rel))
    .filter((rel) => rel.endsWith(".yaml") || rel.endsWith(".md"));

  return {
    goal_path: ".petri/goal.md",
    goal_hash: sha256(goalText),
    pipeline_hash: fs.existsSync(path.join(generatedDir, pipelineRel))
      ? hashFile(path.join(generatedDir, pipelineRel), pipelineRel)
      : "",
    roles_hash: hashFiles(generatedDir, rolesRel),
    created_at: new Date().toISOString(),
  };
}

export function saveGeneratedManifest(generatedDir: string, manifest: GeneratedManifest): void {
  fs.writeFileSync(
    path.join(generatedDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );
}

export function loadGeneratedManifest(generatedDir: string): GeneratedManifest | null {
  const manifestPath = path.join(generatedDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as GeneratedManifest;
}

export function currentGeneratedHashes(generatedDir: string): Pick<GeneratedManifest, "pipeline_hash" | "roles_hash"> {
  const manifest = buildGeneratedManifest(generatedDir, "");
  return {
    pipeline_hash: manifest.pipeline_hash,
    roles_hash: manifest.roles_hash,
  };
}
