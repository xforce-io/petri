import * as fs from "node:fs";
import * as path from "node:path";
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

  formatForContext(): string {
    if (this.artifacts.length === 0) {
      return "No artifacts.";
    }
    const lines = this.artifacts.map(
      (a) => `- [${a.stage}/${a.role}] ${a.path}`
    );
    return ["Artifacts:", ...lines].join("\n");
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
