import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createBranch, forkBranch, listBranches, loadBranch, runRootForBranch } from "../../src/engine/branch.js";

let tmpDir: string | undefined;

function makeTmpDir(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "petri-branch-test-"));
  return tmpDir;
}

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe("branch metadata", () => {
  it("creates and loads a named exploration branch", () => {
    const dir = makeTmpDir();

    const branch = createBranch(dir, "factor-weight-search", {
      objective: "Tune factor weights",
      baseline: "run_007_production",
    });

    expect(branch.branch_id).toBe("factor-weight-search");
    expect(fs.existsSync(path.join(dir, ".petri/branches/factor-weight-search/branch.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".petri/branches/factor-weight-search/runs"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".petri/branches/factor-weight-search/artifacts"))).toBe(true);

    const loaded = loadBranch(dir, "factor-weight-search");
    expect(loaded.objective).toBe("Tune factor weights");
    expect(loaded.baseline).toBe("run_007_production");
  });

  it("lists branches in sorted order", () => {
    const dir = makeTmpDir();
    createBranch(dir, "z-branch");
    createBranch(dir, "a-branch");

    expect(listBranches(dir).map((branch) => branch.branch_id)).toEqual(["a-branch", "z-branch"]);
  });

  it("resolves the run root for default and branched runs", () => {
    const dir = makeTmpDir();

    expect(runRootForBranch(dir)).toBe(path.join(dir, ".petri"));
    expect(runRootForBranch(dir, "abc")).toBe(path.join(dir, ".petri", "branches", "abc"));
  });

  it("rejects invalid branch ids", () => {
    const dir = makeTmpDir();

    expect(() => createBranch(dir, "../bad")).toThrow(/Branch id/);
  });

  it("forks a child branch from an existing branch run", () => {
    const dir = makeTmpDir();
    createBranch(dir, "factor-weight-search", {
      objective: "Tune factor weights",
      baseline: "run_007_production",
    });
    fs.mkdirSync(path.join(dir, ".petri/branches/factor-weight-search/runs/run-003"), { recursive: true });

    const child = forkBranch(dir, "risk-off-universe-search", {
      fromBranch: "factor-weight-search",
      fromRun: "003",
      artifact: "candidate_strategy.json",
      reason: "Factor-weight candidate exposed risk-off concentration risk.",
      objective: "Explore risk-off universe variants",
      baseline: "run_007_production",
    });

    expect(child.branch_id).toBe("risk-off-universe-search");
    expect(child.forked_from).toEqual({
      type: "branch_run",
      branch_id: "factor-weight-search",
      run_id: "run-003",
      artifact: "candidate_strategy.json",
      reason: "Factor-weight candidate exposed risk-off concentration risk.",
      forked_at: expect.any(String),
    });

    const loaded = loadBranch(dir, "risk-off-universe-search");
    expect(loaded.forked_from?.branch_id).toBe("factor-weight-search");
    expect(loaded.forked_from?.run_id).toBe("run-003");
  });

  it("requires the parent branch run to exist when forking", () => {
    const dir = makeTmpDir();
    createBranch(dir, "factor-weight-search");

    expect(() => forkBranch(dir, "child-branch", {
      fromBranch: "factor-weight-search",
      fromRun: "003",
    })).toThrow(/Parent run not found/);
  });
});
