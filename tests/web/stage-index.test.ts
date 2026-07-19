import { describe, it, expect } from "vitest";
import {
  resolveStageLogIndex,
  occurrenceAmongMatches,
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

/** Summaries in trace order (one per stage_attempt). */
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

describe("workbench stage→I/O index mapping (issue #55)", () => {
  it("S2: first-only stage+attempt match is wrong for later iterations (documents the bug)", () => {
    const stages = multiIterationReviewStages();
    // Legacy findIndex behavior: first review attempt 1
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
    expect(summaries[lastReviewSummaryIndex]!.stage).toBe("review");
    expect(summaries[lastReviewSummaryIndex]!.iteration).toBe(3);

    const occurrence = occurrenceAmongMatches(summaries, lastReviewSummaryIndex);
    // review attempt 1 appears at summary indices 0, 4, 8 → occurrence 2
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
    // Must not be the first failed attempt
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
    // Second "review attempt 2" is summary index 5 (iteration 2)
    const si = 5;
    expect(summaries[si]!.attempt).toBe(2);
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

  it("S2: shipped app.js resolves stage cards via occurrence (not stage+attempt findIndex alone)", () => {
    const appJs = fs.readFileSync(
      path.join(process.cwd(), "src/web/public/app.js"),
      "utf-8",
    );
    // Must expose / use occurrence-aware mapping for workbench clicks
    expect(appJs).toMatch(/function resolveStageLogIndex\s*\(/);
    expect(appJs).toMatch(/occurrenceAmongMatches\s*\(/);
    expect(appJs).toMatch(/data-key=/);
    // Card click must not find summary by stage+attempt alone (first-only)
    expect(appJs).toMatch(/dataset\.key|data-key/);
    expect(appJs).toMatch(/occurrence/);
    // Legacy first-only pattern in stageSummaryIndex should be gone or delegated
    expect(appJs).toMatch(/resolveStageLogIndex\s*\(/);
  });
});
