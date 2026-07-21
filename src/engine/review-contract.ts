export interface ReviewFinding {
  id: string;
  severity: string;
  description: string;
  /** When true, this finding blocks approval (HIGH without this flag does not). */
  blocks_approval?: boolean;
  file?: string;
}

export interface PreviousFindingResolution {
  id: string;
  status: "fixed" | "still_open" | "deferred";
  reason?: string;
}

export interface ReviewAcceptance {
  id: string;
  status: "passed" | "failed" | "not_tested";
}

export interface ReviewFollowUp {
  id: string;
  description: string;
}

export interface ReviewContractDocument {
  approved: boolean;
  findings: ReviewFinding[];
  previous_findings?: PreviousFindingResolution[];
  acceptance?: ReviewAcceptance[];
  /** Residual items deferred after soft approve (last-round exit). */
  followups?: ReviewFollowUp[];
  /**
   * When true, allow at most one blocking HIGH (listed in followups) while
   * still setting approved: true. CRITICAL still always blocks.
   */
  approved_with_followups?: boolean;
}

export interface ReviewContractResult {
  valid: boolean;
  errors: string[];
}

export interface ExhaustionPatchItem {
  id: string;
  severity: string;
  description: string;
  file?: string;
}

export interface ExhaustionReport {
  reason: string;
  resume_hint: string;
  minimal_patch: ExhaustionPatchItem[];
  max_iterations: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a finding alone blocks harness approval (#69).
 * CRITICAL always blocks. HIGH/MEDIUM/LOW block only with blocks_approval: true.
 */
export function findingBlocksApproval(finding: ReviewFinding): boolean {
  const sev = finding.severity.toUpperCase();
  if (sev === "CRITICAL") return true;
  return finding.blocks_approval === true;
}

function asFindings(value: unknown, errors: string[]): ReviewFinding[] {
  if (!Array.isArray(value)) {
    errors.push("findings must be an array");
    return [];
  }
  const seen = new Set<string>();
  const findings: ReviewFinding[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.trim() === "") {
      errors.push("each finding requires a non-empty id");
      continue;
    }
    if (seen.has(raw.id)) errors.push(`duplicate finding id: ${raw.id}`);
    seen.add(raw.id);
    if (typeof raw.severity !== "string" || typeof raw.description !== "string") {
      errors.push(`finding ${raw.id} requires severity and description`);
      continue;
    }
    const finding: ReviewFinding = {
      id: raw.id,
      severity: raw.severity,
      description: raw.description,
    };
    if (typeof raw.blocks_approval === "boolean") {
      finding.blocks_approval = raw.blocks_approval;
    }
    if (typeof raw.file === "string") {
      finding.file = raw.file;
    }
    findings.push(finding);
  }
  return findings;
}

/**
 * Reviews produced before the contract did not contain stable finding IDs.
 * They cannot participate in reconciliation, but they must not prevent an
 * existing pipeline from adopting the new contract on its next run.
 */
function asHistoricalFindings(value: unknown): ReviewFinding[] {
  if (!Array.isArray(value)) return [];
  const errors: string[] = [];
  const findings = asFindings(value, errors);
  return errors.length === 0 ? findings : [];
}

function asFollowups(value: unknown, errors: string[]): ReviewFollowUp[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    errors.push("followups must be an array when present");
    return [];
  }
  const out: ReviewFollowUp[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.description !== "string") {
      errors.push("each followup requires id and description");
      continue;
    }
    out.push({ id: raw.id, description: raw.description });
  }
  return out;
}

/**
 * Validate only the deterministic shape and state relationships of a review.
 * It deliberately does not decide whether a finding is factually correct.
 *
 * Approval rules (#69):
 * - acceptance all passed; previous findings all fixed
 * - CRITICAL always blocks
 * - HIGH/MEDIUM/LOW block only when blocks_approval: true
 * - approved_with_followups: at most one blocking HIGH, each blocking finding
 *   must appear in followups; CRITICAL still disallowed
 */
export function validateReviewContract(currentRaw: unknown, previousRaw?: unknown): ReviewContractResult {
  const errors: string[] = [];
  if (!isRecord(currentRaw) || typeof currentRaw.approved !== "boolean") {
    return { valid: false, errors: ["review requires boolean approved"] };
  }

  const currentFindings = asFindings(currentRaw.findings, errors);
  const previousFindings = isRecord(previousRaw)
    ? asHistoricalFindings(previousRaw.findings)
    : [];

  const rawResolutions = currentRaw.previous_findings;
  const resolutions = new Map<string, PreviousFindingResolution>();
  if (previousFindings.length > 0 && !Array.isArray(rawResolutions)) {
    errors.push("previous_findings must reconcile every prior finding");
  } else if (Array.isArray(rawResolutions)) {
    for (const raw of rawResolutions) {
      if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.status !== "string") {
        errors.push("each previous finding resolution requires id and status");
        continue;
      }
      if (!["fixed", "still_open", "deferred"].includes(raw.status)) {
        errors.push(`previous finding ${raw.id} has invalid status ${raw.status}`);
        continue;
      }
      if (resolutions.has(raw.id)) errors.push(`duplicate previous finding resolution: ${raw.id}`);
      if (raw.status === "deferred" && (typeof raw.reason !== "string" || raw.reason.trim() === "")) {
        errors.push(`deferred finding ${raw.id} requires a reason`);
      }
      resolutions.set(raw.id, {
        id: raw.id,
        status: raw.status as PreviousFindingResolution["status"],
        reason: typeof raw.reason === "string" ? raw.reason : undefined,
      });
    }
  }
  for (const finding of previousFindings) {
    if (!resolutions.has(finding.id)) errors.push(`previous finding not reconciled: ${finding.id}`);
  }

  const rawAcceptance = currentRaw.acceptance;
  const acceptance: ReviewAcceptance[] = [];
  if (!Array.isArray(rawAcceptance) || rawAcceptance.length === 0) {
    errors.push("acceptance must contain at least one checklist item");
  } else {
    const seen = new Set<string>();
    for (const raw of rawAcceptance) {
      if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.status !== "string") {
        errors.push("each acceptance item requires id and status");
        continue;
      }
      if (seen.has(raw.id)) errors.push(`duplicate acceptance id: ${raw.id}`);
      seen.add(raw.id);
      if (!["passed", "failed", "not_tested"].includes(raw.status)) {
        errors.push(`acceptance ${raw.id} has invalid status ${raw.status}`);
        continue;
      }
      acceptance.push({ id: raw.id, status: raw.status as ReviewAcceptance["status"] });
    }
  }

  const followups = asFollowups(currentRaw.followups, errors);
  const softApprove = currentRaw.approved_with_followups === true;
  const followupIds = new Set(followups.map((f) => f.id));

  if (currentRaw.approved) {
    for (const item of acceptance) {
      if (item.status !== "passed") {
        errors.push(`approved review has incomplete acceptance: ${item.id}`);
      }
    }
    for (const resolution of resolutions.values()) {
      if (resolution.status !== "fixed") {
        errors.push(`approved review has ${resolution.status} previous finding: ${resolution.id}`);
      }
    }

    const blockers = currentFindings.filter(findingBlocksApproval);
    const critical = blockers.filter((f) => f.severity.toUpperCase() === "CRITICAL");
    const blockingHigh = blockers.filter((f) => f.severity.toUpperCase() === "HIGH");
    const otherBlockers = blockers.filter(
      (f) => !["CRITICAL", "HIGH"].includes(f.severity.toUpperCase()),
    );

    if (critical.length > 0) {
      for (const f of critical) {
        errors.push(`approved review contains CRITICAL finding: ${f.id}`);
      }
    }

    if (softApprove) {
      if (blockingHigh.length > 1) {
        errors.push(
          `approved_with_followups allows at most 1 blocking HIGH (found ${blockingHigh.length})`,
        );
      }
      for (const f of blockingHigh) {
        if (!followupIds.has(f.id)) {
          errors.push(`blocking finding ${f.id} must be listed in followups for soft approve`);
        }
      }
      for (const f of otherBlockers) {
        if (!followupIds.has(f.id)) {
          errors.push(`blocking finding ${f.id} must be listed in followups for soft approve`);
        }
      }
      // Soft path still requires followups when residual blockers exist
      if (blockers.length > 0 && followups.length === 0) {
        errors.push("approved_with_followups requires followups for residual blockers");
      }
    } else {
      for (const f of blockers) {
        const label =
          f.severity.toUpperCase() === "CRITICAL"
            ? "CRITICAL"
            : f.blocks_approval
              ? "blocking"
              : f.severity;
        errors.push(`approved review contains ${label} finding: ${f.id}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Machine/human-usable report when develop-review-cycle hits max_iterations (#69).
 */
export function buildExhaustionReport(
  lastReview: unknown,
  maxIterations: number,
): ExhaustionReport {
  const resume_hint =
    "petri run --skip-to develop  # or --skip-to unit_test after applying the minimal patch";
  const minimal_patch: ExhaustionPatchItem[] = [];

  if (isRecord(lastReview) && Array.isArray(lastReview.findings)) {
    const errors: string[] = [];
    const findings = asFindings(lastReview.findings, errors);
    for (const f of findings) {
      if (!findingBlocksApproval(f)) continue;
      minimal_patch.push({
        id: f.id,
        severity: f.severity,
        description: f.description,
        file: f.file,
      });
    }
  }

  const patchSummary =
    minimal_patch.length === 0
      ? "no explicit blocking findings in last review (check acceptance / previous_findings)"
      : minimal_patch
          .map((p) => `${p.id} [${p.severity}] ${p.description}${p.file ? ` (${p.file})` : ""}`)
          .join("; ");

  const reason = [
    `Max iterations (${maxIterations}) exhausted`,
    `minimal patch: ${patchSummary}`,
    `resume: ${resume_hint}`,
  ].join(" — ");

  return {
    reason,
    resume_hint,
    minimal_patch,
    max_iterations: maxIterations,
  };
}
