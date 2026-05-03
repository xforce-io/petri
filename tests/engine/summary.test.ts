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
    expect(summary!.stages).toHaveLength(2);
    expect(summary!.stages[0]).toMatchObject({ kind: "stage", name: "design", roles: ["designer"] });
    expect(summary!.stages[1]).toMatchObject({ kind: "stage", name: "develop", roles: ["developer"] });
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

  it("exposes repeat blocks as hierarchical entries with gate strength", () => {
    writeTree(tmp, {
      "pipeline.yaml":
        "name: code-dev\n" +
        "stages:\n" +
        "  - name: design\n" +
        "    roles: [designer]\n" +
        "  - repeat:\n" +
        "      name: dev-review\n" +
        "      max_iterations: 3\n" +
        "      until: review-approved\n" +
        "      stages:\n" +
        "        - name: develop\n" +
        "          roles: [developer]\n" +
        "        - name: review\n" +
        "          roles: [reviewer]\n",
      "roles/designer/role.yaml": "persona: soul.md\nskills: []\n",
      "roles/designer/soul.md": "Designer.\n",
      "roles/designer/gate.yaml":
        "id: design-complete\n" +
        "evidence:\n" +
        "  path: 'design/designer/d.json'\n" +
        "  check:\n" +
        "    field: completed\n" +
        "    equals: true\n",
      "roles/developer/role.yaml": "persona: soul.md\nskills: []\n",
      "roles/developer/soul.md": "Developer.\n",
      "roles/developer/gate.yaml":
        "id: tests-pass\n" +
        "evidence:\n" +
        "  path: 'develop/developer/t.json'\n" +
        "  check:\n" +
        "    field: tests_passed\n" +
        "    equals: true\n",
      "roles/reviewer/role.yaml": "persona: soul.md\nskills: []\n",
      "roles/reviewer/soul.md": "Reviewer.\n",
      "roles/reviewer/gate.yaml":
        "id: review-approved\n" +
        "evidence:\n" +
        "  path: 'review/reviewer/r.json'\n" +
        "  check:\n" +
        "    field: approved\n" +
        "    equals: true\n",
    });

    const summary = buildPipelineSummary(tmp)!;
    expect(summary.stages).toHaveLength(2);

    const design = summary.stages[0];
    expect(design.kind).toBe("stage");
    expect(design.name).toBe("design");
    expect(design.roles).toEqual(["designer"]);
    expect(design.gateStrength).toBe("weak"); // field = "completed"

    const loop = summary.stages[1];
    expect(loop.kind).toBe("repeat");
    expect(loop.repeatName).toBe("dev-review");
    expect(loop.maxIterations).toBe(3);
    expect(loop.until).toBe("review-approved");
    expect(loop.innerStages).toHaveLength(2);
    expect(loop.innerStages![0].name).toBe("develop");
    expect(loop.innerStages![0].gateStrength).toBe("strong"); // tests_passed
    expect(loop.innerStages![1].gateStrength).toBe("strong"); // approved
  });

  it("classifies *_ready / *_complete / *_done equals=true as weak", () => {
    writeTree(tmp, {
      "pipeline.yaml":
        "name: weak\n" +
        "stages:\n" +
        "  - name: a\n    roles: [a]\n" +
        "  - name: b\n    roles: [b]\n" +
        "  - name: c\n    roles: [c]\n",
      "roles/a/role.yaml": "persona: soul.md\nskills: []\n",
      "roles/a/soul.md": "A.\n",
      "roles/a/gate.yaml":
        "id: a\nevidence:\n  path: 'x'\n  check:\n    field: hypothesis_ready\n    equals: true\n",
      "roles/b/role.yaml": "persona: soul.md\nskills: []\n",
      "roles/b/soul.md": "B.\n",
      "roles/b/gate.yaml":
        "id: b\nevidence:\n  path: 'x'\n  check:\n    field: backtest_complete\n    equals: true\n",
      "roles/c/role.yaml": "persona: soul.md\nskills: []\n",
      "roles/c/soul.md": "C.\n",
      "roles/c/gate.yaml":
        "id: c\nevidence:\n  path: 'x'\n  check:\n    field: write_done\n    equals: true\n",
    });
    const summary = buildPipelineSummary(tmp)!;
    expect(summary.stages[0].gateStrength).toBe("weak");
    expect(summary.stages[1].gateStrength).toBe("weak");
    expect(summary.stages[2].gateStrength).toBe("weak");
  });
});
