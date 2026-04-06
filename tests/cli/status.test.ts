import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { RunLogger } from "../../src/engine/logger.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "petri-status-test-"));
}

describe("petri status", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("outputs 'No runs found' when no runs exist", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { statusCommand } = await import("../../src/cli/status.js");
    await statusCommand();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("No runs found"));
    consoleSpy.mockRestore();
  });

  it("displays latest run status", async () => {
    // Create a completed run
    const petriDir = path.join(tmpDir, ".petri");
    const logger = new RunLogger(petriDir, "test-pipeline", "test input", "test goal");
    const timer = logger.logRoleStart("design", "designer", "sonnet");
    logger.logRoleEnd(timer, {
      gatePassed: true,
      gateReason: "passed",
      usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
      artifacts: ["design/designer/output.json"],
    });
    logger.finish("done");

    const lines: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      lines.push(args.join(" "));
    });

    const { statusCommand } = await import("../../src/cli/status.js");
    await statusCommand();

    const output = lines.join("\n");
    expect(output).toContain("run-001");
    expect(output).toContain("test-pipeline");
    expect(output).toContain("design");

    consoleSpy.mockRestore();
  });

  it("shows blocked status with reason", async () => {
    const petriDir = path.join(tmpDir, ".petri");
    const logger = new RunLogger(petriDir, "pipe", "input");
    logger.finish("blocked", "review", "gate failed");

    const lines: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      lines.push(args.join(" "));
    });

    const { statusCommand } = await import("../../src/cli/status.js");
    await statusCommand();

    const output = lines.join("\n");
    expect(output).toContain("blocked");
    expect(output).toContain("review");

    consoleSpy.mockRestore();
  });
});
