import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RunLogger } from "../../src/engine/logger.js";
import {
  inheritInputFromResumeRun,
  NO_INPUT_MESSAGE,
  resolveResumeSource,
} from "../../src/cli/run.js";

describe("petri run --resume-run", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "petri-run-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("requires --skip-to and records a normalized existing source run", () => {
    const petriDir = path.join(tmpDir, ".petri");
    const source = new RunLogger(petriDir, "code-dev", "Issue #51");
    source.finish("blocked", "develop", "retry");

    expect(resolveResumeSource(petriDir, "1", "unit_test")).toEqual({
      runId: "001",
      stage: "unit_test",
    });
    expect(() => resolveResumeSource(petriDir, "001", undefined)).toThrow(/--skip-to/);
    expect(() => resolveResumeSource(petriDir, "999", "unit_test")).toThrow(/not found/);
  });
});

describe("petri run input inheritance for quality-gate resume (issue #58)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "petri-run-input-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("inherits non-empty input from the source run", () => {
    const petriDir = path.join(tmpDir, ".petri");
    const source = new RunLogger(petriDir, "code-dev", "Full goal from run-001");
    source.finish("blocked", "unit_test", "tests failed");

    expect(inheritInputFromResumeRun(petriDir, "001")).toBe("Full goal from run-001");
    expect(inheritInputFromResumeRun(petriDir, "1")).toBe("Full goal from run-001");
  });

  it("returns undefined when source run is missing or has empty input", () => {
    const petriDir = path.join(tmpDir, ".petri");
    expect(inheritInputFromResumeRun(petriDir, "001")).toBeUndefined();

    const empty = new RunLogger(petriDir, "code-dev", "   ");
    empty.finish("blocked", "develop", "x");
    // whitespace-only is treated as no usable input
    expect(inheritInputFromResumeRun(petriDir, "001")).toBeUndefined();
  });

  it("documents actionable no-input guidance including resume inherit", () => {
    expect(NO_INPUT_MESSAGE).toMatch(/--input/);
    expect(NO_INPUT_MESSAGE).toMatch(/--from/);
    expect(NO_INPUT_MESSAGE).toMatch(/resume-run/);
    expect(NO_INPUT_MESSAGE).toMatch(/inherit/i);
  });
});
