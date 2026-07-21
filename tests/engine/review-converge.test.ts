import { describe, expect, it } from "vitest";
import {
  validateReviewContract,
  findingBlocksApproval,
  buildExhaustionReport,
  type ReviewContractDocument,
} from "../../src/engine/review-contract.js";

describe("review convergence contract (#69)", () => {
  const previous = {
    approved: false,
    findings: [
      { id: "F-001", severity: "HIGH", description: "missing auth", blocks_approval: true },
      { id: "F-002", severity: "MEDIUM", description: "naming" },
    ],
  };

  it("does not let unmarked new HIGH alone veto approval when history is fixed", () => {
    const current: ReviewContractDocument = {
      approved: true,
      findings: [
        {
          id: "F-004",
          severity: "HIGH",
          description: "new style concern discovered mid-loop",
          // blocks_approval omitted → non-blocking for harness convergence
        },
      ],
      previous_findings: [
        { id: "F-001", status: "fixed" },
        { id: "F-002", status: "fixed" },
      ],
      acceptance: [
        { id: "S1", status: "passed" },
        { id: "S2", status: "passed" },
      ],
      followups: [{ id: "F-004", description: "track style concern after merge" }],
    };
    const result = validateReviewContract(current, previous);
    expect(result.valid).toBe(true);
    expect(findingBlocksApproval(current.findings[0])).toBe(false);
  });

  it("still rejects approval for CRITICAL or explicitly blocking findings", () => {
    const critical = validateReviewContract(
      {
        approved: true,
        findings: [
          { id: "F-c", severity: "CRITICAL", description: "rce" },
        ],
        previous_findings: [
          { id: "F-001", status: "fixed" },
          { id: "F-002", status: "fixed" },
        ],
        acceptance: [{ id: "S1", status: "passed" }],
      },
      previous,
    );
    expect(critical.valid).toBe(false);
    expect(critical.errors.join("\n")).toMatch(/CRITICAL|F-c/i);

    const blockingHigh = validateReviewContract(
      {
        approved: true,
        findings: [
          {
            id: "F-b",
            severity: "HIGH",
            description: "export broken",
            blocks_approval: true,
          },
        ],
        previous_findings: [
          { id: "F-001", status: "fixed" },
          { id: "F-002", status: "fixed" },
        ],
        acceptance: [{ id: "S1", status: "passed" }],
      },
      previous,
    );
    expect(blockingHigh.valid).toBe(false);
    expect(blockingHigh.errors.join("\n")).toMatch(/F-b|blocks/i);
  });

  it("allows final-round approve-with-followups when ≤1 blocking HIGH and acceptance mostly passed", () => {
    const current: ReviewContractDocument = {
      approved: true,
      findings: [
        {
          id: "F-007",
          severity: "HIGH",
          description: "export path edge case",
          blocks_approval: true,
        },
      ],
      previous_findings: [
        { id: "F-001", status: "fixed" },
        { id: "F-002", status: "fixed" },
      ],
      acceptance: [
        { id: "S1", status: "passed" },
        { id: "S2", status: "passed" },
        { id: "S3", status: "passed" },
      ],
      // Soft exit: document the residual blocker as follow-up (≤1 HIGH)
      followups: [
        { id: "F-007", description: "fix export edge case in a follow-up PR" },
      ],
      approved_with_followups: true,
    };
    const result = validateReviewContract(current, previous);
    expect(result.valid).toBe(true);
  });

  it("rejects approve-with-followups when more than one blocking HIGH remains", () => {
    const current: ReviewContractDocument = {
      approved: true,
      approved_with_followups: true,
      findings: [
        { id: "F-a", severity: "HIGH", description: "a", blocks_approval: true },
        { id: "F-b", severity: "HIGH", description: "b", blocks_approval: true },
      ],
      previous_findings: [
        { id: "F-001", status: "fixed" },
        { id: "F-002", status: "fixed" },
      ],
      acceptance: [
        { id: "S1", status: "passed" },
        { id: "S2", status: "passed" },
      ],
      followups: [
        { id: "F-a", description: "a" },
        { id: "F-b", description: "b" },
      ],
    };
    const result = validateReviewContract(current, previous);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/followups|blocking|≤\s*1|<=\s*1|at most 1/i);
  });

  it("buildExhaustionReport lists open blockers and resume guidance", () => {
    const lastReview = {
      approved: false,
      findings: [
        {
          id: "F-007",
          severity: "HIGH",
          description: "export blocked",
          blocks_approval: true,
          file: "src/export.ts",
        },
        { id: "F-006", severity: "MEDIUM", description: "nit" },
      ],
      previous_findings: [{ id: "F-001", status: "fixed" }],
      acceptance: [
        { id: "S1", status: "passed" },
        { id: "S2", status: "failed" },
      ],
    };
    const report = buildExhaustionReport(lastReview, 5);
    expect(report.reason).toMatch(/Max iterations \(5\) exhausted/i);
    expect(report.reason).toMatch(/skip-to develop|petri run/i);
    expect(report.minimal_patch).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "F-007", severity: "HIGH" }),
      ]),
    );
    expect(report.minimal_patch.some((p) => p.id === "F-006")).toBe(false);
    expect(report.resume_hint).toMatch(/--skip-to develop/);
  });

  it("still requires previous_findings reconciliation", () => {
    const result = validateReviewContract(
      {
        approved: false,
        findings: [],
        acceptance: [{ id: "S1", status: "passed" }],
      },
      previous,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/previous finding/i);
  });
});
