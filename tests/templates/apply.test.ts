import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  applyTemplate,
  formatSkippedTemplateFiles,
  isValidProjectName,
  resolveProjectPath,
  TemplateError,
} from "../../src/templates/apply.js";
import { createHash } from "node:crypto";
import { listPresetTemplates } from "../../src/templates/list.js";
import { loadRole } from "../../src/config/loader.js";

describe("listPresetTemplates", () => {
  it("includes code-dev preset with stages and roles", () => {
    const templates = listPresetTemplates();
    const codeDev = templates.find((t) => t.id === "code-dev");
    expect(codeDev).toBeDefined();
    expect(codeDev!.stages.length).toBeGreaterThan(0);
    expect(codeDev!.roles).toContain("developer");
    expect(codeDev!.roles).toContain("issue_analyst");
  });
});

describe("isValidProjectName", () => {
  it("accepts alphanumeric names with dash/underscore", () => {
    expect(isValidProjectName("my-app")).toBe(true);
    expect(isValidProjectName("App_1")).toBe(true);
  });

  it("rejects path-like or empty names", () => {
    expect(isValidProjectName("")).toBe(false);
    expect(isValidProjectName("../x")).toBe(false);
    expect(isValidProjectName("a/b")).toBe(false);
    expect(isValidProjectName("-bad")).toBe(false);
  });
});

describe("applyTemplate", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "petri-tpl-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("copies code-dev preset into target with petri.yaml pipeline and roles", () => {
    const target = path.join(tmp, "demo");
    applyTemplate("code-dev", target);

    expect(fs.existsSync(path.join(target, "petri.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(target, "pipeline.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(target, "roles", "developer", "role.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(target, "roles", "designer", "soul.md"))).toBe(true);
    expect(fs.existsSync(path.join(target, "roles", "issue_analyst", "role.yaml"))).toBe(true);
    const petriYaml = fs.readFileSync(path.join(target, "petri.yaml"), "utf-8");
    expect(petriYaml).toMatch(/type:\s*grok/);
    expect(petriYaml).toMatch(/type:\s*codex/);
    expect(petriYaml).toMatch(/reasoning_effort:\s*high/);
    expect(petriYaml).toMatch(/gpt-5\.6-terra/);
    const reviewerRole = fs.readFileSync(
      path.join(target, "roles", "code_reviewer", "role.yaml"),
      "utf-8",
    );
    expect(reviewerRole).toMatch(/provider:\s*review/);
    expect(reviewerRole).toMatch(/model:\s*terra/);
    const pipeline = fs.readFileSync(path.join(target, "pipeline.yaml"), "utf-8");
    expect(pipeline).toMatch(/unit_test/);
    expect(pipeline).not.toMatch(/develop\/developer/);
    expect(fs.readFileSync(path.join(target, "README.md"), "utf-8")).toMatch(/适用范围/);
    expect(fs.readFileSync(path.join(target, "roles", "code_reviewer", "gate.yaml"), "utf-8"))
      .toMatch(/type:\s*review/);
    expect(loadRole(target, "code_reviewer", "default").gate?.contract).toEqual({ type: "review" });
  });

  it("throws NOT_FOUND for unknown template", () => {
    expect(() => applyTemplate("no-such-template", path.join(tmp, "x"))).toThrow(TemplateError);
    try {
      applyTemplate("no-such-template", path.join(tmp, "x"));
    } catch (e) {
      expect((e as TemplateError).code).toBe("NOT_FOUND");
    }
  });

  it("throws EXISTS when petri.yaml already present", () => {
    const target = path.join(tmp, "exists");
    applyTemplate("code-dev", target);
    expect(() => applyTemplate("code-dev", target)).toThrow(TemplateError);
  });

  it("issue #77: does not overwrite existing custom README.md", () => {
    const target = path.join(tmp, "biz");
    fs.mkdirSync(target, { recursive: true });
    const custom = "# Business Project\n\nDo not clobber me.\n";
    const readmePath = path.join(target, "README.md");
    fs.writeFileSync(readmePath, custom);
    const beforeHash = createHash("sha256").update(fs.readFileSync(readmePath)).digest("hex");

    const result = applyTemplate("code-dev", target);
    const afterHash = createHash("sha256").update(fs.readFileSync(readmePath)).digest("hex");
    expect(afterHash).toBe(beforeHash);
    expect(fs.readFileSync(readmePath, "utf-8")).toBe(custom);
    expect(result.skipped.some((p) => p.endsWith("README.md"))).toBe(true);
    expect(fs.existsSync(path.join(target, "petri.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(target, "pipeline.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(target, "roles", "developer", "role.yaml"))).toBe(true);
  });

  it("issue #77: fills missing scaffold when no README conflict", () => {
    const target = path.join(tmp, "empty-ish");
    fs.mkdirSync(target, { recursive: true });
    const result = applyTemplate("code-dev", target);
    expect(result.created.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(target, "petri.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(target, "pipeline.yaml"))).toBe(true);
  });

  it("issue #77: skips existing pipeline.yaml with path-bearing message", () => {
    const target = path.join(tmp, "partial");
    fs.mkdirSync(target, { recursive: true });
    const customPipe = "name: custom\nstages: []\n";
    fs.writeFileSync(path.join(target, "pipeline.yaml"), customPipe);

    const result = applyTemplate("code-dev", target);
    expect(fs.readFileSync(path.join(target, "pipeline.yaml"), "utf-8")).toBe(customPipe);
    expect(result.skipped.some((p) => p.endsWith("pipeline.yaml"))).toBe(true);
    const msgs = formatSkippedTemplateFiles(result.skipped);
    expect(msgs.some((m) => m.includes("pipeline.yaml") && m.includes("not overwritten"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(target, "petri.yaml"))).toBe(true);
  });
});

describe("resolveProjectPath", () => {
  it("resolves under workspace and rejects escape", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "petri-ws-"));
    try {
      const p = resolveProjectPath(root, "ok-name");
      expect(p.startsWith(root)).toBe(true);
      expect(() => resolveProjectPath(root, "../escape")).toThrow(TemplateError);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
