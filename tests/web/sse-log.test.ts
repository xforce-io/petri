import { describe, it, expect } from "vitest";
import { shouldAppendSseLine, makeSseEventKey } from "../../src/web/sse-log.js";

describe("SSE log dedupe (issue #21)", () => {
  it("S1: rejects consecutive identical formatted lines", () => {
    const seen = new Set<string>();
    const line = '[t] Stage "w" attempt 1/1';
    const k = makeSseEventKey({ type: "stage-start", stage: "w", attempt: 1, seq: 1 });
    const a = shouldAppendSseLine(line, null, seen, k);
    expect(a.append).toBe(true);
    const b = shouldAppendSseLine(line, a.nextLast, seen, k);
    expect(b.append).toBe(false);
  });

  it("S1: same event key only once", () => {
    const seen = new Set<string>();
    const k = makeSseEventKey({ type: "role-end", stage: "w", role: "r", attempt: 1, iteration: 1 });
    expect(shouldAppendSseLine("line1", null, seen, k).append).toBe(true);
    expect(shouldAppendSseLine("line2", "line1", seen, k).append).toBe(false);
  });

  it("S1: repeat iteration 2 with attempt 1 is not dropped", () => {
    const seen = new Set<string>();
    const k1 = makeSseEventKey({
      type: "stage-start",
      stage: "work",
      attempt: 1,
      iteration: 1,
      repeatName: "loop",
    });
    const k2 = makeSseEventKey({
      type: "stage-start",
      stage: "work",
      attempt: 1,
      iteration: 2,
      repeatName: "loop",
    });
    expect(k1).not.toBe(k2);
    expect(shouldAppendSseLine("i1", null, seen, k1).append).toBe(true);
    expect(shouldAppendSseLine("i2", "i1", seen, k2).append).toBe(true);
  });

  it("S1: without iteration, client seq keeps successive events", () => {
    const seen = new Set<string>();
    const k1 = makeSseEventKey({ type: "stage-start", stage: "work", attempt: 1, seq: 1 });
    const k2 = makeSseEventKey({ type: "stage-start", stage: "work", attempt: 1, seq: 2 });
    expect(k1).not.toBe(k2);
    expect(shouldAppendSseLine("a", null, seen, k1).append).toBe(true);
    expect(shouldAppendSseLine("b", "a", seen, k2).append).toBe(true);
  });
});
