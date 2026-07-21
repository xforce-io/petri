// src/engine/engine.ts

import { createHash } from "node:crypto";
import { execFileSync, execSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, existsSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { ArtifactManifest } from "./manifest.js";
import { checkGates, resolveGatePath, type GateInput, type GateDetail } from "./gate.js";
import { buildContext } from "./context.js";
import { buildExhaustionReport, validateReviewContract } from "./review-contract.js";
import {
  formatCommandConfigFailure,
  formatCommandExecFailure,
  formatCommandGateFailure,
  normalizeCommandScript,
} from "./command-script.js";
import { isRepeatBlock, isCommandStage } from "../types.js";
import type { RunLogger } from "./logger.js";
import type {
  AgentProvider,
  PipelineConfig,
  StageConfig,
  CommandStage,
  LoadedRole,
  RunResult,
  AttemptRecord,
  GateStrategy,
} from "../types.js";

export interface EngineOptions {
  /** Legacy single-provider form. Use providers for per-role routing. */
  provider?: AgentProvider;
  providers?: Record<string, AgentProvider>;
  defaultProviderName?: string;
  roles: Record<string, LoadedRole>;
  artifactBaseDir: string;
  defaultGateStrategy?: GateStrategy;
  defaultMaxRetries?: number;
  defaultTimeout?: number;  // agent execution timeout in ms (default: 600000 = 10 min)
  logger?: RunLogger;
  skipTo?: string;  // stage name to resume from — skips all stages before it
  /** Source workspace shared by agents and command stages. Defaults to cwd. */
  workspaceDir?: string;
}

export class Engine {
  private readonly providers: Record<string, AgentProvider>;
  private readonly defaultProviderName: string;
  private readonly roles: Record<string, LoadedRole>;
  private readonly artifactBaseDir: string;
  private readonly defaultGateStrategy: GateStrategy;
  private readonly defaultMaxRetries: number;
  private readonly defaultTimeout: number;
  private readonly logger?: RunLogger;
  private readonly skipTo?: string;
  private readonly workspaceDir: string;

  // Gate registry: maps gate id → latest result
  private gateResults: Map<string, GateDetail> = new Map();
  private goal?: string;
  private requirements?: string[];
  private artifactSnapshotSeq = 0;

  constructor(opts: EngineOptions) {
    if (!opts.provider && !opts.providers) {
      throw new Error("Engine requires a provider or providers registry");
    }
    this.providers = opts.providers ?? { default: opts.provider! };
    this.defaultProviderName = opts.defaultProviderName ?? "default";
    this.roles = opts.roles;
    this.artifactBaseDir = opts.artifactBaseDir;
    this.defaultGateStrategy = opts.defaultGateStrategy ?? "all";
    this.defaultMaxRetries = opts.defaultMaxRetries ?? 3;
    this.defaultTimeout = opts.defaultTimeout ?? 600_000;
    this.logger = opts.logger;
    this.skipTo = opts.skipTo;
    this.workspaceDir = opts.workspaceDir ?? process.cwd();
  }

  async run(pipeline: PipelineConfig, input: string): Promise<RunResult> {
    this.goal = pipeline.goal;
    this.requirements = pipeline.requirements;
    this.gateResults.clear();

    // Clear stale artifacts left by prior runs in the shared working dir.
    // Without this, leftover stage subdirs (e.g. from a previously-run pipeline
    // with different stage/role names) leak into the new run's working tree
    // and agents may read them instead of the current run's artifacts.
    // Skipped when resuming via --skip-to, which intentionally reuses earlier artifacts.
    if (!this.skipTo) {
      this.clearStaleArtifacts(pipeline);
    }

    // Resume: load existing manifest if skipping stages, otherwise start fresh
    const manifest = this.skipTo
      ? ArtifactManifest.load(this.artifactBaseDir)
      : new ArtifactManifest(this.artifactBaseDir);

    let skipping = !!this.skipTo;

    for (const entry of pipeline.stages) {
      // Skip stages until we reach the target
      if (skipping) {
        const name = isRepeatBlock(entry) ? entry.repeat.name : entry.name;
        if (name === this.skipTo) {
          skipping = false;
          console.log(`  Resuming from "${name}"...`);
        } else if (isRepeatBlock(entry) && this.containsStage(entry.repeat.stages, this.skipTo!)) {
          // Target is inside this repeat block — enter it, let runRepeatBlock handle skipping
          skipping = false;
          console.log(`  Entering "${name}" to find "${this.skipTo}"...`);
        } else {
          console.log(`  Skipping "${name}" (resume mode)`);
          continue;
        }
      }
      if (isRepeatBlock(entry)) {
        const result = await this.runRepeatBlock(entry.repeat, input, manifest);
        if (result.status === "blocked") {
          manifest.save();
          return result;
        }
      } else if (isCommandStage(entry)) {
        const result = await this.runCommandStage(entry);
        if (result.status === "blocked") {
          manifest.save();
          return result;
        }
      } else {
        const result = await this.runStage(entry, input, manifest);
        if (result.status === "blocked") {
          manifest.save();
          return result;
        }
      }
    }

    manifest.save();

    // Verify requirements — report only, don't block
    if (this.requirements && this.requirements.length > 0) {
      const reqResults = this.checkRequirements();
      this.logger?.logRequirements(reqResults);
    }

    return { status: "done" };
  }

  /**
   * Whitelist-clean the shared artifact working dir. Subdirectories whose
   * name matches a stage in the current pipeline are emptied (kept as shells);
   * everything else (stale stages from a different pipeline, top-level files
   * like a previous manifest.json, etc.) is removed. The current run will
   * recreate stage/role subdirs and a fresh manifest as needed.
   */
  private clearStaleArtifacts(pipeline: PipelineConfig): void {
    if (!existsSync(this.artifactBaseDir)) return;

    const stageNames = new Set<string>();
    const collect = (entries: import("../types.js").StageEntry[]): void => {
      for (const entry of entries) {
        if (isRepeatBlock(entry)) collect(entry.repeat.stages);
        else stageNames.add(entry.name);
      }
    };
    collect(pipeline.stages);

    for (const ent of readdirSync(this.artifactBaseDir, { withFileTypes: true })) {
      const fullPath = join(this.artifactBaseDir, ent.name);
      if (!ent.isDirectory() || !stageNames.has(ent.name)) {
        rmSync(fullPath, { recursive: true, force: true });
        continue;
      }
      // Current-pipeline stage dir: clear stale role subdirs / files
      for (const inner of readdirSync(fullPath)) {
        rmSync(join(fullPath, inner), { recursive: true, force: true });
      }
    }
  }

  private containsStage(stages: import("../types.js").StageEntry[], target: string): boolean {
    for (const entry of stages) {
      const name = isRepeatBlock(entry) ? entry.repeat.name : entry.name;
      if (name === target) return true;
      if (isRepeatBlock(entry) && this.containsStage(entry.repeat.stages, target)) return true;
    }
    return false;
  }

  private checkRequirements(): Array<{ id: string; met: boolean; reason: string }> {
    return (this.requirements ?? []).map((gateId) => {
      const result = this.gateResults.get(gateId);
      if (!result) {
        // Look up gate description from roles
        const desc = this.findGateDescription(gateId);
        return { id: gateId, met: false, reason: `Gate "${gateId}" was never evaluated${desc ? ` (${desc})` : ""}` };
      }
      return {
        id: gateId,
        met: result.passed,
        reason: result.reason,
      };
    });
  }

  private findGateDescription(gateId: string): string | undefined {
    for (const role of Object.values(this.roles)) {
      if (role.gate?.id === gateId) return role.gate.description;
    }
    return undefined;
  }

  private async runStage(
    stage: StageConfig,
    input: string,
    manifest: ArtifactManifest,
  ): Promise<RunResult> {
    const maxRetries = stage.max_retries ?? this.defaultMaxRetries;
    const strategy = stage.gate_strategy ?? this.defaultGateStrategy;
    const attemptTimeout = stage.timeout ?? this.defaultTimeout;
    // After abort, wait this long for providers to kill subprocesses and settle
    // their promises before starting the next attempt (issue #6).
    const settleGraceMs = Math.min(5_000, Math.max(50, attemptTimeout));
    // Hard wall-clock for the whole stage: all attempts + settle windows.
    // Independent of whether individual agent.run() promises ever resolve.
    const stageBudgetMs = (maxRetries + 1) * (attemptTimeout + settleGraceMs);
    const stageDeadline = Date.now() + stageBudgetMs;
    const attemptHistory: AttemptRecord[] = [];
    let failureContext = "";
    let lastFailureHash = "";

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const remainingBudget = stageDeadline - Date.now();
      if (remainingBudget <= 0) {
        console.log(`  Stage "${stage.name}" wall-clock budget exhausted (${stageBudgetMs}ms)`);
        this.logger?.endStageAttempt("blocked");
        return {
          status: "blocked",
          stage: stage.name,
          reason: `Stage wall-clock budget exhausted after ${stageBudgetMs}ms`,
        };
      }

      console.log(`  Stage "${stage.name}" attempt ${attempt + 1}/${maxRetries + 1}...`);
      this.logger?.logStageAttempt(stage.name, attempt + 1, maxRetries + 1);

      // Execute all roles in parallel. A stage attempt has one cancellation
      // signal so one hung role can abort the whole attempt.
      const roleTimers: Array<{ roleName: string; timer: import("./logger.js").StageTimer; usage?: import("../types.js").AgentResult["usage"]; artifacts: string[] }> = [];

      let agentTimedOut = false;
      let timeoutMessage = "";
      const attemptAbort = new AbortController();
      const previousReviewEvidence = new Map<string, unknown>();
      for (const roleName of stage.roles) {
        const gate = this.roles[roleName]?.gate;
        if (gate?.contract?.type !== "review") continue;
        const previousPath = manifest.latestPath(stage.name, roleName, "review.json");
        if (!previousPath) continue;
        try {
          previousReviewEvidence.set(roleName, JSON.parse(readFileSync(previousPath, "utf-8")));
        } catch {
          previousReviewEvidence.set(roleName, undefined);
        }
      }
      // Track in-flight runs so we can await a bounded settle after abort.
      const inflightRuns: Array<Promise<unknown>> = [];

      // Cap this attempt by remaining stage budget so the last attempt cannot
      // overrun the hard wall-clock cap.
      const effectiveTimeout = Math.min(attemptTimeout, remainingBudget);

      try {
        const roleResults = await Promise.allSettled(
          stage.roles.map(async (roleName) => {
            const role = this.roles[roleName];
            if (!role) return;

            const artifactDir = `${this.artifactBaseDir}/${stage.name}/${roleName}`;
            const { mkdirSync } = await import("node:fs");
            mkdirSync(artifactDir, { recursive: true });
            const context = buildContext({
              input,
              goal: this.goal,
              requirements: this.requirements,
              artifactDir,
              workspaceDir: this.workspaceDir,
              manifestText: manifest.formatForContext(),
              failureContext,
              attemptHistory,
            });

            const model = stage.overrides?.[roleName]?.model ?? role.model;
            const providerName = role.provider ?? this.defaultProviderName;
            const provider = this.providers[providerName];
            if (!provider) {
              throw new Error(`role "${roleName}": provider "${providerName}" is not configured`);
            }
            const timer = this.logger?.logRoleStart(stage.name, roleName, model, providerName);

            const agent = provider.createAgent({
              persona: role.persona,
              playbooks: role.playbooks,
              context,
              artifactDir,
              workspaceDir: this.workspaceDir,
              model,
              timeout: effectiveTimeout,
            });

            let timeoutId: NodeJS.Timeout | undefined;
            const timeoutPromise = new Promise<never>((_, reject) => {
              timeoutId = setTimeout(
                () => {
                  const err = new Error(`Agent timed out after ${effectiveTimeout}ms`);
                  attemptAbort.abort(err);
                  reject(err);
                },
                effectiveTimeout,
              );
              // Allow the Node process to exit even if the timer is still pending
              timeoutId.unref();
            });

            const runPromise = agent.run(attemptAbort.signal);
            inflightRuns.push(runPromise.catch(() => {}));
            runPromise.catch(() => {
              // The race below owns the error path. This prevents late provider
              // rejection from surfacing as an unhandled rejection after timeout.
            });
            let result: import("../types.js").AgentResult;
            try {
              result = await Promise.race([runPromise, timeoutPromise]);
            } finally {
              if (timeoutId) clearTimeout(timeoutId);
            }
            if (result.artifacts.length > 0) {
              manifest.collect(stage.name, roleName, result.artifacts);
            }
            const artifactSnapshot = this.snapshotRoleArtifacts({
              stage: stage.name,
              role: roleName,
              attempt: attempt + 1,
              artifactDir,
              artifacts: result.artifacts,
            });

            if (timer) {
              roleTimers.push({
                roleName,
                timer,
                usage: result.usage,
                artifacts: artifactSnapshot.length > 0 ? artifactSnapshot : result.artifacts,
              });
            }
          }),
        );
        const rejected = roleResults.find((result) => result.status === "rejected");
        if (rejected?.status === "rejected") {
          throw rejected.reason;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attemptAbort.signal.aborted || message.includes("Agent timed out") || message.includes("TIMEOUT")) {
          if (!attemptAbort.signal.aborted) {
            attemptAbort.abort(err instanceof Error ? err : new Error(message));
          }
          agentTimedOut = true;
          timeoutMessage = message;
          console.log(`  Stage "${stage.name}" agent TIMED OUT: ${message}`);
        } else {
          throw err;  // re-throw non-timeout errors
        }
      }

      // After timeout/abort: give providers a bounded window to kill subprocess
      // trees and settle promises before the next attempt starts (issue #6).
      // Promise.race alone does not cancel the loser — without this, hung
      // agent.run() calls keep running while retries spawn more work.
      if (agentTimedOut && inflightRuns.length > 0) {
        const grace = Math.min(settleGraceMs, Math.max(0, stageDeadline - Date.now()));
        await Promise.race([
          Promise.all(inflightRuns),
          new Promise<void>((resolve) => {
            const t = setTimeout(resolve, grace);
            t.unref?.();
          }),
        ]);
      }

      // If agent timed out, treat as a failed attempt
      if (agentTimedOut) {
        for (const roleName of stage.roles) {
          this.archiveRoleAttempt(manifest, stage.name, roleName, attempt + 1);
        }

        const failureReason = timeoutMessage;
        const failureHash = createHash("sha256")
          .update(failureReason)
          .digest("hex");

        if (lastFailureHash === failureHash && attempt > 0) {
          this.logger?.endStageAttempt("blocked");
          return {
            status: "blocked",
            stage: stage.name,
            reason: `Stagnation detected: same failure repeated`,
          };
        }

        lastFailureHash = failureHash;
        failureContext = failureReason;
        attemptHistory.push({
          attempt: attempt + 1,
          failureReason,
          failureHash,
        });
        this.logger?.endStageAttempt("failed");
        continue;
      }

      // Check gates
      const gateInputs: GateInput[] = [];
      for (const roleName of stage.roles) {
        const role = this.roles[roleName];
        if (role?.gate) {
          gateInputs.push({ gate: role.gate, roleName });
        }
      }

      const gateResult = await checkGates(
        gateInputs,
        stage.name,
        this.artifactBaseDir,
        strategy,
      );

      for (const { gate, roleName } of gateInputs) {
        if (gate.contract?.type !== "review") continue;
        const reviewPath = join(this.artifactBaseDir, resolveGatePath(gate.evidence.path, stage.name, roleName));
        let review: unknown;
        try {
          review = JSON.parse(readFileSync(reviewPath, "utf-8"));
        } catch {
          review = undefined;
        }
        const contract = validateReviewContract(review, previousReviewEvidence.get(roleName));
        if (!contract.valid) {
          const detail = gateResult.details.find((candidate) => candidate.roleName === roleName && candidate.gateId === gate.id);
          const reason = `Review contract failed: ${contract.errors.join("; ")}`;
          if (detail) {
            const gateReason = detail.reason;
            detail.passed = false;
            detail.reason = `${gateReason}; ${reason}`;
          } else {
            gateResult.details.push({ gateId: gate.id, roleName, passed: false, reason });
          }
          gateResult.passed = false;
          gateResult.reason = reason;
        }
      }

      // Record gate results in registry
      for (const detail of gateResult.details) {
        this.gateResults.set(detail.gateId, detail);
      }

      // Log role results now that we know gate outcome
      for (const rt of roleTimers) {
        const roleGate = gateResult.details.find((d) => d.roleName === rt.roleName);
        this.logger?.logRoleEnd(rt.timer, {
          gatePassed: roleGate?.passed ?? gateResult.passed,
          gateReason: roleGate?.reason ?? gateResult.reason,
          attempt: attempt + 1,
          usage: rt.usage,
          artifacts: rt.artifacts,
        });
      }
      this.logger?.logGateResult(stage.name, gateResult.passed, gateResult.reason, {
        strategy,
        roleResults: gateResult.details.map((d) => ({
          role: d.roleName,
          gateId: d.gateId,
          passed: d.passed,
          reason: d.reason,
        })),
      });
      this.logger?.endStageAttempt(gateResult.passed ? "done" : "failed");

      if (gateResult.passed) {
        console.log(`  Stage "${stage.name}" PASSED`);
        return { status: "done" };
      }

      console.log(`  Stage "${stage.name}" gate FAILED: ${gateResult.reason}`);

      // Archive failed attempt artifacts
      for (const roleName of stage.roles) {
        this.archiveRoleAttempt(manifest, stage.name, roleName, attempt + 1);
      }

      // Gate failed — build a full failure description including details
      const detailLines = gateResult.details
        .filter((d) => !d.passed)
        .map((d) => `${d.roleName}: ${d.reason}`);
      const failureReason = [gateResult.reason, ...detailLines].join("\n");
      const failureHash = createHash("sha256")
        .update(failureReason)
        .digest("hex");

      // Stagnation detection: same hash as last attempt → blocked early
      if (lastFailureHash === failureHash && attempt > 0) {
        return {
          status: "blocked",
          stage: stage.name,
          reason: `Stagnation detected: same failure repeated`,
        };
      }

      lastFailureHash = failureHash;
      failureContext = failureReason;
      attemptHistory.push({
        attempt: attempt + 1,
        failureReason,
        failureHash,
      });
    }

    this.logger?.endStageAttempt("blocked");
    return {
      status: "blocked",
      stage: stage.name,
      reason: `Max retries (${stage.max_retries ?? this.defaultMaxRetries}) exhausted`,
    };
  }

  private async runCommandStage(stage: CommandStage): Promise<RunResult> {
    const artifactDir = join(this.artifactBaseDir, stage.name);
    mkdirSync(artifactDir, { recursive: true });
    const rendered = stage.command.replaceAll("{artifact_dir}", artifactDir);
    // Normalize YAML-folded / more-indented multi-line commands into one script (issue #57)
    const prepared = normalizeCommandScript(rendered);
    const timeout = stage.timeout ?? this.defaultTimeout;

    console.log(`  Command stage "${stage.name}": ${prepared}`);
    this.logger?.logStageAttempt(stage.name, 1, 1);
    // Synthetic role so Run Trace / StageLog record the command as an execution node (issue #18)
    const cmdTimer = this.logger?.logRoleStart(stage.name, "command", "command");
    const startedMs = Date.now();

    if (!prepared) {
      const reason = formatCommandConfigFailure(
        "command is empty after normalization / substitution",
      );
      console.log(`  Command stage "${stage.name}" CONFIG FAILED: ${reason}`);
      if (cmdTimer) {
        this.logger?.logRoleEnd(cmdTimer, {
          gatePassed: false,
          gateReason: reason,
          attempt: 1,
          artifacts: [],
        });
      }
      this.logger?.logGateResult(stage.name, false, reason);
      return { status: "blocked", stage: stage.name, reason };
    }

    try {
      // Explicit sh -c so the whole prepared string is one script (posix).
      if (process.platform === "win32") {
        execSync(prepared, { stdio: "inherit", timeout, cwd: this.workspaceDir });
      } else {
        execFileSync("/bin/sh", ["-c", prepared], { stdio: "inherit", timeout, cwd: this.workspaceDir });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const reason = formatCommandExecFailure(message, prepared);
      console.log(`  Command stage "${stage.name}" EXEC FAILED`);
      console.log(`  --- prepared command ---`);
      console.log(`  ${prepared}`);
      console.log(`  --- end command ---`);
      console.log(`  ${message}`);
      if (cmdTimer) {
        this.logger?.logRoleEnd(cmdTimer, {
          gatePassed: false,
          gateReason: reason,
          attempt: 1,
          artifacts: [],
        });
      }
      this.logger?.logGateResult(stage.name, false, reason);
      return { status: "blocked", stage: stage.name, reason };
    }

    // Snapshot the command's output into the run directory before the gate
    // runs — a gate-rejected run still keeps its output for the lineage.
    const cmdArtifacts = this.snapshotCommandArtifacts(stage.name, artifactDir);
    const durationHint = Date.now() - startedMs;

    // The command ran. If it declares a gate, evaluate it against the output.
    if (stage.gate) {
      const gateResult = await checkGates(
        [{ gate: stage.gate, roleName: stage.name }],
        stage.name,
        this.artifactBaseDir,
        "all",
      );
      for (const detail of gateResult.details) {
        this.gateResults.set(detail.gateId, detail);
      }
      if (!gateResult.passed) {
        const detail = gateResult.details
          .filter((d) => !d.passed)
          .map((d) => d.reason)
          .join("; ");
        const reason = formatCommandGateFailure(detail || gateResult.reason);
        if (cmdTimer) {
          this.logger?.logRoleEnd(cmdTimer, {
            gatePassed: false,
            gateReason: reason,
            attempt: 1,
            artifacts: cmdArtifacts,
          });
        }
        this.logger?.logGateResult(stage.name, false, reason);
        console.log(`  Command stage "${stage.name}" gate FAILED: ${reason}`);
        return { status: "blocked", stage: stage.name, reason };
      }
      if (cmdTimer) {
        this.logger?.logRoleEnd(cmdTimer, {
          gatePassed: true,
          gateReason: gateResult.reason,
          attempt: 1,
          artifacts: cmdArtifacts,
        });
      }
      this.logger?.logGateResult(stage.name, true, gateResult.reason);
    } else if (cmdTimer) {
      this.logger?.logRoleEnd(cmdTimer, {
        gatePassed: true,
        gateReason: "Command completed (no gate)",
        attempt: 1,
        artifacts: cmdArtifacts,
      });
      this.logger?.logGateResult(stage.name, true, "Command completed (no gate)");
    }

    console.log(`  Command stage "${stage.name}" completed`);
    void durationHint;
    return { status: "done" };
  }

  private async runRepeatBlock(
    block: { name: string; max_iterations: number; until: string; stages: import("../types.js").StageEntry[] },
    input: string,
    manifest: ArtifactManifest,
  ): Promise<RunResult> {
    // Only skip on the first iteration — after that run normally
    let skippingInner = !!this.skipTo && this.containsStage(block.stages, this.skipTo);
    let lastProgressSignature: RepeatProgressSignature | null = null;

    for (let iteration = 0; iteration < block.max_iterations; iteration++) {
      console.log(`  Repeat "${block.name}" iteration ${iteration + 1}/${block.max_iterations}...`);
      this.logger?.beginRepeatIteration(block.name, iteration + 1, block.max_iterations);

      let untilGateNotMet = false;

      for (const entry of block.stages) {
        // Skip-to support inside repeat blocks
        if (this.skipTo && skippingInner) {
          const name = isRepeatBlock(entry) ? entry.repeat.name : entry.name;
          if (name === this.skipTo) {
            skippingInner = false;
            console.log(`  Resuming from "${name}"...`);
          } else if (isRepeatBlock(entry) && this.containsStage(entry.repeat.stages, this.skipTo)) {
            skippingInner = false;
            console.log(`  Entering "${name}" to find "${this.skipTo}"...`);
          } else {
            console.log(`  Skipping "${name}" (resume mode)`);
            continue;
          }
        }

        let result: RunResult;
        if (isRepeatBlock(entry)) {
          result = await this.runRepeatBlock(entry.repeat, input, manifest);
        } else if (isCommandStage(entry)) {
          result = await this.runCommandStage(entry);
        } else {
          result = await this.runStage(entry, input, manifest);
        }
        if (result.status === "blocked") {
          const untilGate = this.gateResults.get(block.until);
          if (untilGate && !untilGate.passed) {
            const stagnation = this.detectRepeatStagnation(
              block,
              iteration + 1,
              lastProgressSignature,
            );
            if (stagnation.blocked) {
              this.logger?.endRepeatIteration("blocked");
              return {
                status: "blocked",
                stage: block.name,
                reason: stagnation.reason,
              };
            }
            lastProgressSignature = stagnation.signature;
            untilGateNotMet = true;
            break;
          }
          this.logger?.endRepeatIteration("blocked");
          return result;
        }
      }

      // After first iteration, stop skipping
      skippingInner = false;

      if (untilGateNotMet) {
        this.logger?.endRepeatIteration("failed");
        continue;
      }

      const gateDetail = this.gateResults.get(block.until);
      if (gateDetail?.passed) {
        this.logger?.endRepeatIteration("done");
        return { status: "done" };
      }

      const stagnation = this.detectRepeatStagnation(
        block,
        iteration + 1,
        lastProgressSignature,
      );
      if (stagnation.blocked) {
        this.logger?.endRepeatIteration("blocked");
        return {
          status: "blocked",
          stage: block.name,
          reason: stagnation.reason,
        };
      }
      lastProgressSignature = stagnation.signature;
      this.logger?.endRepeatIteration("failed");
    }

    // #69: max-iterations exit includes minimal patch list + resume guidance
    const exhaustion = this.buildRepeatExhaustion(block, manifest);
    return {
      status: "blocked",
      stage: block.name,
      reason: exhaustion.reason,
    };
  }

  /**
   * Collect last review evidence for until-gate (including archived attempts)
   * and format exhaustion report with minimal patch + resume guidance.
   */
  private buildRepeatExhaustion(
    block: {
      name: string;
      max_iterations: number;
      until: string;
      stages: import("../types.js").StageEntry[];
    },
    manifest: ArtifactManifest,
  ): { reason: string } {
    let lastReview: unknown;
    for (const entry of block.stages) {
      if (isRepeatBlock(entry) || isCommandStage(entry)) continue;
      for (const roleName of entry.roles) {
        const role = this.roles[roleName];
        const gate = role?.gate;
        if (!gate || gate.id !== block.until) continue;
        if (gate.contract?.type !== "review") continue;

        // Prefer live path; then manifest latest; then scan archived attempts/
        // (gate failures archive evidence even when agents omit paths from collect).
        const livePath = join(
          this.artifactBaseDir,
          resolveGatePath(gate.evidence.path, entry.name, roleName),
        );
        const fromManifest = manifest.latestPath(entry.name, roleName, "review.json");
        const fromArchive = this.findLatestArchivedReview(entry.name, roleName);
        const reviewPath = [livePath, fromManifest, fromArchive].find(
          (p): p is string => typeof p === "string" && existsSync(p),
        );
        if (!reviewPath) continue;
        try {
          lastReview = JSON.parse(readFileSync(reviewPath, "utf-8"));
        } catch {
          lastReview = undefined;
        }
      }
    }

    const report = buildExhaustionReport(lastReview, block.max_iterations);
    try {
      const outDir = join(this.artifactBaseDir, block.name);
      mkdirSync(outDir, { recursive: true });
      writeFileSync(
        join(outDir, "exhaustion.json"),
        JSON.stringify(report, null, 2) + "\n",
        "utf-8",
      );
    } catch {
      // best-effort artifact; reason string still carries the guidance
    }
    return { reason: report.reason };
  }

  /** Highest-numbered archived review.json under role attempts directory. */
  private findLatestArchivedReview(stage: string, role: string): string | null {
    const attemptsDir = join(this.artifactBaseDir, stage, role, "attempts");
    if (!existsSync(attemptsDir)) return null;
    let best: { n: number; path: string } | null = null;
    for (const name of readdirSync(attemptsDir)) {
      const n = Number(name);
      if (!Number.isInteger(n) || n < 1) continue;
      const candidate = join(attemptsDir, name, "review.json");
      if (!existsSync(candidate)) continue;
      if (!best || n > best.n) best = { n, path: candidate };
    }
    return best?.path ?? null;
  }

  private detectRepeatStagnation(
    block: { name: string; until: string; stages: import("../types.js").StageEntry[] },
    iteration: number,
    previous: RepeatProgressSignature | null,
  ): { blocked: boolean; reason?: string; signature: RepeatProgressSignature | null } {
    const signature = this.buildRepeatProgressSignature(block);
    if (!signature) {
      return { blocked: false, signature: null };
    }

    if (previous?.hash === signature.hash) {
      const files = signature.files.join(", ");
      return {
        blocked: true,
        signature,
        reason: `Repeat stagnation detected in "${block.name}" at iteration ${iteration}: non-until gate evidence is unchanged from the previous iteration (${files})`,
      };
    }

    return { blocked: false, signature };
  }

  private buildRepeatProgressSignature(
    block: { until: string; stages: import("../types.js").StageEntry[] },
  ): RepeatProgressSignature | null {
    const files = this.collectRepeatProgressEvidence(block.stages, block.until);
    if (files.length === 0) return null;

    const hash = createHash("sha256");
    const existing: string[] = [];
    for (const file of files.sort()) {
      try {
        const stat = statSync(file);
        if (!stat.isFile()) continue;
        hash.update(file);
        hash.update("\0");
        hash.update(readFileSync(file));
        hash.update("\0");
        existing.push(file);
      } catch {
        // Ignore missing/unreadable evidence files; gate checks report those separately.
      }
    }

    if (existing.length === 0) return null;
    return {
      hash: hash.digest("hex"),
      files: existing.map((file) => file.startsWith(this.artifactBaseDir)
        ? file.slice(this.artifactBaseDir.length + 1)
        : file),
    };
  }

  private collectRepeatProgressEvidence(
    entries: import("../types.js").StageEntry[],
    untilGateId: string,
  ): string[] {
    const files: string[] = [];

    for (const entry of entries) {
      if (isRepeatBlock(entry)) {
        files.push(...this.collectRepeatProgressEvidence(entry.repeat.stages, untilGateId));
        continue;
      }

      if (isCommandStage(entry)) continue;  // command stages have no role gates

      for (const roleName of entry.roles) {
        const gate = this.roles[roleName]?.gate;
        if (!gate || gate.id === untilGateId) continue;
        const resolvedPath = resolveGatePath(gate.evidence.path, entry.name, roleName);
        files.push(join(this.artifactBaseDir, resolvedPath));
      }
    }

    return files;
  }

  private snapshotRoleArtifacts(opts: {
    stage: string;
    role: string;
    attempt: number;
    artifactDir: string;
    artifacts: string[];
  }): string[] {
    if (!this.logger) return [];

    const files = resolveArtifactFiles(opts.artifactDir, opts.artifacts);
    if (files.length === 0) return [];

    const seq = String(++this.artifactSnapshotSeq).padStart(3, "0");
    const snapshotDir = join(
      this.logger.runDir,
      "artifacts",
      `${seq}-${safePathPart(opts.stage)}`,
      safePathPart(opts.role),
    );
    mkdirSync(snapshotDir, { recursive: true });

    const copied: string[] = [];
    for (const file of files) {
      const dest = uniqueDestination(snapshotDir, basename(file));
      try {
        copyFileSync(file, dest);
        copied.push(dest);
      } catch {
        // Best-effort archival should not affect pipeline execution.
      }
    }

    writeFileSync(join(snapshotDir, "_snapshot.json"), JSON.stringify({
      sequence: Number(seq),
      stage: opts.stage,
      role: opts.role,
      attempt: opts.attempt,
      source_artifact_dir: opts.artifactDir,
      source_files: files,
      copied_files: copied,
      created_at: new Date().toISOString(),
    }, null, 2), "utf-8");

    return copied;
  }

  private archiveRoleAttempt(
    manifest: ArtifactManifest,
    stage: string,
    role: string,
    attempt: number,
  ): void {
    const moved = archiveAttempt(join(this.artifactBaseDir, stage, role), attempt);
    for (const { from, to } of moved) manifest.relocate(from, to);
  }

  /**
   * Snapshot a command stage's output artifacts into the run directory.
   * Command stages have no role dimension, so the snapshot directory is
   * just artifacts/{seq}-{stage}/. Mirrors snapshotRoleArtifacts.
   */
  private snapshotCommandArtifacts(stageName: string, artifactDir: string): string[] {
    if (!this.logger) return [];

    const files = resolveArtifactFiles(artifactDir, []);
    if (files.length === 0) return [];

    const seq = String(++this.artifactSnapshotSeq).padStart(3, "0");
    const snapshotDir = join(
      this.logger.runDir,
      "artifacts",
      `${seq}-${safePathPart(stageName)}`,
    );
    mkdirSync(snapshotDir, { recursive: true });

    const copied: string[] = [];
    for (const file of files) {
      const dest = uniqueDestination(snapshotDir, basename(file));
      try {
        copyFileSync(file, dest);
        copied.push(dest);
      } catch {
        // Best-effort archival should not affect pipeline execution.
      }
    }

    writeFileSync(join(snapshotDir, "_snapshot.json"), JSON.stringify({
      sequence: Number(seq),
      stage: stageName,
      role: "command",
      attempt: 1,
      kind: "command",
      source_artifact_dir: artifactDir,
      source_files: files,
      copied_files: copied,
      created_at: new Date().toISOString(),
    }, null, 2), "utf-8");
    return copied;
  }
}

interface RepeatProgressSignature {
  hash: string;
  files: string[];
}

function resolveArtifactFiles(artifactDir: string, artifacts: string[]): string[] {
  const candidates = artifacts.length > 0
    ? artifacts.map((p) => isAbsolute(p) ? p : join(artifactDir, p))
    : readdirSync(artifactDir)
      .filter((entry) => entry !== "attempts" && !entry.startsWith("."))
      .map((entry) => join(artifactDir, entry));

  const seen = new Set<string>();
  const files: string[] = [];
  for (const file of candidates) {
    if (seen.has(file)) continue;
    seen.add(file);
    try {
      if (statSync(file).isFile()) files.push(file);
    } catch {
      // skip missing/non-readable paths
    }
  }
  return files;
}

function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "stage";
}

function uniqueDestination(dir: string, name: string): string {
  let candidate = join(dir, name);
  if (!existsSync(candidate)) return candidate;

  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let i = 2;
  while (existsSync(candidate)) {
    candidate = join(dir, `${stem}-${i}${ext}`);
    i++;
  }
  return candidate;
}

/**
 * Move files from artifactDir into artifactDir/attempts/{attemptNum}/.
 * Only moves top-level files, skips the "attempts" directory itself.
 */
function archiveAttempt(artifactDir: string, attemptNum: number): Array<{ from: string; to: string }> {
  if (!existsSync(artifactDir)) return [];

  const archiveDir = join(artifactDir, "attempts", String(attemptNum));
  const moved: Array<{ from: string; to: string }> = [];

  for (const entry of readdirSync(artifactDir)) {
    if (entry === "attempts" || entry.startsWith(".")) continue;
    const fullPath = join(artifactDir, entry);
    try {
      if (statSync(fullPath).isFile()) {
        mkdirSync(archiveDir, { recursive: true });
        const destination = join(archiveDir, entry);
        renameSync(fullPath, destination);
        moved.push({ from: fullPath, to: destination });
      }
    } catch { /* skip */ }
  }
  return moved;
}
