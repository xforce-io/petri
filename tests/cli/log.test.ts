import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { RunLogger } from "../../src/engine/logger.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "petri-log-test-"));
}

describe("petri log", () => {
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
    const { logCommand } = await import("../../src/cli/log.js");
    await logCommand({});
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("No runs found"));
    consoleSpy.mockRestore();
  });

  it("displays latest run log by default", async () => {
    const petriDir = path.join(tmpDir, ".petri");
    const logger = new RunLogger(petriDir, "test-pipe", "hello");
    logger.append("custom log line");
    logger.finish("done");

    const lines: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      lines.push(args.join(" "));
    });

    const { logCommand } = await import("../../src/cli/log.js");
    await logCommand({});

    const output = lines.join("\n");
    expect(output).toContain("Pipeline: test-pipe");
    expect(output).toContain("custom log line");
    expect(output).toContain("Status: done");

    consoleSpy.mockRestore();
  });

  it("displays specific run log with --run option", async () => {
    const petriDir = path.join(tmpDir, ".petri");

    // Create two runs
    const logger1 = new RunLogger(petriDir, "pipe1", "input1");
    logger1.append("first run line");
    logger1.finish("done");

    const logger2 = new RunLogger(petriDir, "pipe2", "input2");
    logger2.append("second run line");
    logger2.finish("blocked", "stage1");

    const lines: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      lines.push(args.join(" "));
    });

    const { logCommand } = await import("../../src/cli/log.js");
    await logCommand({ run: "001" });

    const output = lines.join("\n");
    expect(output).toContain("first run line");
    expect(output).not.toContain("second run line");

    consoleSpy.mockRestore();
  });

  it("accepts run-NNN format for --run option", async () => {
    const petriDir = path.join(tmpDir, ".petri");
    const logger = new RunLogger(petriDir, "pipe", "input");
    logger.finish("done");

    const lines: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      lines.push(args.join(" "));
    });

    const { logCommand } = await import("../../src/cli/log.js");
    await logCommand({ run: "run-001" });

    const output = lines.join("\n");
    expect(output).toContain("Pipeline: pipe");

    consoleSpy.mockRestore();
  });

  it("reports error for non-existent run", async () => {
    const petriDir = path.join(tmpDir, ".petri");
    const logger = new RunLogger(petriDir, "pipe", "input");
    logger.finish("done");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    const { logCommand } = await import("../../src/cli/log.js");
    await expect(logCommand({ run: "999" })).rejects.toThrow("process.exit");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Run not found"));

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
