/** Separate execution lifecycle from quality outcome (issue #17). */

export type ExecutionStatus = "running" | "completed" | "unknown";
export type QualityStatus = "passed" | "failed" | "pending" | "unknown";

export interface RunStatusLike {
  status?: string;
  requirements?: Array<{ id?: string; met: boolean; reason?: string }>;
}

export function computeRunStatuses(run: RunStatusLike): {
  executionStatus: ExecutionStatus;
  qualityStatus: QualityStatus;
  qualityPassed: boolean;
} {
  const st = run.status;
  let executionStatus: ExecutionStatus = "unknown";
  if (st === "running") executionStatus = "running";
  else if (st === "done" || st === "blocked") executionStatus = "completed";

  let qualityStatus: QualityStatus = "unknown";
  if (st === "running") {
    qualityStatus = "pending";
  } else if (st === "blocked") {
    qualityStatus = "failed";
  } else if (st === "done") {
    const reqs = run.requirements;
    if (Array.isArray(reqs) && reqs.length > 0) {
      qualityStatus = reqs.every((r) => r.met) ? "passed" : "failed";
    } else {
      // No requirements declared: completion alone is not a quality success signal
      // Treat as passed only when pipeline finished without requirements checks.
      // Product decision (issue #17): quality success requires met requirements when present;
      // when absent, "done" is quality-passed for backward-compatible success counting of clean runs.
      qualityStatus = "passed";
    }
  }

  return {
    executionStatus,
    qualityStatus,
    qualityPassed: qualityStatus === "passed",
  };
}

/** Success rate = quality-passed runs / total runs (0 if empty). */
export function computeSuccessRate(runs: RunStatusLike[]): number {
  if (!runs.length) return 0;
  const passed = runs.filter((r) => computeRunStatuses(r).qualityPassed).length;
  return Math.round((passed / runs.length) * 100);
}
