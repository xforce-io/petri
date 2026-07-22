import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { RunLogger } from "../../src/engine/logger.js";
import {
  buildWorktreeRefuseMessage,
  collectWorktreeWip,
  formatWorktreeWipReport,
  inheritInputFromResumeRun,
  IN_PLACE_WORKTREE_CONFLICT,
  NO_INPUT_MESSAGE,
  parseWorktreeWip,
  resolveResumeSource,
  resolveWorkspaceMode,
  resolveWorktreeLifecycle,
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

describe("petri run worktree lifecycle (issue #74)", () => {
  const cwd = "/repo";
  const name = "issue-63";
  const expectedPath = path.resolve(cwd, ".worktrees", name);

  it("S1: resume + existing named worktree reuses path without create", () => {
    const decision = resolveWorktreeLifecycle({
      cwd,
      name,
      pathExists: true,
      resumeRun: "003",
    });
    expect(decision).toEqual({
      action: "reuse",
      path: expectedPath,
      name,
      reason: "resume",
    });
  });

  it("S1: explicit --reuse-worktree reuses existing path", () => {
    const decision = resolveWorktreeLifecycle({
      cwd,
      name,
      pathExists: true,
      reuseWorktree: true,
    });
    expect(decision).toEqual({
      action: "reuse",
      path: expectedPath,
      name,
      reason: "flag",
    });
  });

  it("S2: existing path without resume or reuse refuses (never silent wipe)", () => {
    const decision = resolveWorktreeLifecycle({
      cwd,
      name,
      pathExists: true,
    });
    expect(decision.action).toBe("refuse");
    if (decision.action !== "refuse") throw new Error("expected refuse");
    expect(decision.path).toBe(expectedPath);
    expect(decision.name).toBe(name);

    const msg = buildWorktreeRefuseMessage(decision);
    expect(msg).toContain(expectedPath);
    expect(msg).toMatch(/--reuse-worktree/);
    expect(msg).toMatch(/--resume-run/);
    expect(msg).toMatch(/--worktree/);
  });

  it("creates when path does not exist (even with resume)", () => {
    expect(
      resolveWorktreeLifecycle({
        cwd,
        name,
        pathExists: false,
        resumeRun: "001",
      }),
    ).toEqual({
      action: "create",
      path: expectedPath,
      name,
    });
    expect(
      resolveWorktreeLifecycle({
        cwd,
        name,
        pathExists: false,
        reuseWorktree: true,
      }),
    ).toEqual({
      action: "create",
      path: expectedPath,
      name,
    });
  });

  it("resume takes precedence over refuse when path exists", () => {
    // resume alone is enough; no need for --reuse-worktree
    const decision = resolveWorktreeLifecycle({
      cwd,
      name: "issue-N",
      pathExists: true,
      resumeRun: "run-004",
      reuseWorktree: false,
    });
    expect(decision.action).toBe("reuse");
  });
});

describe("petri run worktree WIP summary (issue #74 S3)", () => {
  const worktreePath = "/repo/.worktrees/issue-63";

  it("reports non-zero WIP for tracked diffs", () => {
    const wip = parseWorktreeWip({
      worktreePath,
      porcelain: " M src/app.py\n",
      diffStat: " src/app.py | 12 +++++++++++-\n 1 file changed, 11 insertions(+), 1 deletion(-)\n",
    });
    expect(wip.hasChanges).toBe(true);
    expect(wip.fileCount).toBeGreaterThan(0);
    expect(wip.path).toBe(worktreePath);

    const report = formatWorktreeWipReport(wip);
    expect(report.join("\n")).toContain(worktreePath);
    expect(report.join("\n")).not.toMatch(/No code changes made/);
    expect(report.some((l) => /file|change|WIP|modified|untracked/i.test(l))).toBe(
      true,
    );
  });

  it("reports non-zero WIP for untracked-only files (git diff --stat alone is empty)", () => {
    const wip = parseWorktreeWip({
      worktreePath,
      porcelain: "?? new_module.py\n?? tests/test_new.py\n",
      diffStat: "",
    });
    expect(wip.hasChanges).toBe(true);
    expect(wip.fileCount).toBe(2);
    expect(wip.diffStat.trim()).toBe("");

    const report = formatWorktreeWipReport(wip);
    const text = report.join("\n");
    expect(text).toContain(worktreePath);
    expect(text).not.toMatch(/No code changes made/);
    expect(text).toMatch(/untracked|2 file|WIP/i);
  });

  it("reports clean worktree without false non-zero signal", () => {
    const wip = parseWorktreeWip({
      worktreePath,
      porcelain: "",
      diffStat: "",
    });
    expect(wip.hasChanges).toBe(false);
    expect(wip.fileCount).toBe(0);

    const report = formatWorktreeWipReport(wip);
    const text = report.join("\n");
    expect(text).toContain(worktreePath);
    expect(text).toMatch(/No code changes made/);
  });

  it("collectWorktreeWip sees untracked and tracked WIP via real git", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "petri-wip-git-"));
    try {
      execFileSync("git", ["init"], { cwd: tmp, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: tmp,
        stdio: "ignore",
      });
      execFileSync("git", ["config", "user.name", "test"], {
        cwd: tmp,
        stdio: "ignore",
      });
      fs.writeFileSync(path.join(tmp, "README.md"), "base\n");
      execFileSync("git", ["add", "README.md"], { cwd: tmp, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: tmp, stdio: "ignore" });

      const wt = path.join(tmp, ".worktrees", "issue-63");
      fs.mkdirSync(path.join(tmp, ".worktrees"), { recursive: true });
      execFileSync("git", ["worktree", "add", wt, "HEAD"], {
        cwd: tmp,
        stdio: "ignore",
      });
      fs.writeFileSync(path.join(wt, "new_module.py"), "print(1)\n");
      fs.appendFileSync(path.join(wt, "README.md"), "edit\n");

      // Path exists → refuse without resume; reuse with resume (S1/S2 policy on real paths)
      expect(
        resolveWorktreeLifecycle({
          cwd: tmp,
          name: "issue-63",
          pathExists: true,
        }).action,
      ).toBe("refuse");
      expect(
        resolveWorktreeLifecycle({
          cwd: tmp,
          name: "issue-63",
          pathExists: true,
          resumeRun: "003",
        }).action,
      ).toBe("reuse");

      const wip = collectWorktreeWip(wt);
      expect(wip.hasChanges).toBe(true);
      expect(wip.fileCount).toBeGreaterThanOrEqual(1);
      const report = formatWorktreeWipReport(wip).join("\n");
      expect(report).toContain(wt);
      expect(report).not.toMatch(/No code changes made/);
      expect(report).toMatch(/WIP: \d+ file/);
    } finally {
      try {
        execFileSync("git", ["worktree", "remove", "--force", path.join(tmp, ".worktrees", "issue-63")], {
          cwd: tmp,
          stdio: "ignore",
        });
      } catch {
        /* ignore cleanup */
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
