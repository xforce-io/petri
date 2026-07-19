/**
 * Resolve workbench stage cards to the correct run.stages[] entry (issue #55).
 *
 * Repeat loops reuse attempt numbers (often 1) across iterations. Matching only
 * stage+attempt with findIndex always hits the first occurrence, so I/O shows
 * an early failure while the card shows a later pass.
 */

export type StageLogLike = {
  stage: string;
  attempt?: number | string | null;
  role?: string | null;
};

export type StageIndexQuery = {
  stage: string;
  attempt?: number | string | null;
  role?: string | null;
  /**
   * 0-based index among stages that match stage+attempt(+role) in array order.
   * Defaults to 0 (first match) for backward compatibility.
   */
  occurrence?: number;
};

/**
 * Map a workbench selection to a unique index in run.stages[].
 * Prefer `occurrence` when the same stage+attempt appears multiple times.
 */
export function resolveStageLogIndex(
  stages: StageLogLike[] | null | undefined,
  query: StageIndexQuery,
): number {
  if (!stages || stages.length === 0 || !query?.stage) return -1;

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
 * How many prior items share the same stage+attempt as `items[index]`.
 * Used to compute occurrence for a summary row in trace order.
 */
export function occurrenceAmongMatches(
  items: Array<{ stage: string; attempt?: number | string | null }>,
  index: number,
): number {
  const cur = items[index];
  if (!cur) return 0;
  let occ = 0;
  for (let i = 0; i < index; i++) {
    const s = items[i]!;
    if (s.stage === cur.stage && String(s.attempt ?? "") === String(cur.attempt ?? "")) {
      occ += 1;
    }
  }
  return occ;
}
