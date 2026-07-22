import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RunLogger } from "../../src/engine/logger.js";
import {
  inheritInputFromResumeRun,
  IN_PLACE_WORKTREE_CONFLICT,
  NO_INPUT_MESSAGE,
  resolveResumeSource,
  resolveWorkspaceMode,
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

describe("petri run workspace mode (issue #71)", () => {
  it("defaults to worktree with auto name when no flags are set", () => {
    expect(resolveWorkspaceMode({}, () => 1_700_000_000_000)).toEqual({
      mode: "worktree",
      name: "run-1700000000000",
    });
  });

  it("defaults to worktree when --worktree is passed without a name", () => {
    expect(resolveWorkspaceMode({ worktree: true }, () => 42)).toEqual({
      mode: "worktree",
      name: "run-42",
    });
  });

  it("uses an explicit worktree directory name", () => {
    expect(resolveWorkspaceMode({ worktree: "experiment-a" })).toEqual({
      mode: "worktree",
      name: "experiment-a",
    });
  });

  it("uses in-place (trunk) only when --in-place is set", () => {
    expect(resolveWorkspaceMode({ inPlace: true })).toEqual({ mode: "in-place" });
  });

  it("rejects combining --in-place with --worktree", () => {
    expect(() => resolveWorkspaceMode({ inPlace: true, worktree: true })).toThrow(
      IN_PLACE_WORKTREE_CONFLICT,
    );
    expect(() =>
      resolveWorkspaceMode({ inPlace: true, worktree: "named" }),
    ).toThrow(/--in-place cannot be combined/);
  });

  it("rejects path-traversing or multi-segment worktree names", () => {
    expect(() => resolveWorkspaceMode({ worktree: "../escape" })).toThrow(
      /Invalid --worktree name/,
    );
    expect(() => resolveWorkspaceMode({ worktree: "a/b" })).toThrow(
      /Invalid --worktree name/,
    );
    expect(() => resolveWorkspaceMode({ worktree: ".." })).toThrow(
      /Invalid --worktree name/,
    );
  });
});
