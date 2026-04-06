// src/engine/engine.ts

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ArtifactManifest } from "./manifest.js";
import { checkGates, type GateInput, type GateDetail } from "./gate.js";
import { buildContext } from "./context.js";
import { isRepeatBlock } from "../types.js";
import type { RunLogger } from "./logger.js";
import type {
  AgentProvider,
  PipelineConfig,
  StageConfig,
  LoadedRole,
  RunResult,
  AttemptRecord,
  GateStrategy,
} from "../types.js";

export interface EngineOptions {
  provider: AgentProvider;
  roles: Record<string, LoadedRole>;
  artifactBaseDir: string;
  defaultGateStrategy?: GateStrategy;
  defaultMaxRetries?: number;
  defaultTimeout?: number;  // agent execution timeout in ms (default: 600000 = 10 min)
  logger?: RunLogger;
}

export class Engine {
  private readonly provider: AgentProvider;
  private readonly roles: Record<string, LoadedRole>;
  private readonly artifactBaseDir: string;
  private readonly defaultGateStrategy: GateStrategy;
  private readonly defaultMaxRetries: number;
  private readonly defaultTimeout: number;
  private readonly logger?: RunLogger;

  // Gate registry: maps gate id → latest result
  private gateResults: Map<string, GateDetail> = new Map();
  private goal?: string;
  private requirements?: string[];

  constructor(opts: EngineOptions) {
    this.provider = opts.provider;
    this.roles = opts.roles;
    this.artifactBaseDir = opts.artifactBaseDir;
    this.defaultGateStrategy = opts.defaultGateStrategy ?? "all";
    this.defaultMaxRetries = opts.defaultMaxRetries ?? 3;
    this.defaultTimeout = opts.defaultTimeout ?? 600_000;
    this.logger = opts.logger;
  }

  async run(pipeline: PipelineConfig, input: string): Promise<RunResult> {
    this.goal = pipeline.goal;
    this.requirements = pipeline.requirements;
    this.gateResults.clear();
    const manifest = new ArtifactManifest(this.artifactBaseDir);

    for (const entry of pipeline.stages) {
      if (isRepeatBlock(entry)) {
        const result = await this.runRepeatBlock(entry.repeat, input, manifest);
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
    const attemptHistory: AttemptRecord[] = [];
    let failureContext = "";
    let lastFailureHash = "";

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      console.log(`  Stage "${stage.name}" attempt ${attempt + 1}/${maxRetries + 1}...`);
      this.logger?.logStageAttempt(stage.name, attempt + 1, maxRetries + 1);

      // Execute all roles in parallel
      const roleTimers: Array<{ roleName: string; timer: import("./logger.js").StageTimer; usage?: import("../types.js").AgentResult["usage"]; artifacts: string[] }> = [];

      let agentTimedOut = false;
      let timeoutMessage = "";

      try {
        await Promise.all(
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
              manifestText: manifest.formatForContext(),
              failureContext,
              attemptHistory,
            });

            const model = stage.overrides?.[roleName]?.model ?? role.model;
            const timer = this.logger?.logRoleStart(stage.name, roleName, model);

            const agent = this.provider.createAgent({
              persona: role.persona,
              skills: role.skills,
              context,
              artifactDir,
              model,
            });

            const agentTimeout = stage.timeout ?? this.defaultTimeout;
            const timeoutPromise = new Promise<never>((_, reject) => {
              const id = setTimeout(
                () => reject(new Error(`Agent timed out after ${agentTimeout}ms`)),
                agentTimeout,
              );
              // Allow the Node process to exit even if the timer is still pending
              if (typeof id === "object" && "unref" in id) (id as NodeJS.Timeout).unref();
            });

            const result = await Promise.race([agent.run(), timeoutPromise]);
            if (result.artifacts.length > 0) {
              manifest.collect(stage.name, roleName, result.artifacts);
            }

            if (timer) {
              roleTimers.push({ roleName, timer, usage: result.usage, artifacts: result.artifacts });
            }
          }),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("Agent timed out")) {
          agentTimedOut = true;
          timeoutMessage = message;
          console.log(`  Stage "${stage.name}" agent TIMED OUT: ${message}`);
        } else {
          throw err;  // re-throw non-timeout errors
        }
      }

      // If agent timed out, treat as a failed attempt
      if (agentTimedOut) {
        for (const roleName of stage.roles) {
          archiveAttempt(`${this.artifactBaseDir}/${stage.name}/${roleName}`, attempt + 1);
        }

        const failureReason = timeoutMessage;
        const failureHash = createHash("sha256")
          .update(failureReason)
          .digest("hex");

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
          usage: rt.usage,
          artifacts: rt.artifacts,
        });
      }
      this.logger?.logGateResult(stage.name, gateResult.passed, gateResult.reason);

      if (gateResult.passed) {
        console.log(`  Stage "${stage.name}" PASSED`);
        return { status: "done" };
      }

      console.log(`  Stage "${stage.name}" gate FAILED: ${gateResult.reason}`);

      // Archive failed attempt artifacts
      for (const roleName of stage.roles) {
        archiveAttempt(`${this.artifactBaseDir}/${stage.name}/${roleName}`, attempt + 1);
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

    return {
      status: "blocked",
      stage: stage.name,
      reason: `Max retries (${stage.max_retries ?? this.defaultMaxRetries}) exhausted`,
    };
  }

  private async runRepeatBlock(
    block: { name: string; max_iterations: number; until: string; stages: StageConfig[] },
    input: string,
    manifest: ArtifactManifest,
  ): Promise<RunResult> {
    for (let iteration = 0; iteration < block.max_iterations; iteration++) {
      console.log(`  Repeat "${block.name}" iteration ${iteration + 1}/${block.max_iterations}...`);

      let untilGateNotMet = false;

      // Run inner stages sequentially
      for (const stage of block.stages) {
        const result = await this.runStage(stage, input, manifest);
        if (result.status === "blocked") {
          // If the until gate was evaluated and failed, this means "goal not yet met"
          // — break out of inner stages and continue to the next iteration
          const untilGate = this.gateResults.get(block.until);
          if (untilGate && !untilGate.passed) {
            untilGateNotMet = true;
            break;
          }
          // Otherwise it's an unrelated stage failure — truly blocked
          return result;
        }
      }

      if (untilGateNotMet) {
        continue;
      }

      // Check until condition: look up gate id from registry
      const gateDetail = this.gateResults.get(block.until);
      if (gateDetail?.passed) {
        return { status: "done" };
      }
    }

    return {
      status: "blocked",
      stage: block.name,
      reason: `Max iterations (${block.max_iterations}) exhausted`,
    };
  }
}

/**
 * Move files from artifactDir into artifactDir/attempts/{attemptNum}/.
 * Only moves top-level files, skips the "attempts" directory itself.
 */
function archiveAttempt(artifactDir: string, attemptNum: number): void {
  if (!existsSync(artifactDir)) return;

  const archiveDir = join(artifactDir, "attempts", String(attemptNum));
  let hasFiles = false;

  for (const entry of readdirSync(artifactDir)) {
    if (entry === "attempts" || entry.startsWith(".")) continue;
    const fullPath = join(artifactDir, entry);
    try {
      if (statSync(fullPath).isFile()) {
        hasFiles = true;
        mkdirSync(archiveDir, { recursive: true });
        renameSync(fullPath, join(archiveDir, entry));
      }
    } catch { /* skip */ }
  }
}
