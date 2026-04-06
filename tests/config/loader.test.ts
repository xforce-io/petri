import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadPetriConfig, loadPipelineConfig, loadRole, loadBuiltinSkill } from "../../src/config/loader.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "petri-test-"));
}

function writeFile(dir: string, relPath: string, content: string) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf-8");
}

describe("loadPetriConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads petri.yaml with providers and models", () => {
    writeFile(
      tmpDir,
      "petri.yaml",
      `
providers:
  pi:
    type: pi
models:
  sonnet:
    provider: pi
    model: claude-sonnet-4-20250514
defaults:
  model: sonnet
  gate_strategy: all
  max_retries: 2
`
    );

    const config = loadPetriConfig(tmpDir);
    expect(config.providers).toEqual({ pi: { type: "pi" } });
    expect(config.models).toEqual({
      sonnet: { provider: "pi", model: "claude-sonnet-4-20250514" },
    });
    expect(config.defaults).toEqual({
      model: "sonnet",
      gate_strategy: "all",
      max_retries: 2,
    });
  });

  it("throws when petri.yaml is missing", () => {
    expect(() => loadPetriConfig(tmpDir)).toThrow();
  });
});

describe("loadPipelineConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads pipeline.yaml with stages", () => {
    writeFile(
      tmpDir,
      "pipeline.yaml",
      `
name: build
stages:
  - name: design
    roles: [architect]
  - name: implement
    roles: [coder]
    max_retries: 3
`
    );

    const pipeline = loadPipelineConfig(tmpDir);
    expect(pipeline.name).toBe("build");
    expect(pipeline.stages).toHaveLength(2);
    expect(pipeline.stages[0]).toEqual({ name: "design", roles: ["architect"] });
    expect(pipeline.stages[1]).toEqual({
      name: "implement",
      roles: ["coder"],
      max_retries: 3,
    });
  });

  it("loads pipeline with repeat blocks", () => {
    writeFile(
      tmpDir,
      "pipeline.yaml",
      `
name: iterative
stages:
  - repeat:
      name: refine-loop
      max_iterations: 5
      until:
        artifact: review.json
        field: approved
        equals: true
      stages:
        - name: code
          roles: [coder]
        - name: review
          roles: [reviewer]
`
    );

    const pipeline = loadPipelineConfig(tmpDir);
    expect(pipeline.stages).toHaveLength(1);
    const block = pipeline.stages[0] as any;
    expect(block.repeat).toBeDefined();
    expect(block.repeat.name).toBe("refine-loop");
    expect(block.repeat.max_iterations).toBe(5);
    expect(block.repeat.stages).toHaveLength(2);
  });

  it("loads a named pipeline file", () => {
    writeFile(
      tmpDir,
      "custom.yaml",
      `
name: custom-pipeline
stages:
  - name: step1
    roles: [worker]
`
    );

    const pipeline = loadPipelineConfig(tmpDir, "custom.yaml");
    expect(pipeline.name).toBe("custom-pipeline");
  });
});

describe("loadRole", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads role with persona, skills, and gate", () => {
    writeFile(
      tmpDir,
      "roles/coder/role.yaml",
      `
persona: coder
model: sonnet
skills:
  - petri:file_operations
`
    );
    writeFile(tmpDir, "roles/coder/soul.md", "You are a careful coder.");
    writeFile(
      tmpDir,
      "roles/coder/gate.yaml",
      `
requires:
  tests_pass: true
evidence:
  type: artifact
  path: test-results.json
  check:
    field: pass
    equals: true
`
    );

    const role = loadRole(tmpDir, "coder", "default-model");
    expect(role.name).toBe("coder");
    expect(role.persona).toContain("You are a careful coder.");
    expect(role.model).toBe("sonnet");
    expect(role.skills).toHaveLength(1);
    expect(role.gate).not.toBeNull();
    expect(role.gate!.id).toBe("tests_pass");
    expect(role.gate!.evidence.path).toBe("test-results.json");
  });

  it("uses default model when role has none", () => {
    writeFile(
      tmpDir,
      "roles/writer/role.yaml",
      `
persona: writer
skills: []
`
    );
    writeFile(tmpDir, "roles/writer/soul.md", "You write docs.");

    const role = loadRole(tmpDir, "writer", "fallback-model");
    expect(role.model).toBe("fallback-model");
  });

  it("loads local skill files from skills/ directory", () => {
    writeFile(
      tmpDir,
      "roles/dev/role.yaml",
      `
persona: dev
skills:
  - local_tool
`
    );
    writeFile(tmpDir, "roles/dev/soul.md", "A developer.");
    writeFile(tmpDir, "roles/dev/skills/local_tool.md", "Use this local tool.");

    const role = loadRole(tmpDir, "dev", "m");
    expect(role.skills).toHaveLength(1);
    expect(role.skills[0]).toContain("Use this local tool.");
  });
});

describe("loadBuiltinSkill", () => {
  it("loads built-in skill by petri: prefix", () => {
    const content = loadBuiltinSkill("file_operations");
    expect(content).toBeTruthy();
    expect(typeof content).toBe("string");
    expect(content.length).toBeGreaterThan(0);
  });

  it("loads shell_tools built-in skill", () => {
    const content = loadBuiltinSkill("shell_tools");
    expect(content).toBeTruthy();
  });

  it("throws on unknown built-in skill", () => {
    expect(() => loadBuiltinSkill("nonexistent_skill")).toThrow();
  });
});
