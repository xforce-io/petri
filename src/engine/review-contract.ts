export interface ReviewFinding {
  id: string;
  severity: string;
  description: string;
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

export interface ReviewContractDocument {
  approved: boolean;
  findings: ReviewFinding[];
  previous_findings?: PreviousFindingResolution[];
  acceptance?: ReviewAcceptance[];
}

export interface ReviewContractResult {
  valid: boolean;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    findings.push({ id: raw.id, severity: raw.severity, description: raw.description });
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

/**
 * Validate only the deterministic shape and state relationships of a review.
 * It deliberately does not decide whether a finding is factually correct.
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
      resolutions.set(raw.id, { id: raw.id, status: raw.status as PreviousFindingResolution["status"], reason: typeof raw.reason === "string" ? raw.reason : undefined });
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

  if (currentRaw.approved) {
    for (const item of acceptance) {
      if (item.status !== "passed") errors.push(`approved review has incomplete acceptance: ${item.id}`);
    }
    for (const finding of currentFindings) {
      if (["CRITICAL", "HIGH"].includes(finding.severity.toUpperCase())) {
        errors.push(`approved review contains ${finding.severity} finding: ${finding.id}`);
      }
    }
    for (const resolution of resolutions.values()) {
      if (resolution.status !== "fixed") {
        errors.push(`approved review has ${resolution.status} previous finding: ${resolution.id}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
