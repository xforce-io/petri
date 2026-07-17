import { describe, it, expect } from "vitest";
import { computeRunStatuses, computeSuccessRate } from "../../src/web/run-status.js";

describe("dashboard quality vs execution (issue #17)", () => {
  it("S1: done with unmet requirements is completed but not quality success", () => {
    const s = computeRunStatuses({
      status: "done",
      requirements: [
        { id: "r1", met: true, reason: "ok" },
        { id: "r2", met: false, reason: "missing" },
      ],
    });
    expect(s.executionStatus).toBe("completed");
    expect(s.qualityStatus).toBe("failed");
    expect(s.qualityPassed).toBe(false);
  });

  it("S1: done with all requirements met is quality passed", () => {
    const s = computeRunStatuses({
      status: "done",
      requirements: [{ id: "r1", met: true, reason: "ok" }],
    });
    expect(s.executionStatus).toBe("completed");
    expect(s.qualityStatus).toBe("passed");
    expect(s.qualityPassed).toBe(true);
  });

  it("S1: blocked is completed execution and quality failed", () => {
    const s = computeRunStatuses({ status: "blocked" });
    expect(s.executionStatus).toBe("completed");
    expect(s.qualityStatus).toBe("failed");
  });

  it("S1: success rate excludes quality-failed done runs", () => {
    const runs = [
      { status: "done", requirements: [{ met: true }] },
      { status: "done", requirements: [{ met: false }] },
      { status: "blocked" },
      { status: "running" },
    ];
    // only first is quality passed → 25%
    expect(computeSuccessRate(runs)).toBe(25);
  });
});
