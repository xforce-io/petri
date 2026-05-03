import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { validateProject } from "../../src/engine/validate.js";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");

function writeFixture(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "petri-validate-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf-8");
  }
  return dir;
}

const MIN_PETRI = [
  "providers:",
  "  pi:",
  "    type: pi",
  "models:",
  "  default:",
  "    model: claude-sonnet-4-5",
  "defaults:",
  "  model: default",
  "  gate_strategy: strict",
  "  max_retries: 1",
  "",
].join("\n");

describe("validateProject", () => {
  it("returns valid for a correct project", () => {
    const result = validateProject(path.join(FIXTURES, "valid-project"));
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("returns errors when pipeline references missing role", () => {
    const result = validateProject(path.join(FIXTURES, "missing-role"));
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("ghost_role");
  });

  it("rejects a pipeline with no repeat block", () => {
    const dir = writeFixture({
      "petri.yaml": MIN_PETRI,
      "pipeline.yaml": [
        "name: linear",
        "stages:",
        "  - name: work",
        "    roles: [worker]",
        "",
      ].join("\n"),
      "roles/worker/role.yaml": "persona: soul.md\nskills: []\n",
      "roles/worker/soul.md": "You are a worker.\n",
      "roles/worker/gate.yaml": [
        "id: work-approved",
        "evidence:",
        "  path: '{stage}/{role}/output.json'",
        "  check:",
        "    field: approved",
        "    equals: true",
        "",
      ].join("\n"),
    });
    const result = validateProject(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /at least one repeat/i.test(e))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
