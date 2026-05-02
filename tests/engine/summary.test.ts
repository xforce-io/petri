import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { buildPipelineSummary } from "../../src/engine/summary.js";

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf-8");
  }
}

describe("buildPipelineSummary", () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "petri-summary-")); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it("returns name, goal, stages, and roles with persona snippets", () => {
    writeTree(tmp, {
      "pipeline.yaml":
        "name: code-review\n" +
        "goal: Review code for quality\n" +
        "stages:\n" +
        "  - name: design\n" +
        "    roles: [designer]\n" +
        "  - name: develop\n" +
        "    roles: [developer]\n",
      "roles/designer/role.yaml": "persona: soul.md\nskills: [design]\n",
      "roles/designer/soul.md": "You are a software architect who designs systems.\nMore detail.\n",
      "roles/developer/role.yaml": "persona: soul.md\nskills: []\n",
      "roles/developer/soul.md": "You are a senior engineer.\n",
    });

    const summary = buildPipelineSummary(tmp);
    expect(summary).not.toBeNull();
    expect(summary!.name).toBe("code-review");
    expect(summary!.goal).toBe("Review code for quality");
    expect(summary!.stages).toEqual([
      { name: "design", roles: ["designer"] },
      { name: "develop", roles: ["developer"] },
    ]);
    expect(summary!.roles).toHaveLength(2);
    const designer = summary!.roles.find((r) => r.name === "designer")!;
    expect(designer.personaFirstLine).toContain("software architect");
    expect(designer.skills).toEqual(["design"]);
  });

  it("returns null when pipeline.yaml is missing", () => {
    expect(buildPipelineSummary(tmp)).toBeNull();
  });

  it("returns null when pipeline.yaml is malformed", () => {
    writeTree(tmp, { "pipeline.yaml": "name: [unterminated\n" });
    expect(buildPipelineSummary(tmp)).toBeNull();
  });

  it("truncates long persona lines to 80 chars with ellipsis", () => {
    const longLine = "X".repeat(200);
    writeTree(tmp, {
      "pipeline.yaml":
        "name: t\nstages:\n  - name: s\n    roles: [r]\n",
      "roles/r/role.yaml": "persona: soul.md\nskills: []\n",
      "roles/r/soul.md": longLine + "\n",
    });
    const summary = buildPipelineSummary(tmp)!;
    expect(summary.roles[0].personaFirstLine.length).toBeLessThanOrEqual(83);
    expect(summary.roles[0].personaFirstLine.endsWith("...")).toBe(true);
  });
});
