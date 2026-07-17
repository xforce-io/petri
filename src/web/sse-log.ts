/** SSE live log dedupe (issue #21). */

export function shouldAppendSseLine(
  line: string | null | undefined,
  lastLine: string | null,
  seenKeys: Set<string>,
  eventKey: string,
): { append: boolean; nextLast: string | null } {
  if (!line) return { append: false, nextLast: lastLine };
  // Only suppress exact consecutive duplicates of the same formatted line.
  // Event-key dedupe is scoped by makeSseEventKey (includes iteration / seq).
  if (line === lastLine) return { append: false, nextLast: lastLine };
  if (seenKeys.has(eventKey)) return { append: false, nextLast: lastLine };
  seenKeys.add(eventKey);
  return { append: true, nextLast: line };
}

export function makeSseEventKey(data: {
  type?: string;
  stage?: string;
  role?: string;
  attempt?: number | string;
  passed?: boolean;
  status?: string;
  id?: string;
  iteration?: number | string;
  repeatName?: string | null;
  /** Monotonic counter from client when server omits id/iteration */
  seq?: number | string;
}): string {
  if (data.id) return `id:${data.id}`;
  // Include iteration/repeat so Repeat loops reusing attempt numbers are kept
  const parts = [
    data.type,
    data.stage,
    data.role,
    data.attempt,
    data.passed,
    data.status,
    data.iteration,
    data.repeatName,
    data.seq,
  ];
  return parts.map((x) => (x === undefined || x === null ? "" : String(x))).join("|");
}
