// src/engine/engine.ts

import { createHash } from "node:crypto";
import { ArtifactManifest } from "./manifest.js";
import { checkGates, type GateInput } from "./gate.js";
import { buildContext } from "./context.js";
import { isRepeatBlock } from "../types.js";
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
}

export class Engine {
  private readonly provider: AgentProvider;
  private readonly roles: Record<string, LoadedRole>;
  private readonly artifactBaseDir: string;
  private readonly defaultGateStrategy: GateStrategy;
  private readonly defaultMaxRetries: number;

  constructor(opts: EngineOptions) {
    this.provider = opts.provider;
    this.roles = opts.roles;
    this.artifactBaseDir = opts.artifactBaseDir;
    this.defaultGateStrategy = opts.defaultGateStrategy ?? "all";
    this.defaultMaxRetries = opts.defaultMaxRetries ?? 3;
  }

  async run(pipeline: PipelineConfig, input: string): Promise<RunResult> {
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
    return { status: "done" };
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
      // Execute all roles in parallel
      await Promise.all(
        stage.roles.map(async (roleName) => {
          const role = this.roles[roleName];
          if (!role) return;

          const artifactDir = this.artifactBaseDir;
          const context = buildContext({
            input,
            artifactDir,
            manifestText: manifest.formatForContext(),
            failureContext,
            attemptHistory,
          });

          const model = stage.overrides?.[roleName]?.model ?? role.model;

          const agent = this.provider.createAgent({
            persona: role.persona,
            skills: role.skills,
            context,
            artifactDir,
            model,
          });

          const result = await agent.run();
          if (result.artifacts.length > 0) {
            manifest.collect(stage.name, roleName, result.artifacts);
          }
        }),
      );

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

      if (gateResult.passed) {
        return { status: "done" };
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
    block: { name: string; max_iterations: number; until: { artifact: string; field: string; equals: unknown }; stages: StageConfig[] },
    input: string,
    manifest: ArtifactManifest,
  ): Promise<RunResult> {
    for (let iteration = 0; iteration < block.max_iterations; iteration++) {
      // Run inner stages sequentially
      for (const stage of block.stages) {
        const result = await this.runStage(stage, input, manifest);
        if (result.status === "blocked") {
          return result;
        }
      }

      // Check until condition
      const { artifact, field, equals } = block.until;
      const fs = await import("node:fs");
      const path = await import("node:path");
      const artifactPath = path.join(this.artifactBaseDir, artifact);

      if (fs.existsSync(artifactPath)) {
        try {
          const content = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));
          if (content[field] === equals) {
            return { status: "done" };
          }
        } catch {
          // JSON parse error — continue iterating
        }
      }
    }

    return {
      status: "blocked",
      stage: block.name,
      reason: `Max iterations (${block.max_iterations}) exhausted`,
    };
  }
}
