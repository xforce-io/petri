// src/engine/logger.ts

import { mkdirSync, appendFileSync, writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import EventEmitter from "node:events";

export interface StageLog {
  stage: string;
  role: string;
  attempt: number;
  model: string;
  provider?: string;
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

/** Stable hierarchical run trace (issue #15). */
export interface RoleGateResult {
  role: string;
  gateId?: string;
  passed: boolean;
  reason: string;
}

export interface RoleExecutionNode {
  id: string;
  kind: "role_execution";
  stage: string;
  role: string;
  attempt: number;
  iteration: number;
  repeatName: string | null;
  model: string;
  provider?: string;
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  gatePassed?: boolean;
  gateReason?: string;
  artifacts: string[];
}

export interface StageGateDecision {
  id: string;
  strategy?: string;
  passed: boolean;
  reason: string;
  roleResults: RoleGateResult[];
}

export interface StageAttemptNode {
  id: string;
  kind: "stage_attempt";
  stage: string;
  attempt: number;
  maxAttempts: number;
  iteration: number;
  repeatName: string | null;
  status: "running" | "done" | "failed" | "blocked";
  roles: RoleExecutionNode[];
  stageGate?: StageGateDecision;
  startedAt: string;
  finishedAt?: string;
}

export interface RepeatIterationNode {
  id: string;
  kind: "repeat_iteration";
  repeatName: string;
  iteration: number;
  maxIterations: number;
  status: "running" | "done" | "failed" | "blocked";
  children: StageAttemptNode[];
  startedAt: string;
  finishedAt?: string;
}

export type TraceNode = RepeatIterationNode | StageAttemptNode;

export interface RunTrace {
  version: 1;
  root: TraceNode[];
  /** true when reconstructed from legacy StageLog only */
  synthetic?: boolean;
}

export function makeStageAttemptId(
  stage: string,
  iteration: number,
  attempt: number,
  repeatName: string | null = null,
): string {
  const rep = repeatName ?? "_";
  return `att:${stage}:r${rep}:i${iteration}:a${attempt}`;
}

export function makeRoleExecutionId(
  stage: string,
  iteration: number,
  attempt: number,
  role: string,
  repeatName: string | null = null,
): string {
  const rep = repeatName ?? "_";
  return `role:${stage}:r${rep}:i${iteration}:a${attempt}:${role}`;
}

export function makeRepeatIterationId(repeatName: string, iteration: number): string {
  return `rep:${repeatName}:i${iteration}`;
}

/**
 * Build a hierarchical trace from legacy flat StageLog entries (compatibility).
 * Does not invent repeat structure that was never recorded.
 */
export function buildTraceFromStages(stages: StageLog[]): RunTrace {
  const order: string[] = [];
  const byStage = new Map<string, StageLog[]>();
  for (const s of stages) {
    if (!byStage.has(s.stage)) {
      byStage.set(s.stage, []);
      order.push(s.stage);
    }
    byStage.get(s.stage)!.push(s);
  }
  const root: StageAttemptNode[] = [];
  for (const stage of order) {
    const entries = byStage.get(stage) ?? [];
    const byAttempt = new Map<number, StageLog[]>();
    for (const e of entries) {
      const a = e.attempt || 1;
      if (!byAttempt.has(a)) byAttempt.set(a, []);
      byAttempt.get(a)!.push(e);
    }
    for (const attempt of [...byAttempt.keys()].sort((a, b) => a - b)) {
      const roles = byAttempt.get(attempt)!;
      const roleNodes: RoleExecutionNode[] = roles.map((r) => ({
        id: makeRoleExecutionId(stage, 0, attempt, r.role, null),
        kind: "role_execution" as const,
        stage,
        role: r.role,
        attempt,
        iteration: 0,
        repeatName: null,
        model: r.model,
        ...(r.provider ? { provider: r.provider } : {}),
        status: "done" as const,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        durationMs: r.durationMs,
        gatePassed: r.gatePassed,
        gateReason: r.gateReason,
        artifacts: r.artifacts ?? [],
      }));
      const allPassed = roleNodes.every((r) => r.gatePassed);
      const anyFailed = roleNodes.some((r) => r.gatePassed === false);
      root.push({
        id: makeStageAttemptId(stage, 0, attempt, null),
        kind: "stage_attempt",
        stage,
        attempt,
        maxAttempts: attempt,
        iteration: 0,
        repeatName: null,
        status: allPassed ? "done" : anyFailed ? "failed" : "done",
        roles: roleNodes,
        stageGate: {
          id: `gate:${stage}:a${attempt}`,
          passed: allPassed,
          reason: roleNodes.map((r) => `${r.role}: ${r.gateReason ?? ""}`).join("; "),
          roleResults: roleNodes.map((r) => ({
            role: r.role,
            passed: !!r.gatePassed,
            reason: r.gateReason ?? "",
          })),
        },
        startedAt: roles[0]?.startedAt ?? "",
        finishedAt: roles[roles.length - 1]?.finishedAt,
      });
    }
  }
  return { version: 1, root, synthetic: true };
}

export function loadRunTrace(runDir: string): RunTrace | null {
  const p = join(runDir, "trace.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as RunTrace;
  } catch {
    return null;
  }
}

export interface RunLog {
  runId: string;
  branchId?: string;
  branchObjective?: string;
  branchBaseline?: string;
  pipeline: string;
  input: string;
  goal?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  status?: "done" | "blocked";
  blockedStage?: string;
  blockedReason?: string;
  /** The prior run and stage explicitly selected when this run was resumed. */
  resumedFrom?: {
    runId: string;
    stage: string;
  };
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
  private tracePath: string;
  private runLog: RunLog;
  private trace: RunTrace;
  /** Current repeat context (null outside a repeat). */
  private repeatCtx: { name: string; iteration: number; maxIterations: number } | null = null;
  private currentAttempt: StageAttemptNode | null = null;

  constructor(
    petriDir: string,
    pipelineName: string,
    input: string,
    goal?: string,
    opts: {
      branchId?: string;
      branchObjective?: string;
      branchBaseline?: string;
      resumedFrom?: { runId: string; stage: string };
    } = {},
  ) {
    super();
    const runsDir = join(petriDir, "runs");
    this.runId = nextRunId(runsDir);
    this.runDir = join(runsDir, `run-${this.runId}`);
    mkdirSync(this.runDir, { recursive: true });

    this.logPath = join(this.runDir, "run.log");
    this.jsonPath = join(this.runDir, "run.json");
    this.tracePath = join(this.runDir, "trace.json");
    this.trace = { version: 1, root: [] };
    this.persistTrace();

    this.runLog = {
      runId: this.runId,
      branchId: opts.branchId,
      branchObjective: opts.branchObjective,
      branchBaseline: opts.branchBaseline,
      resumedFrom: opts.resumedFrom,
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
    if (opts.branchId) {
      this.append(`Branch: ${opts.branchId}`);
      if (opts.branchObjective) this.append(`Branch objective: ${opts.branchObjective}`);
      if (opts.branchBaseline) this.append(`Branch baseline: ${opts.branchBaseline}`);
    }
    if (opts.resumedFrom) {
      this.append(`Resumed from: run-${opts.resumedFrom.runId} at stage ${opts.resumedFrom.stage}`);
    }
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

  /** Enter a repeat iteration scope for subsequent stage attempts. */
  beginRepeatIteration(repeatName: string, iteration: number, maxIterations: number): void {
    this.repeatCtx = { name: repeatName, iteration, maxIterations };
    const node: RepeatIterationNode = {
      id: makeRepeatIterationId(repeatName, iteration),
      kind: "repeat_iteration",
      repeatName,
      iteration,
      maxIterations,
      status: "running",
      children: [],
      startedAt: new Date().toISOString(),
    };
    this.trace.root.push(node);
    this.append(`Repeat "${repeatName}" iteration ${iteration}/${maxIterations}`);
    this.emit("repeat-iteration-start", { repeatName, iteration, maxIterations, id: node.id });
    this.persistTrace();
  }

  endRepeatIteration(status: "done" | "failed" | "blocked" = "done"): void {
    if (!this.repeatCtx) return;
    const id = makeRepeatIterationId(this.repeatCtx.name, this.repeatCtx.iteration);
    const node = this.findRepeatNode(id);
    if (node) {
      node.status = status;
      node.finishedAt = new Date().toISOString();
    }
    this.emit("repeat-iteration-end", {
      repeatName: this.repeatCtx.name,
      iteration: this.repeatCtx.iteration,
      status,
      id,
    });
    this.repeatCtx = null;
    this.persistTrace();
  }

  logStageAttempt(stage: string, attempt: number, maxAttempts: number): void {
    const iteration = this.repeatCtx?.iteration ?? 0;
    const repeatName = this.repeatCtx?.name ?? null;
    const id = makeStageAttemptId(stage, iteration, attempt, repeatName);
    const node: StageAttemptNode = {
      id,
      kind: "stage_attempt",
      stage,
      attempt,
      maxAttempts,
      iteration,
      repeatName,
      status: "running",
      roles: [],
      startedAt: new Date().toISOString(),
    };
    this.currentAttempt = node;
    if (this.repeatCtx) {
      const rep = this.findRepeatNode(makeRepeatIterationId(this.repeatCtx.name, this.repeatCtx.iteration));
      if (rep) rep.children.push(node);
      else this.trace.root.push(node);
    } else {
      this.trace.root.push(node);
    }
    this.append(`Stage "${stage}" attempt ${attempt}/${maxAttempts}`);
    this.emit("stage-start", {
      stage,
      attempt,
      max: maxAttempts,
      id,
      iteration,
      repeatName,
    });
    this.persistTrace();
  }

  endStageAttempt(status: "done" | "failed" | "blocked" = "done"): void {
    if (!this.currentAttempt) return;
    this.currentAttempt.status = status;
    this.currentAttempt.finishedAt = new Date().toISOString();
    this.emit("stage-attempt-end", {
      id: this.currentAttempt.id,
      stage: this.currentAttempt.stage,
      attempt: this.currentAttempt.attempt,
      status,
    });
    this.currentAttempt = null;
    this.persistTrace();
  }

  logRoleStart(stage: string, role: string, model: string, provider?: string): StageTimer {
    const attempt = this.currentAttempt?.attempt ?? 0;
    const iteration = this.currentAttempt?.iteration ?? this.repeatCtx?.iteration ?? 0;
    const repeatName = this.currentAttempt?.repeatName ?? this.repeatCtx?.name ?? null;
    const id = makeRoleExecutionId(stage, iteration, attempt || 1, role, repeatName);
    const roleNode: RoleExecutionNode = {
      id,
      kind: "role_execution",
      stage,
      role,
      attempt: attempt || 1,
      iteration,
      repeatName,
      model,
      ...(provider ? { provider } : {}),
      status: "running",
      startedAt: new Date().toISOString(),
      artifacts: [],
    };
    if (this.currentAttempt) {
      this.currentAttempt.roles.push(roleNode);
    }
    this.append(`  ${stage}/${role} — model: ${model}${provider ? ` | provider: ${provider}` : ""}`);
    this.emit("role-start", { stage, role, model, provider, id, attempt: roleNode.attempt, iteration, repeatName });
    this.persistTrace();
    return {
      stage,
      role,
      model,
      provider,
      startedAt: new Date(),
      roleId: id,
    };
  }

  logRoleEnd(
    timer: StageTimer,
    opts: {
      gatePassed: boolean;
      gateReason: string;
      attempt?: number;
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
      attempt: opts.attempt ?? 0,
      model: timer.model,
      ...(timer.provider ? { provider: timer.provider } : {}),
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
    // Update structured role node in current attempt
    const roleId = timer.roleId;
    const attemptNode = this.currentAttempt;
    if (attemptNode) {
      const rn = attemptNode.roles.find((r) => r.id === roleId || r.role === timer.role);
      if (rn) {
        rn.status = opts.gatePassed ? "done" : "failed";
        rn.finishedAt = finishedAt.toISOString();
        rn.durationMs = durationMs;
        rn.gatePassed = opts.gatePassed;
        rn.gateReason = opts.gateReason;
        rn.artifacts = opts.artifacts;
      }
    }

    this.emit("role-end", {
      stage: timer.stage,
      role: timer.role,
      gatePassed: opts.gatePassed,
      gateReason: opts.gateReason,
      usage: opts.usage,
      artifacts: opts.artifacts,
      durationMs,
      id: roleId,
      attempt: opts.attempt ?? attemptNode?.attempt,
    });
    this.persistTrace();
  }

  logGateResult(
    stage: string,
    passed: boolean,
    reason: string,
    opts?: {
      strategy?: string;
      roleResults?: RoleGateResult[];
    },
  ): void {
    const icon = passed ? "PASS" : "FAIL";
    this.append(`  Gate [${icon}]: ${reason}`);
    if (this.currentAttempt && this.currentAttempt.stage === stage) {
      const roleResults =
        opts?.roleResults ??
        this.currentAttempt.roles.map((r) => ({
          role: r.role,
          passed: !!r.gatePassed,
          reason: r.gateReason ?? "",
        }));
      this.currentAttempt.stageGate = {
        id: `gate:${stage}:i${this.currentAttempt.iteration}:a${this.currentAttempt.attempt}`,
        strategy: opts?.strategy,
        passed,
        reason,
        roleResults,
      };
      this.currentAttempt.status = passed ? "done" : "failed";
      this.currentAttempt.finishedAt = new Date().toISOString();
    }
    this.emit("gate-result", {
      stage,
      passed,
      reason,
      strategy: opts?.strategy,
      roleResults: opts?.roleResults,
      attemptId: this.currentAttempt?.id,
    });
    this.persistTrace();
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

    // Write structured JSON log + hierarchical trace
    writeFileSync(this.jsonPath, JSON.stringify(this.runLog, null, 2), "utf-8");
    this.persistTrace();

    this.emit("run-end", {
      runId: this.runId,
      status,
      blockedStage,
      blockedReason,
      durationMs: this.runLog.durationMs,
    });
  }

  getTrace(): RunTrace {
    return this.trace;
  }

  private findRepeatNode(id: string): RepeatIterationNode | null {
    for (const n of this.trace.root) {
      if (n.kind === "repeat_iteration" && n.id === id) return n;
    }
    return null;
  }

  private persistTrace(): void {
    writeFileSync(this.tracePath, JSON.stringify(this.trace, null, 2), "utf-8");
  }
}

export interface StageTimer {
  stage: string;
  role: string;
  model: string;
  provider?: string;
  startedAt: Date;
  roleId?: string;
}

// --- private helpers attached via prototype methods on class above ---
