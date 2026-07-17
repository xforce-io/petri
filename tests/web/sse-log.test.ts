import { describe, it, expect } from "vitest";
import { shouldAppendSseLine, makeSseEventKey } from "../../src/web/sse-log.js";

describe("SSE log dedupe (issue #21)", () => {
  it("S1: rejects consecutive identical formatted lines", () => {
    const seen = new Set<string>();
    const line = '[t] Stage "w" attempt 1/1';
    const k = makeSseEventKey({ type: "stage-start", stage: "w", attempt: 1 });
    const a = shouldAppendSseLine(line, null, seen, k);
    expect(a.append).toBe(true);
    const b = shouldAppendSseLine(line, a.nextLast, seen, k);
    expect(b.append).toBe(false);
  });

  it("S1: same event key only once even if formatting differs slightly", () => {
    const seen = new Set<string>();
    const k = makeSseEventKey({ type: "role-end", stage: "w", role: "r", attempt: 1 });
    expect(shouldAppendSseLine("line1", null, seen, k).append).toBe(true);
    expect(shouldAppendSseLine("line2", "line1", seen, k).append).toBe(false);
  });
});
