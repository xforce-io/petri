// src/engine/logger.ts

import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

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

export class RunLogger {
  private logPath: string;
  private jsonPath: string;
  private runLog: RunLog;

  constructor(petriDir: string, pipelineName: string, input: string, goal?: string) {
    mkdirSync(petriDir, { recursive: true });
    this.logPath = join(petriDir, "run.log");
    this.jsonPath = join(petriDir, "run.json");

    this.runLog = {
      pipeline: pipelineName,
      input,
      goal,
      startedAt: new Date().toISOString(),
      stages: [],
      totalUsage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    };

    // Start fresh log file
    writeFileSync(this.logPath, "", "utf-8");
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
  }

  logRoleStart(stage: string, role: string, model: string): StageTimer {
    this.append(`  ${stage}/${role} — model: ${model}`);
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
  }

  logGateResult(stage: string, passed: boolean, reason: string): void {
    const icon = passed ? "PASS" : "FAIL";
    this.append(`  Gate [${icon}]: ${reason}`);
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
  }
}

export interface StageTimer {
  stage: string;
  role: string;
  model: string;
  startedAt: Date;
}
