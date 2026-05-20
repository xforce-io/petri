import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createBranch, loadBranch } from "../../src/engine/branch.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "petri-branch-cli-test-"));
}

describe("petri branch", () => {
  let tmpDir: string;
  let originalCwd: string;
  let lines: string[];
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    lines = [];
    consoleSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      lines.push(args.join(" "));
    });
    consoleErrSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
      lines.push(args.join(" "));
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("forks a new branch from an existing branch run", async () => {
    createBranch(tmpDir, "factor-weight-search");
    fs.mkdirSync(path.join(tmpDir, ".petri/branches/factor-weight-search/runs/run-003"), { recursive: true });

    const { branchForkCommand } = await import("../../src/cli/branch.js");
    await branchForkCommand("risk-off-universe-search", {
      fromBranch: "factor-weight-search",
      fromRun: "003",
      artifact: "candidate_strategy.json",
      reason: "Explore a sibling risk-off path.",
      objective: "Search defensive universe variants",
      baseline: "run_007_production",
    });

    const output = lines.join("\n");
    expect(output).toContain("Created branch: risk-off-universe-search");
    expect(output).toContain("Forked from: factor-weight-search/run-003");

    const child = loadBranch(tmpDir, "risk-off-universe-search");
    expect(child.forked_from?.branch_id).toBe("factor-weight-search");
    expect(child.forked_from?.run_id).toBe("run-003");
    expect(child.forked_from?.artifact).toBe("candidate_strategy.json");
  });

  it("initializes a branch from an external strategy seed", async () => {
    const { branchInitCommand } = await import("../../src/cli/branch.js");
    await branchInitCommand("factor-weight-search", {
      objective: "Tune factor weights",
      baseline: "run_007_production",
      seedProject: "quantitative_trading",
      seedStrategyId: "run_007_production",
      seedStrategyPath: "config/strategies/rotation/run_007_production.json",
      seedReason: "Start from published SOTA.",
    });

    const output = lines.join("\n");
    expect(output).toContain("Created branch: factor-weight-search");
    expect(output).toContain("Seeded from: quantitative_trading/run_007_production");

    const branch = loadBranch(tmpDir, "factor-weight-search");
    expect(branch.seeded_from?.type).toBe("external_strategy");
    expect(branch.seeded_from?.strategy_id).toBe("run_007_production");
    expect(branch.forked_from).toBeUndefined();
  });
});
