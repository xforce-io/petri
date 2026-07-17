/** SSE live log dedupe (issue #21). */

export function shouldAppendSseLine(
  line: string | null | undefined,
  lastLine: string | null,
  seenKeys: Set<string>,
  eventKey: string,
): { append: boolean; nextLast: string | null } {
  if (!line) return { append: false, nextLast: lastLine };
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
}): string {
  if (data.id) return `id:${data.id}`;
  return [data.type, data.stage, data.role, data.attempt, data.passed, data.status]
    .map((x) => (x === undefined || x === null ? "" : String(x)))
    .join("|");
}
