import { describe, expect, it } from "vitest";
import { validateReviewContract } from "../../src/engine/review-contract.js";

describe("validateReviewContract", () => {
  const previous = {
    approved: false,
    findings: [
      { id: "F-1", severity: "HIGH", description: "missing auth" },
      { id: "F-2", severity: "MEDIUM", description: "missing test" },
    ],
  };

  it("accepts an approved review only when every acceptance item passed and history is reconciled", () => {
    const result = validateReviewContract({
      approved: true,
      findings: [],
      previous_findings: [
        { id: "F-1", status: "fixed" },
        { id: "F-2", status: "fixed" },
      ],
      acceptance: [{ id: "S1", status: "passed" }],
    }, previous);
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("rejects missing, duplicate, or unprocessed finding identities", () => {
    const result = validateReviewContract({
      approved: false,
      findings: [
        { id: "F-3", severity: "HIGH", description: "x" },
        { id: "F-3", severity: "LOW", description: "y" },
      ],
      previous_findings: [{ id: "F-1", status: "fixed" }],
      acceptance: [{ id: "S1", status: "passed" }],
    }, previous);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/duplicate finding id.*F-3/i);
    expect(result.errors.join("\n")).toMatch(/F-2/);
  });

  it("rejects approval with incomplete acceptance or unresolved high finding", () => {
    const result = validateReviewContract({
      approved: true,
      findings: [{ id: "F-3", severity: "HIGH", description: "still broken" }],
      previous_findings: [
        { id: "F-1", status: "fixed" },
        { id: "F-2", status: "deferred", reason: "needs product decision" },
      ],
      acceptance: [{ id: "S1", status: "failed" }],
    }, previous);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/acceptance.*S1/i);
    expect(result.errors.join("\n")).toMatch(/HIGH/i);
    expect(result.errors.join("\n")).toMatch(/deferred/i);
  });

  it("allows the first contracted review to follow a legacy review without finding IDs", () => {
    const result = validateReviewContract({
      approved: true,
      findings: [],
      acceptance: [{ id: "S1", status: "passed" }],
    }, {
      approved: false,
      findings: [{ severity: "HIGH", description: "legacy output" }],
    });
    expect(result).toEqual({ valid: true, errors: [] });
  });
});
