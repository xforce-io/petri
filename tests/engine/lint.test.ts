import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { lintPipeline } from "../../src/engine/lint.js";

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf-8");
  }
}

const HEALTHY_PIPELINE = {
  "pipeline.yaml":
    "name: code-review\n" +
    "stages:\n" +
    "  - name: review\n" +
    "    roles: [reviewer]\n",
  "roles/reviewer/role.yaml": "persona: soul.md\nplaybooks: [review]\n",
  "roles/reviewer/soul.md":
    "You are an experienced code reviewer focused on correctness, " +
    "test coverage, and security.\n",
  "roles/reviewer/playbooks/review.md":
    "# Review\nReview the diff for code quality, tests, and security issues.\n",
  "roles/reviewer/gate.yaml":
    "id: review-done\n" +
    "evidence:\n" +
    "  type: artifact\n" +
    "  path: 'review/reviewer/done.json'\n" +
    "  check:\n" +
    "    field: completed\n" +
    "    equals: true\n",
};

describe("lintPipeline", () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "petri-lint-")); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it("returns no concerns for a healthy pipeline matching the description", () => {
    writeTree(tmp, HEALTHY_PIPELINE);
    const concerns = lintPipeline({
      generatedDir: tmp,
      description: "Build a code reviewer that checks quality, test coverage, and security.",
    });
    expect(concerns).toEqual([]);
  });

  it("flags soul.md that is too short", () => {
    writeTree(tmp, { ...HEALTHY_PIPELINE, "roles/reviewer/soul.md": "Helper.\n" });
    const concerns = lintPipeline({
      generatedDir: tmp,
      description: "Code reviewer for quality and tests",
    });
    expect(concerns.some((c) => c.tag === "persona" && c.message.includes("reviewer"))).toBe(true);
  });

  it("flags soul.md with generic 'helpful assistant' phrasing", () => {
    writeTree(tmp, {
      ...HEALTHY_PIPELINE,
      "roles/reviewer/soul.md":
        "You are a helpful assistant. I will help you with whatever you need.\n",
    });
    const concerns = lintPipeline({
      generatedDir: tmp,
      description: "Code reviewer for quality and tests",
    });
    expect(concerns.some((c) => c.tag === "persona")).toBe(true);
  });

  it("flags description-coverage gap when generated content ignores key terms", () => {
    writeTree(tmp, {
      ...HEALTHY_PIPELINE,
      "roles/reviewer/soul.md": "You write whimsical poetry about clouds and emotions.\n",
      "roles/reviewer/playbooks/review.md": "# Poetry\nWrite stanzas.\n",
    });
    const concerns = lintPipeline({
      generatedDir: tmp,
      description: "Build a code reviewer that checks quality, security, and test coverage.",
    });
    expect(concerns.some((c) => c.tag === "coverage")).toBe(true);
  });

  it("flags gate.yaml missing evidence.check", () => {
    writeTree(tmp, {
      ...HEALTHY_PIPELINE,
      "roles/reviewer/gate.yaml":
        "id: review-done\n" +
        "evidence:\n" +
        "  type: artifact\n" +
        "  path: 'review/reviewer/done.json'\n",
    });
    const concerns = lintPipeline({
      generatedDir: tmp,
      description: "Code reviewer for quality and tests",
    });
    expect(concerns.some((c) => c.tag === "gate" && c.message.includes("reviewer"))).toBe(true);
  });

  it("flags language mismatch: Chinese description with English generated content", () => {
    writeTree(tmp, HEALTHY_PIPELINE);
    const concerns = lintPipeline({
      generatedDir: tmp,
      description: "构建一个代码评审 pipeline，检查代码质量、测试覆盖率和安全性问题",
    });
    expect(concerns.some((c) => c.tag === "lang")).toBe(true);
  });

  it("returns empty when generatedDir is missing pipeline.yaml", () => {
    expect(lintPipeline({ generatedDir: tmp, description: "x" })).toEqual([]);
  });

  it("does not run coverage check for predominantly Chinese descriptions", () => {
    // tokenize() can't handle CJK, so coverage on a CN description is meaningless.
    // Use HEALTHY_PIPELINE (English content) — expect NO coverage concern even though
    // CN tokens won't appear in the generated content.
    writeTree(tmp, HEALTHY_PIPELINE);
    const concerns = lintPipeline({
      generatedDir: tmp,
      description: "构建一个多因子轮动策略，包括动量因子、估值因子、波动因子，并做walk-forward验证",
    });
    expect(concerns.some((c) => c.tag === "coverage")).toBe(false);
  });
});
