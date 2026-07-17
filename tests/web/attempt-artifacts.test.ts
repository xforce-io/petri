import { describe, it, expect } from "vitest";
import {
  filterArtifactsForAttempt,
  resolveAttemptIoPaths,
  filterLogForAttempt,
  relativizeRunArtifactPaths,
} from "../../src/web/attempt-artifacts.js";

describe("attempt-bound artifacts (issue #16)", () => {
  const artifacts = [
    { path: "001-work/worker/out-a.json", size: 10, stage: "work", role: "worker", attempt: 1, sequence: 1 },
    { path: "001-work/worker/_snapshot.json", size: 20, stage: "work", role: "worker", attempt: 1, sequence: 1 },
    { path: "002-work/worker/out-b.json", size: 11, stage: "work", role: "worker", attempt: 2, sequence: 2 },
    { path: "002-work/worker/_snapshot.json", size: 21, stage: "work", role: "worker", attempt: 2, sequence: 2 },
    { path: "003-review/reviewer/x.json", size: 5, stage: "review", role: "reviewer", attempt: 1, sequence: 3 },
  ];

  it("S1: filters artifacts to attempt 1 only (no attempt 2 leakage)", () => {
    const a1 = filterArtifactsForAttempt(artifacts, { stage: "work", role: "worker", attempt: 1 });
    expect(a1.every((x) => x.attempt === 1)).toBe(true);
    expect(a1.some((x) => x.path.includes("out-a"))).toBe(true);
    expect(a1.some((x) => x.path.includes("out-b"))).toBe(false);
    expect(a1.some((x) => x.stage === "review")).toBe(false);
  });

  it("S1: filters artifacts to attempt 2 only", () => {
    const a2 = filterArtifactsForAttempt(artifacts, { stage: "work", role: "worker", attempt: 2 });
    expect(a2.every((x) => x.attempt === 2)).toBe(true);
    expect(a2.some((x) => x.path.includes("out-b"))).toBe(true);
    expect(a2.some((x) => x.path.includes("out-a"))).toBe(false);
  });

  it("S1: resolveAttemptIoPaths uses snapshot prefix from recorded paths", () => {
    const paths = [
      "/proj/.petri/runs/run-001/artifacts/002-work/worker/out-b.json",
    ];
    const r = resolveAttemptIoPaths(paths, { stage: "work", role: "worker", attempt: 2 });
    expect(r.snapshotPrefix).toBe("002-work/worker");
    expect(r.promptPath).toBe("002-work/worker/_prompt.md");
  });

  it("S1: filterLogForAttempt keeps only the selected attempt window", () => {
    const log = [
      `[t] Stage "work" attempt 1/2`,
      `[t]   work/worker — model: m`,
      `[t]   work/worker done in 1.0s`,
      `[t]   Gate [FAIL]: no`,
      `[t] Stage "work" attempt 2/2`,
      `[t]   work/worker — model: m`,
      `[t]   work/worker done in 2.0s`,
      `[t]   Gate [PASS]: ok`,
      `[t] Stage "review" attempt 1/1`,
      `[t]   review/r — model: m`,
    ].join("\n");
    const a1 = filterLogForAttempt(log, { stage: "work", attempt: 1 });
    expect(a1).toContain("attempt 1/2");
    expect(a1).not.toContain("attempt 2/2");
    expect(a1).not.toContain("review");
    const a2 = filterLogForAttempt(log, { stage: "work", attempt: 2 });
    expect(a2).toContain("attempt 2/2");
    expect(a2).not.toContain("attempt 1/2");
  });

  it("relativizeRunArtifactPaths strips run dir prefix", () => {
    const runDir = "/proj/.petri/runs/run-001";
    const rel = relativizeRunArtifactPaths(runDir, [
      "/proj/.petri/runs/run-001/artifacts/001-work/worker/a.json",
    ]);
    expect(rel[0]).toBe("artifacts/001-work/worker/a.json");
  });
});
