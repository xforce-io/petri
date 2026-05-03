import { describe, it, expect } from "vitest";
import { buildGenerationPrompt, parseGeneratedFiles } from "../../src/engine/generator.js";

describe("buildGenerationPrompt", () => {
  it("includes user description and example structure", () => {
    const prompt = buildGenerationPrompt("Build a code review pipeline with designer, developer, and reviewer");
    expect(prompt).toContain("Build a code review pipeline");
    expect(prompt).toContain("pipeline.yaml");
    expect(prompt).toContain("role.yaml");
    expect(prompt).toContain("soul.md");
    expect(prompt).toContain("gate.yaml");
  });

  it("instructs the LLM to nest evidence.path and evidence.check (gate schema guard)", () => {
    const prompt = buildGenerationPrompt("any task");
    expect(prompt).toContain("evidence:");
    expect(prompt).toMatch(/nested under the .?evidence.? key/i);
  });

  it("instructs the LLM to match the user description's primary language", () => {
    const prompt = buildGenerationPrompt("any task");
    expect(prompt).toMatch(/same primary language/i);
  });

  it("includes the mandatory repeat-block rule and forbids completed=true exit gates", () => {
    const prompt = buildGenerationPrompt("Build something");
    expect(prompt).toMatch(/at least one `repeat:` block/i);
    expect(prompt).toMatch(/must NOT.*completed.*true/i);
  });
});

describe("parseGeneratedFiles", () => {
  it("parses JSON file map from LLM output", () => {
    const output = JSON.stringify({
      "pipeline.yaml": "name: test\nstages: []",
      "roles/worker/role.yaml": "persona: soul.md\nskills: []",
    });
    const files = parseGeneratedFiles(output);
    expect(files.size).toBe(2);
    expect(files.get("pipeline.yaml")).toContain("name: test");
    expect(files.get("roles/worker/role.yaml")).toContain("persona: soul.md");
  });

  it("extracts JSON from markdown code block", () => {
    const output = "Here is the pipeline:\n```json\n{\"pipeline.yaml\": \"name: test\"}\n```\n";
    const files = parseGeneratedFiles(output);
    expect(files.size).toBe(1);
    expect(files.get("pipeline.yaml")).toBe("name: test");
  });

  it("throws on invalid output", () => {
    expect(() => parseGeneratedFiles("not json at all")).toThrow();
  });

  it("rejects absolute paths", () => {
    const output = JSON.stringify({
      "/etc/passwd": "root:x:0:0",
    });
    expect(() => parseGeneratedFiles(output)).toThrow("Invalid file path");
  });

  it("rejects path traversal with ..", () => {
    const output = JSON.stringify({
      "../outside/secret.txt": "contents",
    });
    expect(() => parseGeneratedFiles(output)).toThrow("Invalid file path");
  });

  it("rejects empty file maps", () => {
    const output = JSON.stringify({});
    expect(() => parseGeneratedFiles(output)).toThrow("empty file map");
  });

  it("rejects non-string content values", () => {
    const output = JSON.stringify({
      "pipeline.yaml": 42,
    });
    expect(() => parseGeneratedFiles(output)).toThrow('content must be a string');
  });
});
