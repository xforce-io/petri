import { describe, it, expect } from "vitest";
import {
  resolveStageLogIndex,
  occurrenceAmongMatches,
  extractArtifactHint,
  artifactHintFromRoles,
  rolesHaveArtifacts,
} from "../../src/web/stage-index.js";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Fixture shaped like alfred-164 run-006: multiple review rounds with
 * attempt numbers that restart at 1 each cycle; only the last review passes.
 */
function multiIterationReviewStages() {
  return [
    { stage: "review", role: "code_reviewer", attempt: 1, gatePassed: false, artifacts: ["001-review/code_reviewer/_result.md"] },
    { stage: "review", role: "code_reviewer", attempt: 2, gatePassed: false, artifacts: ["002-review/code_reviewer/_result.md"] },
    { stage: "develop", role: "developer", attempt: 1, gatePassed: true, artifacts: ["003-develop/developer/_result.md"] },
    { stage: "unit_test", role: "command", attempt: 1, gatePassed: true, artifacts: ["004-unit_test/result.json"] },
    { stage: "review", role: "code_reviewer", attempt: 1, gatePassed: false, artifacts: ["005-review/code_reviewer/_result.md"] },
    { stage: "review", role: "code_reviewer", attempt: 2, gatePassed: false, artifacts: ["006-review/code_reviewer/_result.md"] },
    { stage: "develop", role: "developer", attempt: 1, gatePassed: true, artifacts: ["007-develop/developer/_result.md"] },
    { stage: "unit_test", role: "command", attempt: 1, gatePassed: true, artifacts: ["008-unit_test/result.json"] },
    { stage: "review", role: "code_reviewer", attempt: 1, gatePassed: true, artifacts: ["009-review/code_reviewer/_result.md"] },
  ];
}

function multiIterationSummaries() {
  return [
    { stage: "review", attempt: 1, iteration: 1 },
    { stage: "review", attempt: 2, iteration: 1 },
    { stage: "develop", attempt: 1, iteration: 1 },
    { stage: "unit_test", attempt: 1, iteration: 1 },
    { stage: "review", attempt: 1, iteration: 2 },
    { stage: "review", attempt: 2, iteration: 2 },
    { stage: "develop", attempt: 1, iteration: 2 },
    { stage: "unit_test", attempt: 1, iteration: 2 },
    { stage: "review", attempt: 1, iteration: 3 },
  ];
}

/**
 * Real run-006 shape: trace has ghost develop a=1 (timeout, no stages[] row)
 * before later successful develop a=1 rows. stages[] is sparse.
 */
function sparseRun006Like() {
  const stages = [
    { stage: "review", role: "code_reviewer", attempt: 1, artifacts: ["/r/artifacts/001-review/code_reviewer/_result.md"] },
    { stage: "review", role: "code_reviewer", attempt: 2, artifacts: ["/r/artifacts/002-review/code_reviewer/_result.md"] },
    { stage: "develop", role: "developer", attempt: 2, artifacts: ["/r/artifacts/003-develop/developer/_agent_run.json"] },
    { stage: "develop", role: "developer", attempt: 4, artifacts: ["/r/artifacts/004-develop/developer/_agent_run.json"] },
    { stage: "unit_test", role: "command", attempt: 1, artifacts: ["/r/artifacts/005-unit_test/result.json"] },
    { stage: "review", role: "code_reviewer", attempt: 1, artifacts: ["/r/artifacts/006-review/code_reviewer/_result.md"] },
    { stage: "review", role: "code_reviewer", attempt: 2, artifacts: ["/r/artifacts/007-review/code_reviewer/_result.md"] },
    // iter3 develop a=1 — first stages[] develop a=1
    { stage: "develop", role: "developer", attempt: 1, artifacts: ["/r/artifacts/008-develop/developer/_agent_run.json"] },
    { stage: "unit_test", role: "command", attempt: 1, artifacts: ["/r/artifacts/009-unit_test/result.json"] },
    { stage: "review", role: "code_reviewer", attempt: 1, artifacts: ["/r/artifacts/010-review/code_reviewer/_result.md"] },
    { stage: "review", role: "code_reviewer", attempt: 2, artifacts: ["/r/artifacts/011-review/code_reviewer/_result.md"] },
    // iter4 develop a=1
    { stage: "develop", role: "developer", attempt: 1, artifacts: ["/r/artifacts/012-develop/developer/_agent_run.json"] },
    { stage: "unit_test", role: "command", attempt: 1, artifacts: ["/r/artifacts/013-unit_test/result.json"] },
    { stage: "review", role: "code_reviewer", attempt: 1, artifacts: ["/r/artifacts/014-review/code_reviewer/_result.md"] },
  ];

  // Trace summaries include ghost develop a=1 (iter2 timeout) with empty artifacts
  const summaries = [
    { key: "review:1:1", stage: "review", attempt: 1, iteration: 1, roles: [{ role: "code_reviewer", artifacts: ["/r/artifacts/001-review/code_reviewer/_result.md"] }] },
    { key: "review:1:2", stage: "review", attempt: 2, iteration: 1, roles: [{ role: "code_reviewer", artifacts: ["/r/artifacts/002-review/code_reviewer/_result.md"] }] },
    { key: "develop:2:1", stage: "develop", attempt: 1, iteration: 2, roles: [{ role: "developer", artifacts: [] }] }, // ghost
    { key: "develop:2:2", stage: "develop", attempt: 2, iteration: 2, roles: [{ role: "developer", artifacts: ["/r/artifacts/003-develop/developer/_agent_run.json"] }] },
    { key: "develop:2:4", stage: "develop", attempt: 4, iteration: 2, roles: [{ role: "developer", artifacts: ["/r/artifacts/004-develop/developer/_agent_run.json"] }] },
    { key: "unit_test:2:1", stage: "unit_test", attempt: 1, iteration: 2, roles: [{ role: "command", artifacts: ["/r/artifacts/005-unit_test/result.json"] }] },
    { key: "review:2:1", stage: "review", attempt: 1, iteration: 2, roles: [{ role: "code_reviewer", artifacts: ["/r/artifacts/006-review/code_reviewer/_result.md"] }] },
    { key: "review:2:2", stage: "review", attempt: 2, iteration: 2, roles: [{ role: "code_reviewer", artifacts: ["/r/artifacts/007-review/code_reviewer/_result.md"] }] },
    { key: "develop:3:1", stage: "develop", attempt: 1, iteration: 3, roles: [{ role: "developer", artifacts: ["/r/artifacts/008-develop/developer/_agent_run.json"] }] },
    { key: "unit_test:3:1", stage: "unit_test", attempt: 1, iteration: 3, roles: [{ role: "command", artifacts: ["/r/artifacts/009-unit_test/result.json"] }] },
    { key: "review:3:1", stage: "review", attempt: 1, iteration: 3, roles: [{ role: "code_reviewer", artifacts: ["/r/artifacts/010-review/code_reviewer/_result.md"] }] },
    { key: "review:3:2", stage: "review", attempt: 2, iteration: 3, roles: [{ role: "code_reviewer", artifacts: ["/r/artifacts/011-review/code_reviewer/_result.md"] }] },
    { key: "develop:4:1", stage: "develop", attempt: 1, iteration: 4, roles: [{ role: "developer", artifacts: ["/r/artifacts/012-develop/developer/_agent_run.json"] }] },
    { key: "unit_test:4:1", stage: "unit_test", attempt: 1, iteration: 4, roles: [{ role: "command", artifacts: ["/r/artifacts/013-unit_test/result.json"] }] },
    { key: "review:4:1", stage: "review", attempt: 1, iteration: 4, roles: [{ role: "code_reviewer", artifacts: ["/r/artifacts/014-review/code_reviewer/_result.md"] }] },
  ];

  return { stages, summaries };
}

function resolveLikeWorkbench(
  stages: ReturnType<typeof sparseRun006Like>["stages"],
  summaries: ReturnType<typeof sparseRun006Like>["summaries"],
  summaryIndex: number,
  role?: string,
) {
  const summary = summaries[summaryIndex]!;
  const hasArts = rolesHaveArtifacts(summary.roles);
  const hint = artifactHintFromRoles(summary.roles);
  const eligible = (_item: { stage: string }, i: number) =>
    rolesHaveArtifacts(summaries[i]!.roles);
  const occurrence = occurrenceAmongMatches(summaries, summaryIndex, eligible);
  return resolveStageLogIndex(stages, {
    stage: summary.stage,
    attempt: summary.attempt,
    role,
    occurrence: hasArts ? occurrence : 0,
    artifactHint: hint,
    hasRoleArtifacts: hasArts,
  });
}

describe("workbench stage→I/O index mapping (issue #55)", () => {
  it("S2: first-only stage+attempt match is wrong for later iterations (documents the bug)", () => {
    const stages = multiIterationReviewStages();
    const legacy = stages.findIndex(
      (s) => s.stage === "review" && String(s.attempt) === "1",
    );
    expect(legacy).toBe(0);
    expect(stages[legacy]!.gatePassed).toBe(false);
    expect(stages[legacy]!.artifacts![0]).toContain("001-review");
  });

  it("S2: last-iteration Review attempt 1 resolves to last matching stage (passed snapshot)", () => {
    const stages = multiIterationReviewStages();
    const summaries = multiIterationSummaries();
    const lastReviewSummaryIndex = summaries.length - 1;
    const occurrence = occurrenceAmongMatches(summaries, lastReviewSummaryIndex);
    expect(occurrence).toBe(2);

    const idx = resolveStageLogIndex(stages, {
      stage: "review",
      attempt: 1,
      role: "code_reviewer",
      occurrence,
    });
    expect(idx).toBe(8);
    expect(stages[idx]!.gatePassed).toBe(true);
    expect(stages[idx]!.artifacts![0]).toContain("009-review");
    expect(idx).not.toBe(0);
  });

  it("S2: first-iteration Review still maps to the first match when occurrence is 0", () => {
    const stages = multiIterationReviewStages();
    const idx = resolveStageLogIndex(stages, {
      stage: "review",
      attempt: 1,
      occurrence: 0,
    });
    expect(idx).toBe(0);
    expect(stages[idx]!.gatePassed).toBe(false);
  });

  it("S2: attempt 2 within an iteration uses its own occurrence series", () => {
    const stages = multiIterationReviewStages();
    const summaries = multiIterationSummaries();
    const si = 5;
    const occurrence = occurrenceAmongMatches(summaries, si);
    expect(occurrence).toBe(1);
    const idx = resolveStageLogIndex(stages, {
      stage: "review",
      attempt: 2,
      occurrence,
    });
    expect(idx).toBe(5);
    expect(stages[idx]!.artifacts![0]).toContain("006-review");
  });

  it("S2: sparse stages[] — ghost develop a=1 must not steal later I/O (run-006 shape)", () => {
    const { stages, summaries } = sparseRun006Like();

    // Ghost (iter2 develop a=1, no artifacts) → no stages[] mapping
    const ghostIdx = summaries.findIndex((s) => s.key === "develop:2:1");
    expect(rolesHaveArtifacts(summaries[ghostIdx]!.roles)).toBe(false);
    expect(resolveLikeWorkbench(stages, summaries, ghostIdx, "developer")).toBe(-1);

    // Raw occurrence over ALL develop a=1 summaries would be wrong:
    // ghost=0, iter3=1, iter4=2 → iter3 would map to stages[11] (012) not [7] (008)
    const iter3 = summaries.findIndex((s) => s.key === "develop:3:1");
    const rawOcc = occurrenceAmongMatches(summaries, iter3); // counts ghost
    expect(rawOcc).toBe(1);
    const wrong = resolveStageLogIndex(stages, {
      stage: "develop",
      attempt: 1,
      role: "developer",
      occurrence: rawOcc,
    });
    expect(stages[wrong]!.artifacts![0]).toContain("012-develop"); // documents raw-occ bug

    // Artifact-hint (shipped path) maps iter3 → 008-develop
    const idx3 = resolveLikeWorkbench(stages, summaries, iter3, "developer");
    expect(idx3).toBe(7);
    expect(stages[idx3]!.artifacts![0]).toContain("008-develop");

    const iter4 = summaries.findIndex((s) => s.key === "develop:4:1");
    const idx4 = resolveLikeWorkbench(stages, summaries, iter4, "developer");
    expect(idx4).toBe(11);
    expect(stages[idx4]!.artifacts![0]).toContain("012-develop");
  });

  it("S2: last review in sparse run maps to 014-review via artifact hint", () => {
    const { stages, summaries } = sparseRun006Like();
    const last = summaries.findIndex((s) => s.key === "review:4:1");
    const idx = resolveLikeWorkbench(stages, summaries, last, "code_reviewer");
    expect(idx).toBe(13);
    expect(stages[idx]!.artifacts![0]).toContain("014-review");
    // Must not be first failed review
    expect(idx).not.toBe(0);
  });

  it("S2: extractArtifactHint reads seq-stage/role prefixes", () => {
    expect(
      extractArtifactHint([
        "/proj/.petri/runs/run-006/artifacts/014-review/code_reviewer/_result.md",
      ]),
    ).toBe("014-review/code_reviewer");
    expect(
      artifactHintFromRoles([
        { role: "developer", artifacts: ["/x/artifacts/008-develop/developer/_agent_run.json"] },
      ]),
    ).toBe("008-develop/developer");
  });

  it("S2: shipped app.js uses artifactHint + hasRoleArtifacts (not raw occurrence alone)", () => {
    const appJs = fs.readFileSync(
      path.join(process.cwd(), "src/web/public/app.js"),
      "utf-8",
    );
    expect(appJs).toMatch(/function resolveStageLogIndex\s*\(/);
    expect(appJs).toMatch(/occurrenceAmongMatches\s*\(/);
    expect(appJs).toMatch(/artifactHint|extractArtifactHint|artifactHintFromRoles/);
    expect(appJs).toMatch(/hasRoleArtifacts/);
    expect(appJs).toMatch(/data-key=/);
    expect(appJs).toMatch(/dataset\.key/);
  });
});
