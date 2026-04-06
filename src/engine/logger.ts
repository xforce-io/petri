// src/engine/logger.ts

import { mkdirSync, appendFileSync, writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import EventEmitter from "node:events";

export interface StageLog {
  stage: string;
  role: string;
  attempt: number;
  model: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  gatePassed: boolean;
  gateReason: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    costUsd?: number;
  };
  artifacts: string[];
}

export interface RunLog {
  runId: string;
  pipeline: string;
  input: string;
  goal?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  status?: "done" | "blocked";
  blockedStage?: string;
  blockedReason?: string;
  stages: StageLog[];
  requirements?: Array<{ id: string; met: boolean; reason: string }>;
  totalUsage: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
}

/**
 * Allocate the next run ID by scanning existing run directories.
 * Returns a zero-padded string like "001", "002", etc.
 */
export function nextRunId(runsDir: string): string {
  if (!existsSync(runsDir)) return "001";
  const existing = readdirSync(runsDir)
    .filter((d) => d.startsWith("run-"))
    .map((d) => parseInt(d.replace("run-", ""), 10))
    .filter((n) => !isNaN(n));
  const next = existing.length > 0 ? Math.max(...existing) + 1 : 1;
  return String(next).padStart(3, "0");
}

/**
 * Find the latest run directory under .petri/runs/.
 * Returns null if no runs exist.
 */
export function latestRunDir(runsDir: string): string | null {
  if (!existsSync(runsDir)) return null;
  const dirs = readdirSync(runsDir)
    .filter((d) => d.startsWith("run-"))
    .sort();
  if (dirs.length === 0) return null;
  return join(runsDir, dirs[dirs.length - 1]);
}

/**
 * Load a RunLog from a run directory.
 */
export function loadRunLog(runDir: string): RunLog | null {
  const jsonPath = join(runDir, "run.json");
  if (!existsSync(jsonPath)) return null;
  return JSON.parse(readFileSync(jsonPath, "utf-8")) as RunLog;
}

/**
 * List all available run directories (sorted ascending).
 */
export function listRuns(runsDir: string): string[] {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir)
    .filter((d) => d.startsWith("run-"))
    .sort();
}

export class RunLogger extends EventEmitter {
  readonly runDir: string;
  readonly runId: string;
  private logPath: string;
  private jsonPath: string;
  private runLog: RunLog;

  constructor(petriDir: string, pipelineName: string, input: string, goal?: string) {
    super();
    const runsDir = join(petriDir, "runs");
    this.runId = nextRunId(runsDir);
    this.runDir = join(runsDir, `run-${this.runId}`);
    mkdirSync(this.runDir, { recursive: true });

    this.logPath = join(this.runDir, "run.log");
    this.jsonPath = join(this.runDir, "run.json");

    this.runLog = {
      runId: this.runId,
      pipeline: pipelineName,
      input,
      goal,
      startedAt: new Date().toISOString(),
      stages: [],
      totalUsage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    };

    // Start fresh log file
    writeFileSync(this.logPath, "", "utf-8");
    this.append(`Run: run-${this.runId}`);
    this.append(`Pipeline: ${pipelineName}`);
    if (goal) {
      this.append(`Goal: ${goal.length > 200 ? goal.slice(0, 200) + "..." : goal}`);
    }
    this.append(`Input: ${input.length > 200 ? input.slice(0, 200) + "..." : input}`);
    this.append("");
  }

  append(line: string): void {
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
    appendFileSync(this.logPath, `[${ts}] ${line}\n`, "utf-8");
  }

  logStageAttempt(stage: string, attempt: number, maxAttempts: number): void {
    this.append(`Stage "${stage}" attempt ${attempt}/${maxAttempts}`);
    this.emit("stage-start", { stage, attempt, max: maxAttempts });
  }

  logRoleStart(stage: string, role: string, model: string): StageTimer {
    this.append(`  ${stage}/${role} — model: ${model}`);
    this.emit("role-start", { stage, role, model });
    return {
      stage,
      role,
      model,
      startedAt: new Date(),
    };
  }

  logRoleEnd(
    timer: StageTimer,
    opts: {
      gatePassed: boolean;
      gateReason: string;
      usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
      artifacts: string[];
    },
  ): void {
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - timer.startedAt.getTime();
    const durationSec = (durationMs / 1000).toFixed(1);

    const entry: StageLog = {
      stage: timer.stage,
      role: timer.role,
      attempt: 0, // filled by caller context
      model: timer.model,
      startedAt: timer.startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs,
      gatePassed: opts.gatePassed,
      gateReason: opts.gateReason,
      usage: opts.usage,
      artifacts: opts.artifacts,
    };
    this.runLog.stages.push(entry);

    if (opts.usage) {
      this.runLog.totalUsage.inputTokens += opts.usage.inputTokens;
      this.runLog.totalUsage.outputTokens += opts.usage.outputTokens;
      this.runLog.totalUsage.costUsd += opts.usage.costUsd ?? 0;
    }

    const usageStr = opts.usage
      ? ` | tokens: ${opts.usage.inputTokens}in+${opts.usage.outputTokens}out | cost: $${(opts.usage.costUsd ?? 0).toFixed(4)}`
      : "";
    this.append(`  ${timer.stage}/${timer.role} done in ${durationSec}s${usageStr}`);
    if (opts.artifacts.length > 0) {
      this.append(`  artifacts: ${opts.artifacts.join(", ")}`);
    }
    this.emit("role-end", {
      stage: timer.stage,
      role: timer.role,
      gatePassed: opts.gatePassed,
      gateReason: opts.gateReason,
      usage: opts.usage,
      artifacts: opts.artifacts,
      durationMs,
    });
  }

  logGateResult(stage: string, passed: boolean, reason: string): void {
    const icon = passed ? "PASS" : "FAIL";
    this.append(`  Gate [${icon}]: ${reason}`);
    this.emit("gate-result", { stage, passed, reason });
  }

  logRequirements(results: Array<{ id: string; met: boolean; reason: string }>): void {
    this.runLog.requirements = results;
    this.append("");
    this.append("=== Requirements ===");
    for (const r of results) {
      const icon = r.met ? "PASS" : "FAIL";
      this.append(`  [${icon}] ${r.id}: ${r.reason}`);
    }
    const met = results.filter((r) => r.met).length;
    this.append(`  ${met}/${results.length} requirements met`);
  }

  finish(status: "done" | "blocked", blockedStage?: string, blockedReason?: string): void {
    const finishedAt = new Date();
    this.runLog.finishedAt = finishedAt.toISOString();
    this.runLog.durationMs = finishedAt.getTime() - new Date(this.runLog.startedAt).getTime();
    this.runLog.status = status;
    this.runLog.blockedStage = blockedStage;
    this.runLog.blockedReason = blockedReason;

    const durationSec = (this.runLog.durationMs / 1000).toFixed(1);
    this.append("");
    this.append(`=== Summary ===`);
    this.append(`Status: ${status}${blockedStage ? ` (blocked at ${blockedStage})` : ""}`);
    this.append(`Duration: ${durationSec}s`);
    this.append(
      `Total usage: ${this.runLog.totalUsage.inputTokens}in + ${this.runLog.totalUsage.outputTokens}out tokens | $${this.runLog.totalUsage.costUsd.toFixed(4)}`,
    );

    // Write structured JSON log
    writeFileSync(this.jsonPath, JSON.stringify(this.runLog, null, 2), "utf-8");

    this.emit("run-end", {
      runId: this.runId,
      status,
      blockedStage,
      blockedReason,
      durationMs: this.runLog.durationMs,
    });
  }
}

export interface StageTimer {
  stage: string;
  role: string;
  model: string;
  startedAt: Date;
}
