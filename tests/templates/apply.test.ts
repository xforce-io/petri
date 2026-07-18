import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  applyTemplate,
  isValidProjectName,
  resolveProjectPath,
  TemplateError,
} from "../../src/templates/apply.js";
import { listPresetTemplates } from "../../src/templates/list.js";

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
    expect(fs.readFileSync(path.join(target, "petri.yaml"), "utf-8")).toMatch(/type:\s*codex/);
    expect(fs.readFileSync(path.join(target, "pipeline.yaml"), "utf-8")).toMatch(/unit_test/);
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
