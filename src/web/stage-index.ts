/**
 * Resolve workbench stage cards to the correct run.stages[] entry (issue #55).
 *
 * Repeat loops reuse attempt numbers across iterations. Matching only
 * stage+attempt with findIndex always hits the first occurrence.
 *
 * stages[] is also sparse vs trace: timed-out / aborted attempts may appear
 * in the workbench summaries (from trace) without a stages[] row. Pairing
 * must prefer recorded artifact paths, and must not let "ghost" summaries
 * consume later stages[] slots via a raw occurrence counter.
 */

export type StageLogLike = {
  stage: string;
  attempt?: number | string | null;
  role?: string | null;
  artifacts?: string[] | null;
};

export type RoleLike = {
  role?: string;
  artifacts?: string[] | null;
};

export type StageIndexQuery = {
  stage: string;
  attempt?: number | string | null;
  role?: string | null;
  /**
   * 0-based index among stages that match stage+attempt(+role) in array order.
   * Only used when artifactHint is absent. Defaults to 0.
   */
  occurrence?: number;
  /**
   * Path fragment from the attempt's role artifacts (e.g. "008-develop/developer").
   * When set, wins over occurrence so sparse stages[] still bind correctly.
   */
  artifactHint?: string | null;
  /**
   * When false, this summary is a ghost (no role artifacts) and must not map
   * to any stages[] row.
   */
  hasRoleArtifacts?: boolean;
};

/** Snapshot prefix like "014-review/code_reviewer" from absolute/relative paths. */
export function extractArtifactHint(
  paths: string[] | null | undefined,
): string | null {
  if (!paths || paths.length === 0) return null;
  for (const raw of paths) {
    const p = String(raw).replace(/\\/g, "/");
    const idx = p.lastIndexOf("/artifacts/");
    const rel = idx >= 0 ? p.slice(idx + "/artifacts/".length) : p;
    // "014-review/code_reviewer/_result.md" or "008-develop/developer/..."
    const m = rel.match(/^(\d+-[^/]+\/[^/]+)/);
    if (m) return m[1];
    // "005-unit_test/result.json" (command stage, one segment + file)
    const m2 = rel.match(/^(\d+-[^/]+)\//);
    if (m2) return m2[1];
  }
  return null;
}

export function artifactHintFromRoles(
  roles: RoleLike[] | null | undefined,
): string | null {
  if (!roles) return null;
  for (const r of roles) {
    const hint = extractArtifactHint(r.artifacts || undefined);
    if (hint) return hint;
  }
  return null;
}

export function rolesHaveArtifacts(
  roles: RoleLike[] | null | undefined,
): boolean {
  return (roles || []).some((r) => (r.artifacts || []).length > 0);
}

/**
 * Map a workbench selection to a unique index in run.stages[].
 * Preference: ghost → -1; artifactHint match; then occurrence among matches.
 */
export function resolveStageLogIndex(
  stages: StageLogLike[] | null | undefined,
  query: StageIndexQuery,
): number {
  if (!stages || stages.length === 0 || !query?.stage) return -1;
  if (query.hasRoleArtifacts === false) return -1;

  const hint = query.artifactHint ? String(query.artifactHint).replace(/\\/g, "/") : "";
  if (hint) {
    for (let i = 0; i < stages.length; i++) {
      const s = stages[i]!;
      if (s.stage !== query.stage) continue;
      if (
        query.attempt != null
        && query.attempt !== ""
        && String(s.attempt ?? "") !== String(query.attempt)
      ) {
        continue;
      }
      if (query.role && s.role && s.role !== query.role) continue;
      const arts = s.artifacts || [];
      if (arts.some((a) => String(a).replace(/\\/g, "/").includes(hint))) {
        return i;
      }
    }
    // Hint present but no match — do not fall back to occurrence (would steal
    // another attempt's slot). Caller treats -1 as empty I/O.
    return -1;
  }

  const matches: number[] = [];
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i]!;
    if (s.stage !== query.stage) continue;
    if (String(s.attempt ?? "") !== String(query.attempt ?? "")) continue;
    if (query.role && s.role !== query.role) continue;
    matches.push(i);
  }

  if (matches.length === 0) return -1;

  const occ = query.occurrence ?? 0;
  if (occ < 0) return matches[0]!;
  if (occ >= matches.length) return matches[matches.length - 1]!;
  return matches[occ]!;
}

/**
 * How many prior *eligible* items share stage+attempt as `items[index]`.
 * Pass `eligible` to skip ghost summaries so occurrence aligns with sparse stages[].
 */
export function occurrenceAmongMatches(
  items: Array<{ stage: string; attempt?: number | string | null }>,
  index: number,
  eligible?: (item: { stage: string; attempt?: number | string | null }, i: number) => boolean,
): number {
  const cur = items[index];
  if (!cur) return 0;
  let occ = 0;
  for (let i = 0; i < index; i++) {
    const s = items[i]!;
    if (eligible && !eligible(s, i)) continue;
    if (s.stage === cur.stage && String(s.attempt ?? "") === String(cur.attempt ?? "")) {
      occ += 1;
    }
  }
  return occ;
}
