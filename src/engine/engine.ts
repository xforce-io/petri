// src/engine/engine.ts

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, existsSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { ArtifactManifest } from "./manifest.js";
import { checkGates, resolveGatePath, type GateInput, type GateDetail } from "./gate.js";
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
  skipTo?: string;  // stage name to resume from — skips all stages before it
}

export class Engine {
  private readonly provider: AgentProvider;
  private readonly roles: Record<string, LoadedRole>;
  private readonly artifactBaseDir: string;
  private readonly defaultGateStrategy: GateStrategy;
  private readonly defaultMaxRetries: number;
  private readonly defaultTimeout: number;
  private readonly logger?: RunLogger;
  private readonly skipTo?: string;

  // Gate registry: maps gate id → latest result
  private gateResults: Map<string, GateDetail> = new Map();
  private goal?: string;
  private requirements?: string[];
  private artifactSnapshotSeq = 0;

  constructor(opts: EngineOptions) {
    this.provider = opts.provider;
    this.roles = opts.roles;
    this.artifactBaseDir = opts.artifactBaseDir;
    this.defaultGateStrategy = opts.defaultGateStrategy ?? "all";
    this.defaultMaxRetries = opts.defaultMaxRetries ?? 3;
    this.defaultTimeout = opts.defaultTimeout ?? 600_000;
    this.logger = opts.logger;
    this.skipTo = opts.skipTo;
  }

  async run(pipeline: PipelineConfig, input: string): Promise<RunResult> {
    this.goal = pipeline.goal;
    this.requirements = pipeline.requirements;
    this.gateResults.clear();

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
                playbooks: role.playbooks,
                context,
                artifactDir,
                model,
              timeout: stage.timeout ?? this.defaultTimeout,
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
          attempt: attempt + 1,
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
    block: { name: string; max_iterations: number; until: string; stages: import("../types.js").StageEntry[] },
    input: string,
    manifest: ArtifactManifest,
  ): Promise<RunResult> {
    // Only skip on the first iteration — after that run normally
    let skippingInner = !!this.skipTo && this.containsStage(block.stages, this.skipTo);
    let lastProgressSignature: RepeatProgressSignature | null = null;

    for (let iteration = 0; iteration < block.max_iterations; iteration++) {
      console.log(`  Repeat "${block.name}" iteration ${iteration + 1}/${block.max_iterations}...`);

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
          return result;
        }
      }

      // After first iteration, stop skipping
      skippingInner = false;

      if (untilGateNotMet) {
        continue;
      }

      const gateDetail = this.gateResults.get(block.until);
      if (gateDetail?.passed) {
        return { status: "done" };
      }

      const stagnation = this.detectRepeatStagnation(
        block,
        iteration + 1,
        lastProgressSignature,
      );
      if (stagnation.blocked) {
        return {
          status: "blocked",
          stage: block.name,
          reason: stagnation.reason,
        };
      }
      lastProgressSignature = stagnation.signature;
    }

    return {
      status: "blocked",
      stage: block.name,
      reason: `Max iterations (${block.max_iterations}) exhausted`,
    };
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
