import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { promoteGenerated } from "../../src/engine/promote.js";

describe("promoteGenerated", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "petri-promote-"));
    // Create .petri/generated/ with test files
    const genDir = path.join(tmpDir, ".petri", "generated");
    fs.mkdirSync(path.join(genDir, "roles", "worker"), { recursive: true });
    fs.writeFileSync(path.join(genDir, "pipeline.yaml"), "name: test");
    fs.writeFileSync(path.join(genDir, "manifest.json"), "{}");
    fs.writeFileSync(path.join(genDir, "roles", "worker", "role.yaml"), "persona: soul.md");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("copies files from .petri/generated/ to project root", () => {
    const files = promoteGenerated(tmpDir);
    expect(files).toContain("pipeline.yaml");
    expect(files).toContain("roles/worker/role.yaml");
    expect(fs.readFileSync(path.join(tmpDir, "pipeline.yaml"), "utf-8")).toBe("name: test");
    expect(fs.readFileSync(path.join(tmpDir, "roles", "worker", "role.yaml"), "utf-8")).toBe("persona: soul.md");
    expect(files).not.toContain("manifest.json");
    expect(fs.existsSync(path.join(tmpDir, "manifest.json"))).toBe(false);
  });

  it("returns empty array when no generated files exist", () => {
    fs.rmSync(path.join(tmpDir, ".petri", "generated"), { recursive: true });
    const files = promoteGenerated(tmpDir);
    expect(files).toEqual([]);
  });
});
