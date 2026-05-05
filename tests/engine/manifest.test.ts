import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  ArtifactManifest,
  buildGeneratedManifest,
  currentGeneratedHashes,
  loadGeneratedManifest,
  saveGeneratedManifest,
  sha256,
} from "../../src/engine/manifest.js";
import type { ArtifactEntry } from "../../src/types.js";

describe("ArtifactManifest", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "petri-manifest-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts empty", () => {
    const manifest = new ArtifactManifest(tmpDir);
    expect(manifest.entries()).toEqual([]);
  });

  it("collects artifacts with relative paths", () => {
    const manifest = new ArtifactManifest(tmpDir);
    const absPath = path.join(tmpDir, "design", "spec.md");
    manifest.collect("design", "architect", [absPath]);

    const entries = manifest.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      stage: "design",
      role: "architect",
      path: "design/spec.md",
    });
  });

  it("deduplicates artifacts by path", () => {
    const manifest = new ArtifactManifest(tmpDir);
    const absPath = path.join(tmpDir, "design", "spec.md");

    manifest.collect("design", "architect", [absPath]);
    manifest.collect("design", "architect", [absPath]);

    expect(manifest.entries()).toHaveLength(1);
  });

  it("returns a copy from entries()", () => {
    const manifest = new ArtifactManifest(tmpDir);
    const absPath = path.join(tmpDir, "code", "main.ts");
    manifest.collect("impl", "developer", [absPath]);

    const a = manifest.entries();
    const b = manifest.entries();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it("formats for context", () => {
    const manifest = new ArtifactManifest(tmpDir);
    manifest.collect("design", "architect", [
      path.join(tmpDir, "design", "spec.md"),
    ]);
    manifest.collect("impl", "developer", [
      path.join(tmpDir, "impl", "main.ts"),
    ]);

    const text = manifest.formatForContext();
    expect(text).toContain("design/spec.md");
    expect(text).toContain("impl/main.ts");
    expect(text).toContain("design");
    expect(text).toContain("impl");
  });

  it("saves and loads manifest.json", async () => {
    const manifest = new ArtifactManifest(tmpDir);
    manifest.collect("design", "architect", [
      path.join(tmpDir, "design", "spec.md"),
    ]);
    manifest.collect("impl", "developer", [
      path.join(tmpDir, "impl", "main.ts"),
    ]);

    manifest.save();

    const manifestPath = path.join(tmpDir, "manifest.json");
    expect(fs.existsSync(manifestPath)).toBe(true);

    const loaded = ArtifactManifest.load(tmpDir);
    expect(loaded.entries()).toEqual(manifest.entries());
  });

  it("load returns empty manifest when no file exists", () => {
    const loaded = ArtifactManifest.load(tmpDir);
    expect(loaded.entries()).toEqual([]);
  });
});

describe("Generated pipeline manifest", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "petri-generated-manifest-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("hashes goal, pipeline, and role files", () => {
    fs.writeFileSync(path.join(tmpDir, "pipeline.yaml"), "name: test\n", "utf-8");
    fs.mkdirSync(path.join(tmpDir, "roles", "worker"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "roles", "worker", "role.yaml"), "persona: soul.md\n", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "roles", "worker", "soul.md"), "Worker.\n", "utf-8");

    const manifest = buildGeneratedManifest(tmpDir, "Do the thing");
    expect(manifest.goal_path).toBe(".petri/goal.md");
    expect(manifest.goal_hash).toBe(sha256("Do the thing"));
    expect(manifest.pipeline_hash).toHaveLength(64);
    expect(manifest.roles_hash).toHaveLength(64);
  });

  it("saves, loads, and recomputes current generated hashes", () => {
    fs.writeFileSync(path.join(tmpDir, "pipeline.yaml"), "name: test\n", "utf-8");
    fs.mkdirSync(path.join(tmpDir, "roles", "worker"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "roles", "worker", "role.yaml"), "persona: soul.md\n", "utf-8");

    const manifest = buildGeneratedManifest(tmpDir, "Goal");
    saveGeneratedManifest(tmpDir, manifest);

    expect(loadGeneratedManifest(tmpDir)).toEqual(manifest);
    expect(currentGeneratedHashes(tmpDir)).toEqual({
      pipeline_hash: manifest.pipeline_hash,
      roles_hash: manifest.roles_hash,
    });
  });
});
