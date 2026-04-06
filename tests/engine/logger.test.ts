import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import EventEmitter from "node:events";
import {
  RunLogger,
  nextRunId,
  latestRunDir,
  loadRunLog,
  listRuns,
} from "../../src/engine/logger.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "petri-logger-test-"));
}

describe("nextRunId", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 001 when no runs exist", () => {
    expect(nextRunId(path.join(tmpDir, "runs"))).toBe("001");
  });

  it("returns 001 when runs dir is empty", () => {
    const runsDir = path.join(tmpDir, "runs");
    fs.mkdirSync(runsDir, { recursive: true });
    expect(nextRunId(runsDir)).toBe("001");
  });

  it("increments from existing runs", () => {
    const runsDir = path.join(tmpDir, "runs");
    fs.mkdirSync(path.join(runsDir, "run-001"), { recursive: true });
    fs.mkdirSync(path.join(runsDir, "run-002"), { recursive: true });
    expect(nextRunId(runsDir)).toBe("003");
  });

  it("ignores non-run directories", () => {
    const runsDir = path.join(tmpDir, "runs");
    fs.mkdirSync(path.join(runsDir, "run-001"), { recursive: true });
    fs.mkdirSync(path.join(runsDir, "other-dir"), { recursive: true });
    expect(nextRunId(runsDir)).toBe("002");
  });
});

describe("latestRunDir", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no runs exist", () => {
    expect(latestRunDir(path.join(tmpDir, "runs"))).toBeNull();
  });

  it("returns the latest run directory", () => {
    const runsDir = path.join(tmpDir, "runs");
    fs.mkdirSync(path.join(runsDir, "run-001"), { recursive: true });
    fs.mkdirSync(path.join(runsDir, "run-003"), { recursive: true });
    fs.mkdirSync(path.join(runsDir, "run-002"), { recursive: true });
    expect(latestRunDir(runsDir)).toBe(path.join(runsDir, "run-003"));
  });
});

describe("listRuns", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when no runs exist", () => {
    expect(listRuns(path.join(tmpDir, "runs"))).toEqual([]);
  });

  it("returns sorted run names", () => {
    const runsDir = path.join(tmpDir, "runs");
    fs.mkdirSync(path.join(runsDir, "run-003"), { recursive: true });
    fs.mkdirSync(path.join(runsDir, "run-001"), { recursive: true });
    fs.mkdirSync(path.join(runsDir, "run-002"), { recursive: true });
    expect(listRuns(runsDir)).toEqual(["run-001", "run-002", "run-003"]);
  });
});

describe("RunLogger", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates run directory under .petri/runs/", () => {
    const petriDir = path.join(tmpDir, ".petri");
    const logger = new RunLogger(petriDir, "test-pipeline", "test input");

    expect(logger.runId).toBe("001");
    expect(fs.existsSync(logger.runDir)).toBe(true);
    expect(logger.runDir).toBe(path.join(petriDir, "runs", "run-001"));
  });

  it("increments run ID for subsequent loggers", () => {
    const petriDir = path.join(tmpDir, ".petri");
    const logger1 = new RunLogger(petriDir, "pipe1", "input1");
    logger1.finish("done");

    const logger2 = new RunLogger(petriDir, "pipe2", "input2");
    expect(logger2.runId).toBe("002");
  });

  it("writes run.log and run.json on finish", () => {
    const petriDir = path.join(tmpDir, ".petri");
    const logger = new RunLogger(petriDir, "test-pipeline", "test input", "test goal");
    logger.finish("done");

    const logPath = path.join(logger.runDir, "run.log");
    const jsonPath = path.join(logger.runDir, "run.json");

    expect(fs.existsSync(logPath)).toBe(true);
    expect(fs.existsSync(jsonPath)).toBe(true);

    const logContent = fs.readFileSync(logPath, "utf-8");
    expect(logContent).toContain("Pipeline: test-pipeline");
    expect(logContent).toContain("Goal: test goal");
    expect(logContent).toContain("Status: done");

    const runLog = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    expect(runLog.runId).toBe("001");
    expect(runLog.pipeline).toBe("test-pipeline");
    expect(runLog.status).toBe("done");
    expect(runLog.goal).toBe("test goal");
  });

  it("records stage timing and usage", () => {
    const petriDir = path.join(tmpDir, ".petri");
    const logger = new RunLogger(petriDir, "pipe", "input");

    const timer = logger.logRoleStart("design", "designer", "sonnet");
    logger.logRoleEnd(timer, {
      gatePassed: true,
      gateReason: "passed",
      usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
      artifacts: ["design/designer/output.json"],
    });
    logger.finish("done");

    const runLog = loadRunLog(logger.runDir);
    expect(runLog).not.toBeNull();
    expect(runLog!.stages).toHaveLength(1);
    expect(runLog!.stages[0].stage).toBe("design");
    expect(runLog!.stages[0].role).toBe("designer");
    expect(runLog!.totalUsage.inputTokens).toBe(100);
    expect(runLog!.totalUsage.outputTokens).toBe(50);
    expect(runLog!.totalUsage.costUsd).toBe(0.01);
  });
});

describe("RunLogger EventEmitter", () => {
  let tmpDir: string;
  let petriDir: string;
  let logger: RunLogger;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    petriDir = path.join(tmpDir, ".petri");
    logger = new RunLogger(petriDir, "test-pipeline", "test input");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extends EventEmitter", () => {
    expect(logger).toBeInstanceOf(EventEmitter);
  });

  it("emits 'stage-start' from logStageAttempt", () => {
    const handler = vi.fn();
    logger.on("stage-start", handler);

    logger.logStageAttempt("design", 2, 5);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ stage: "design", attempt: 2, max: 5 });
  });

  it("emits 'role-start' from logRoleStart", () => {
    const handler = vi.fn();
    logger.on("role-start", handler);

    logger.logRoleStart("design", "designer", "sonnet");

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ stage: "design", role: "designer", model: "sonnet" });
  });

  it("emits 'role-end' from logRoleEnd with correct payload", () => {
    const handler = vi.fn();
    logger.on("role-end", handler);

    const timer = logger.logRoleStart("design", "designer", "sonnet");
    const usage = { inputTokens: 100, outputTokens: 50, costUsd: 0.01 };
    const artifacts = ["design/designer/output.json"];
    logger.logRoleEnd(timer, {
      gatePassed: true,
      gateReason: "looks good",
      usage,
      artifacts,
    });

    expect(handler).toHaveBeenCalledOnce();
    const payload = handler.mock.calls[0][0];
    expect(payload.stage).toBe("design");
    expect(payload.role).toBe("designer");
    expect(payload.gatePassed).toBe(true);
    expect(payload.gateReason).toBe("looks good");
    expect(payload.usage).toEqual(usage);
    expect(payload.artifacts).toEqual(artifacts);
    expect(typeof payload.durationMs).toBe("number");
    expect(payload.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("emits 'gate-result' from logGateResult", () => {
    const handler = vi.fn();
    logger.on("gate-result", handler);

    logger.logGateResult("design", true, "all criteria met");

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ stage: "design", passed: true, reason: "all criteria met" });
  });

  it("emits 'gate-result' with passed=false", () => {
    const handler = vi.fn();
    logger.on("gate-result", handler);

    logger.logGateResult("implement", false, "missing tests");

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ stage: "implement", passed: false, reason: "missing tests" });
  });

  it("emits 'run-end' from finish with status done", () => {
    const handler = vi.fn();
    logger.on("run-end", handler);

    logger.finish("done");

    expect(handler).toHaveBeenCalledOnce();
    const payload = handler.mock.calls[0][0];
    expect(payload.runId).toBe(logger.runId);
    expect(payload.status).toBe("done");
    expect(payload.blockedStage).toBeUndefined();
    expect(payload.blockedReason).toBeUndefined();
    expect(typeof payload.durationMs).toBe("number");
  });

  it("emits 'run-end' from finish with status blocked", () => {
    const handler = vi.fn();
    logger.on("run-end", handler);

    logger.finish("blocked", "design", "gate failed 3 times");

    expect(handler).toHaveBeenCalledOnce();
    const payload = handler.mock.calls[0][0];
    expect(payload.runId).toBe(logger.runId);
    expect(payload.status).toBe("blocked");
    expect(payload.blockedStage).toBe("design");
    expect(payload.blockedReason).toBe("gate failed 3 times");
    expect(typeof payload.durationMs).toBe("number");
  });
});

describe("loadRunLog", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for non-existent directory", () => {
    expect(loadRunLog(path.join(tmpDir, "nonexistent"))).toBeNull();
  });

  it("loads run log from run directory", () => {
    const petriDir = path.join(tmpDir, ".petri");
    const logger = new RunLogger(petriDir, "pipe", "input");
    logger.finish("blocked", "stage1", "gate failed");

    const loaded = loadRunLog(logger.runDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.status).toBe("blocked");
    expect(loaded!.blockedStage).toBe("stage1");
    expect(loaded!.blockedReason).toBe("gate failed");
  });
});
