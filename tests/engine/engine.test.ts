import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  Engine,
  formatTimeoutExhaustionReason,
  shouldStagnateFailure,
} from "../../src/engine/engine.js";
import { RunLogger, loadRunLog } from "../../src/engine/logger.js";
import type {
  AgentConfig,
  AgentProvider,
  AgentResult,
  PetriAgent,
  PipelineConfig,
  LoadedRole,
  GateConfig,
} from "../../src/types.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "petri-engine-test-"));
}

function createStubProvider(
  artifactWriter: (config: AgentConfig) => void,
): AgentProvider {
  return {
    createAgent(config: AgentConfig): PetriAgent {
      return {
        async run(): Promise<AgentResult> {
          artifactWriter(config);
          return {
            artifacts: [],
            usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
          };
        },
      };
    },
  };
}

function makeGate(pathTemplate: string, check?: { field: string; equals?: unknown }): GateConfig {
  return {
    requires: {},
    evidence: {
      type: "artifact",
      path: pathTemplate,
      ...(check ? { check } : {}),
    },
  };
}

function makeRole(name: string, gate: GateConfig | null, provider?: string): LoadedRole {
  return {
    name,
    persona: `${name} persona`,
    model: "test-model",
    provider,
    playbooks: [],
    gate,
  };
}

describe("Engine", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("routes each role to its named provider and records it in the run log", async () => {
    const called: string[] = [];
    const makeProvider = (name: string): AgentProvider => createStubProvider(() => {
      called.push(name);
    });
    const logger = new RunLogger(tmpDir, "provider-routing", "input");
    const engine = new Engine({
      providers: { codex: makeProvider("codex"), reviewer: makeProvider("reviewer") },
      defaultProviderName: "codex",
      roles: {
        implementer: makeRole("implementer", null),
        reviewer: makeRole("reviewer", null, "reviewer"),
      },
      artifactBaseDir: path.join(tmpDir, "artifacts"),
      logger,
    });

    const result = await engine.run({
      name: "provider-routing",
      stages: [{ name: "work", roles: ["implementer", "reviewer"] }],
    }, "input");

    expect(result.status).toBe("done");
    expect(called).toEqual(expect.arrayContaining(["codex", "reviewer"]));
    logger.finish("done");
    expect(loadRunLog(logger.runDir)?.stages.map((stage) => stage.provider).sort()).toEqual(["codex", "reviewer"]);
  });

  it("runs 2-stage pipeline to completion", async () => {
    const gate = makeGate("{stage}/{role}/output.json", {
      field: "approved",
      equals: true,
    });
    const roles: Record<string, LoadedRole> = {
      writer: makeRole("writer", gate),
      reviewer: makeRole("reviewer", gate),
    };

    const provider = createStubProvider((config) => {
      // Write passing gate artifact for whatever stage/role combo
      // We infer role from persona
      const roleName = config.persona.replace(" persona", "");
      // We need to figure out the stage name — use a fixed approach
      for (const stageName of ["draft", "review"]) {
        const dir = path.join(tmpDir, stageName, roleName);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, "output.json"),
          JSON.stringify({ approved: true }),
        );
      }
    });

    const pipeline: PipelineConfig = {
      name: "test-pipeline",
      stages: [
        { name: "draft", roles: ["writer"], max_retries: 2 },
        { name: "review", roles: ["reviewer"], max_retries: 2 },
      ],
    };

    const engine = new Engine({
      provider,
      roles,
      artifactBaseDir: tmpDir,
    });

    const result = await engine.run(pipeline, "Write something");
    expect(result.status).toBe("done");
  });

  it("retries on gate failure then succeeds", async () => {
    let callCount = 0;
    const gate = makeGate("{stage}/{role}/output.json", {
      field: "approved",
      equals: true,
    });
    const roles: Record<string, LoadedRole> = {
      worker: makeRole("worker", gate),
    };

    const provider = createStubProvider(() => {
      callCount++;
      const dir = path.join(tmpDir, "work", "worker");
      fs.mkdirSync(dir, { recursive: true });
      // Fail first attempt, pass second
      const approved = callCount >= 2;
      fs.writeFileSync(
        path.join(dir, "output.json"),
        JSON.stringify({ approved }),
      );
    });

    const pipeline: PipelineConfig = {
      name: "test-pipeline",
      stages: [{ name: "work", roles: ["worker"], max_retries: 5 }],
    };

    const engine = new Engine({
      provider,
      roles,
      artifactBaseDir: tmpDir,
    });

    const result = await engine.run(pipeline, "Do work");
    expect(result.status).toBe("done");
    expect(callCount).toBe(2);
  });

  it("snapshots each role artifact into the run directory before retries overwrite it", async () => {
    let callCount = 0;
    const gate = makeGate("{stage}/{role}/output.json", {
      field: "approved",
      equals: true,
    });
    const roles: Record<string, LoadedRole> = {
      worker: makeRole("worker", gate),
    };

    const provider = createStubProvider(() => {
      callCount++;
      const dir = path.join(tmpDir, "artifacts", "work", "worker");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "output.json"),
        JSON.stringify({ approved: callCount >= 2, callCount }),
      );
    });

    const pipeline: PipelineConfig = {
      name: "test-pipeline",
      stages: [{ name: "work", roles: ["worker"], max_retries: 2 }],
    };
    const logger = new RunLogger(tmpDir, pipeline.name, "Do work");

    const engine = new Engine({
      provider,
      roles,
      artifactBaseDir: path.join(tmpDir, "artifacts"),
      logger,
    });

    const result = await engine.run(pipeline, "Do work");
    logger.finish(result.status, result.stage, result.reason);

    expect(result.status).toBe("done");
    const first = JSON.parse(fs.readFileSync(
      path.join(logger.runDir, "artifacts", "001-work", "worker", "output.json"),
      "utf-8",
    ));
    const second = JSON.parse(fs.readFileSync(
      path.join(logger.runDir, "artifacts", "002-work", "worker", "output.json"),
      "utf-8",
    ));
    const runLog = JSON.parse(fs.readFileSync(path.join(logger.runDir, "run.json"), "utf-8"));
    expect(first).toEqual({ approved: false, callCount: 1 });
    expect(second).toEqual({ approved: true, callCount: 2 });
    expect(runLog.stages.map((s: { attempt: number }) => s.attempt)).toEqual([1, 2]);
  });

  it("blocks after max_retries exhausted", async () => {
    const gate = makeGate("{stage}/{role}/output.json", {
      field: "approved",
      equals: true,
    });
    const roles: Record<string, LoadedRole> = {
      worker: makeRole("worker", gate),
    };

    let callCount = 0;
    const provider = createStubProvider(() => {
      callCount++;
      const dir = path.join(tmpDir, "work", "worker");
      fs.mkdirSync(dir, { recursive: true });
      // Always fail with different reasons so stagnation doesn't kick in
      fs.writeFileSync(
        path.join(dir, "output.json"),
        JSON.stringify({ approved: false, attempt: callCount }),
      );
    });

    const pipeline: PipelineConfig = {
      name: "test-pipeline",
      stages: [{ name: "work", roles: ["worker"], max_retries: 3 }],
    };

    const engine = new Engine({
      provider,
      roles,
      artifactBaseDir: tmpDir,
    });

    const result = await engine.run(pipeline, "Do work");
    expect(result.status).toBe("blocked");
  });

  it("detects stagnation and blocks early", async () => {
    const gate = makeGate("{stage}/{role}/output.json", {
      field: "approved",
      equals: true,
    });
    const roles: Record<string, LoadedRole> = {
      worker: makeRole("worker", gate),
    };

    let callCount = 0;
    const provider = createStubProvider(() => {
      callCount++;
      const dir = path.join(tmpDir, "work", "worker");
      fs.mkdirSync(dir, { recursive: true });
      // Always write same failing artifact — triggers stagnation
      fs.writeFileSync(
        path.join(dir, "output.json"),
        JSON.stringify({ approved: false }),
      );
    });

    const pipeline: PipelineConfig = {
      name: "test-pipeline",
      stages: [{ name: "work", roles: ["worker"], max_retries: 5 }],
    };

    const engine = new Engine({
      provider,
      roles,
      artifactBaseDir: tmpDir,
    });

    const result = await engine.run(pipeline, "Do work");
    expect(result.status).toBe("blocked");
    expect(result.reason).toMatch(/stagnation/i);
    // Should block after 2 attempts, not 5
    expect(callCount).toBe(2);
  });

  it("injects attempt history into context on retry", async () => {
    const gate = makeGate("{stage}/{role}/output.json", {
      field: "approved",
      equals: true,
    });
    const roles: Record<string, LoadedRole> = {
      worker: makeRole("worker", gate),
    };

    let callCount = 0;
    let capturedContext = "";
    const provider = createStubProvider((config) => {
      callCount++;
      if (callCount === 3) {
        capturedContext = config.context;
      }
      const dir = path.join(tmpDir, "work", "worker");
      fs.mkdirSync(dir, { recursive: true });
      if (callCount === 1) {
        // Attempt 1: no artifact file → "Artifact not found" failure
        // Don't write anything
        const filePath = path.join(dir, "output.json");
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } else if (callCount === 2) {
        // Attempt 2: wrong field value → different failure reason
        fs.writeFileSync(
          path.join(dir, "output.json"),
          JSON.stringify({ approved: false }),
        );
      } else {
        // Attempt 3: pass
        fs.writeFileSync(
          path.join(dir, "output.json"),
          JSON.stringify({ approved: true }),
        );
      }
    });

    const pipeline: PipelineConfig = {
      name: "test-pipeline",
      stages: [{ name: "work", roles: ["worker"], max_retries: 5 }],
    };

    const engine = new Engine({
      provider,
      roles,
      artifactBaseDir: tmpDir,
    });

    const result = await engine.run(pipeline, "Do work");
    expect(result.status).toBe("done");
    expect(callCount).toBe(3);
    expect(capturedContext).toContain("Attempt 1:");
    expect(capturedContext).toContain("Attempt 2:");
  });

  it("times out hanging agents and treats as failed attempt", async () => {
    const gate = makeGate("{stage}/{role}/output.json", {
      field: "approved",
      equals: true,
    });
    const roles: Record<string, LoadedRole> = {
      worker: makeRole("worker", gate),
    };

    // Provider whose agent.run() never resolves
    const hangingProvider: AgentProvider = {
      createAgent(): PetriAgent {
        return {
          run(): Promise<AgentResult> {
            return new Promise(() => {});  // never resolves
          },
        };
      },
    };

    const pipeline: PipelineConfig = {
      name: "test-pipeline",
      stages: [{ name: "work", roles: ["worker"], max_retries: 1, timeout: 100 }],
    };

    const engine = new Engine({
      provider: hangingProvider,
      roles,
      artifactBaseDir: tmpDir,
    });

    const result = await engine.run(pipeline, "Do work");
    expect(result.status).toBe("blocked");
    // #76: consecutive timeouts exhaust retries without gate-style stagnation
    expect(result.reason).toMatch(/timeout exhaustion|timed out|timeout/i);
    expect(result.reason).not.toMatch(/Stagnation detected: same failure repeated/);
  }, 10_000);

  it("aborts the agent signal when a stage attempt times out", async () => {
    let abortCount = 0;
    const gate = makeGate("{stage}/{role}/output.json", {
      field: "approved",
      equals: true,
    });
    const roles: Record<string, LoadedRole> = {
      worker: makeRole("worker", gate),
    };

    const abortAwareProvider: AgentProvider = {
      createAgent(): PetriAgent {
        return {
          run(signal?: AbortSignal): Promise<AgentResult> {
            return new Promise((_resolve, reject) => {
              signal?.addEventListener("abort", () => {
                abortCount++;
                reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
              }, { once: true });
            });
          },
        };
      },
    };

    const pipeline: PipelineConfig = {
      name: "test-pipeline",
      stages: [{ name: "work", roles: ["worker"], max_retries: 0, timeout: 100 }],
    };

    const engine = new Engine({
      provider: abortAwareProvider,
      roles,
      artifactBaseDir: tmpDir,
    });

    const result = await engine.run(pipeline, "Do work");
    expect(result.status).toBe("blocked");
    expect(result.reason).toMatch(/Max retries|timed out|timeout/i);
    expect(abortCount).toBe(1);
  }, 10_000);

  it("respects defaultTimeout from engine options", async () => {
    const gate = makeGate("{stage}/{role}/output.json", {
      field: "approved",
      equals: true,
    });
    const roles: Record<string, LoadedRole> = {
      worker: makeRole("worker", gate),
    };

    const hangingProvider: AgentProvider = {
      createAgent(): PetriAgent {
        return {
          run(): Promise<AgentResult> {
            return new Promise(() => {});
          },
        };
      },
    };

    const pipeline: PipelineConfig = {
      name: "test-pipeline",
      stages: [{ name: "work", roles: ["worker"], max_retries: 1 }],
    };

    const engine = new Engine({
      provider: hangingProvider,
      roles,
      artifactBaseDir: tmpDir,
      defaultTimeout: 100,
    });

    const result = await engine.run(pipeline, "Do work");
    expect(result.status).toBe("blocked");
    // #76: identical timeouts do not stagnate as "same failure repeated"
    expect(result.reason).toMatch(/timeout exhaustion|timed out|timeout/i);
    expect(result.reason).not.toMatch(/Stagnation detected: same failure repeated/);
  }, 10_000);

  it("settles a timed-out attempt within grace so the next attempt does not wait on the loser", async () => {
    const gate = makeGate("{stage}/{role}/output.json", {
      field: "approved",
      equals: true,
    });
    const roles: Record<string, LoadedRole> = {
      worker: makeRole("worker", gate),
    };

    let settledAfterAbort = false;
    let abortAt = 0;
    let settleAt = 0;
    // Provider that ignores abort for 30s (simulates stuck claude-code) — engine
    // must not wait on that full duration before ending the attempt.
    const slowAbortProvider: AgentProvider = {
      createAgent(): PetriAgent {
        return {
          run(signal?: AbortSignal): Promise<AgentResult> {
            return new Promise((_resolve, reject) => {
              signal?.addEventListener(
                "abort",
                () => {
                  abortAt = Date.now();
                  setTimeout(() => {
                    settleAt = Date.now();
                    settledAfterAbort = true;
                    reject(new Error("late provider settle after abort"));
                  }, 30_000);
                },
                { once: true },
              );
            });
          },
        };
      },
    };

    const pipeline: PipelineConfig = {
      name: "test-pipeline",
      stages: [{ name: "work", roles: ["worker"], max_retries: 0, timeout: 80 }],
    };

    const engine = new Engine({
      provider: slowAbortProvider,
      roles,
      artifactBaseDir: tmpDir,
    });

    const t0 = Date.now();
    const result = await engine.run(pipeline, "Do work");
    const elapsed = Date.now() - t0;

    expect(result.status).toBe("blocked");
    expect(result.reason).toMatch(/timed out|timeout|Max retries|budget|Stagnation/i);
    // Attempt must finish well under the provider's 30s post-abort hang.
    expect(elapsed).toBeLessThan(8_000);
    expect(abortAt).toBeGreaterThan(0);
    // Engine may finish before the late settle; that is the point of grace settle.
    if (settledAfterAbort) {
      expect(settleAt - abortAt).toBeLessThan(30_000);
    }
  }, 15_000);

  it("enforces a hard stage wall-clock budget so hanging providers cannot stall for hours", async () => {
    const gate = makeGate("{stage}/{role}/output.json", {
      field: "approved",
      equals: true,
    });
    const roles: Record<string, LoadedRole> = {
      worker: makeRole("worker", gate),
    };

    // Provider that never honors abort and never resolves — only the stage
    // wall-clock budget can bound the run (issue #6 criterion 3).
    const immortalProvider: AgentProvider = {
      createAgent(): PetriAgent {
        return {
          run(): Promise<AgentResult> {
            return new Promise(() => {});
          },
        };
      },
    };

    const pipeline: PipelineConfig = {
      name: "test-pipeline",
      // 2 attempts × 100ms timeout — wall-clock must stay on the order of
      // (max_retries+1)*(timeout+settleGrace), not multi-minute.
      stages: [{ name: "work", roles: ["worker"], max_retries: 1, timeout: 100 }],
    };

    const engine = new Engine({
      provider: immortalProvider,
      roles,
      artifactBaseDir: tmpDir,
    });

    const t0 = Date.now();
    const result = await engine.run(pipeline, "Do work");
    const elapsed = Date.now() - t0;

    expect(result.status).toBe("blocked");
    expect(result.reason).toMatch(/timed out|timeout|timeout exhaustion|budget|wall-clock/i);
    expect(result.reason).not.toMatch(/Stagnation detected: same failure repeated/);
    // With timeout=100 and max_retries=1, budget is a few seconds max.
    expect(elapsed).toBeLessThan(6_000);
  }, 15_000);

  it("issue #76: two consecutive timeouts never report gate stagnation", async () => {
    const gate = makeGate("{stage}/{role}/output.json", {
      field: "approved",
      equals: true,
    });
    const roles: Record<string, LoadedRole> = {
      worker: makeRole("worker", gate),
    };
    const hangingProvider: AgentProvider = {
      createAgent(): PetriAgent {
        return {
          run(): Promise<AgentResult> {
            return new Promise(() => {});
          },
        };
      },
    };
    const pipeline: PipelineConfig = {
      name: "test-pipeline",
      stages: [{ name: "develop", roles: ["worker"], max_retries: 2, timeout: 80 }],
    };
    const engine = new Engine({
      provider: hangingProvider,
      roles,
      artifactBaseDir: tmpDir,
    });
    const result = await engine.run(pipeline, "implement");
    expect(result.status).toBe("blocked");
    expect(result.reason).toMatch(/timeout exhaustion/i);
    expect(result.reason).toMatch(/--skip-to develop/);
    expect(result.reason).toMatch(/--resume-run/);
    expect(result.reason).not.toMatch(/Stagnation detected: same failure repeated/);
  }, 15_000);

  it("issue #76 policy helpers: timeout never stagnates; gate hash can", () => {
    expect(
      shouldStagnateFailure({
        kind: "timeout",
        sameAsPreviousGateHash: true,
        attemptIndex: 1,
      }),
    ).toBe(false);
    expect(
      shouldStagnateFailure({
        kind: "gate",
        sameAsPreviousGateHash: true,
        attemptIndex: 1,
      }),
    ).toBe(true);
    expect(
      shouldStagnateFailure({
        kind: "gate",
        sameAsPreviousGateHash: false,
        attemptIndex: 1,
      }),
    ).toBe(false);
    expect(formatTimeoutExhaustionReason("develop", 5)).toMatch(/timeout exhaustion/);
    expect(formatTimeoutExhaustionReason("develop", 5)).toMatch(/--skip-to develop/);
  });

  it("issue #76: code-dev develop default timeout is at least 20 minutes", () => {
    const yamlPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "../../src/templates/code-dev/pipeline.yaml",
    );
    // fileURL path on mac may need decode — use path from cwd relative
    const yaml = fs.readFileSync(
      path.join(process.cwd(), "src/templates/code-dev/pipeline.yaml"),
      "utf-8",
    );
    // Find develop stage timeout
    const developBlock = yaml.match(
      /- name: develop\n(?:[^\n]*\n)*?\s+timeout:\s*(\d+)/,
    );
    expect(developBlock).not.toBeNull();
    const ms = Number(developBlock![1]);
    expect(ms).toBeGreaterThanOrEqual(1_200_000);
  });

  it("runs nested repeat blocks", async () => {
    const innerGate: GateConfig = {
      id: "inner-done",
      evidence: {
        path: "{stage}/{role}/output.json",
        check: { field: "inner_done", equals: true },
      },
    };
    const outerGate: GateConfig = {
      id: "outer-done",
      evidence: {
        path: "{stage}/{role}/output.json",
        check: { field: "outer_done", equals: true },
      },
    };
    const roles: Record<string, LoadedRole> = {
      inner_worker: makeRole("inner_worker", innerGate),
      outer_checker: makeRole("outer_checker", outerGate),
    };

    let innerCallCount = 0;
    let outerCallCount = 0;
    const provider = createStubProvider((config) => {
      if (config.persona === "inner_worker persona") {
        innerCallCount++;
        const dir = path.join(tmpDir, "inner_step", "inner_worker");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, "output.json"),
          JSON.stringify({ inner_done: innerCallCount % 2 === 0 }),
        );
      } else {
        outerCallCount++;
        const dir = path.join(tmpDir, "outer_check", "outer_checker");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, "output.json"),
          JSON.stringify({ outer_done: outerCallCount >= 2 }),
        );
      }
    });

    const pipeline: PipelineConfig = {
      name: "test-nested",
      stages: [
        {
          repeat: {
            name: "outer",
            max_iterations: 5,
            until: "outer-done",
            stages: [
              {
                repeat: {
                  name: "inner",
                  max_iterations: 5,
                  until: "inner-done",
                  stages: [
                    { name: "inner_step", roles: ["inner_worker"], max_retries: 0 },
                  ],
                },
              },
              { name: "outer_check", roles: ["outer_checker"], max_retries: 0 },
            ],
          },
        },
      ],
    };

    const engine = new Engine({
      provider,
      roles,
      artifactBaseDir: tmpDir,
    });

    const result = await engine.run(pipeline, "Nested iterate");
    expect(result.status).toBe("done");
    expect(outerCallCount).toBe(2);
    expect(innerCallCount).toBe(4);
  });

  it("runs a repeat block", async () => {
    // Gate checks {stage}/{role}/output.json with field target_met === true
    const gate: GateConfig = {
      id: "target-met",
      evidence: {
        path: "{stage}/{role}/output.json",
        check: { field: "target_met", equals: true },
      },
    };
    const roles: Record<string, LoadedRole> = {
      worker: makeRole("worker", gate),
    };

    let iterationCount = 0;
    const provider = createStubProvider(() => {
      iterationCount++;
      const dir = path.join(tmpDir, "step", "worker");
      fs.mkdirSync(dir, { recursive: true });
      // Gate passes only on iteration >= 2
      fs.writeFileSync(
        path.join(dir, "output.json"),
        JSON.stringify({ target_met: iterationCount >= 2 }),
      );
    });

    const pipeline: PipelineConfig = {
      name: "test-pipeline",
      stages: [
        {
          repeat: {
            name: "iterate",
            max_iterations: 5,
            until: "target-met",
            stages: [{ name: "step", roles: ["worker"], max_retries: 2 }],
          },
        },
      ],
    };

    const engine = new Engine({
      provider,
      roles,
      artifactBaseDir: tmpDir,
    });

    const result = await engine.run(pipeline, "Iterate");
    expect(result.status).toBe("done");
    expect(iterationCount).toBe(2);
  });

  it("blocks a repeat loop when non-until gate evidence is unchanged", async () => {
    const designGate: GateConfig = {
      id: "strategy-designed",
      evidence: {
        path: "design/designer/spec.json",
        check: { field: "ready", equals: true },
      },
    };
    const reviewGate: GateConfig = {
      id: "review-approved",
      evidence: {
        path: "review/reviewer/verdict.json",
        check: { field: "approved", equals: true },
      },
    };
    const roles: Record<string, LoadedRole> = {
      designer: makeRole("designer", designGate),
      reviewer: makeRole("reviewer", reviewGate),
    };

    let designCalls = 0;
    let reviewCalls = 0;
    const provider = createStubProvider((config) => {
      if (config.persona === "designer persona") {
        designCalls++;
        const dir = path.join(tmpDir, "design", "designer");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, "spec.json"),
          JSON.stringify({ ready: true, lookback_months: 6, top_k: 1 }),
        );
      } else {
        reviewCalls++;
        const dir = path.join(tmpDir, "review", "reviewer");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, "verdict.json"),
          JSON.stringify({
            approved: false,
            feedback: { improvement_suggestions: [`change-${reviewCalls}`] },
          }),
        );
      }
    });

    const pipeline: PipelineConfig = {
      name: "test-stagnating-repeat",
      stages: [
        {
          repeat: {
            name: "design-review-loop",
            max_iterations: 6,
            until: "review-approved",
            stages: [
              { name: "design", roles: ["designer"], max_retries: 0 },
              { name: "review", roles: ["reviewer"], max_retries: 0 },
            ],
          },
        },
      ],
    };

    const engine = new Engine({
      provider,
      roles,
      artifactBaseDir: tmpDir,
    });

    const result = await engine.run(pipeline, "Iterate");
    expect(result.status).toBe("blocked");
    expect(result.stage).toBe("design-review-loop");
    expect(result.reason).toMatch(/Repeat stagnation detected/i);
    expect(designCalls).toBe(2);
    expect(reviewCalls).toBe(2);
  });

  it("clears stale stage dirs from a previously-run pipeline at run start", async () => {
    // Simulate leftover artifacts from a different earlier pipeline that used
    // stages "propose" / "baseline", plus a stale role subdir inside "draft"
    // (a stage name shared with the current pipeline).
    fs.mkdirSync(path.join(tmpDir, "propose", "strategist"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "propose", "strategist", "proposal.json"), "stale");
    fs.mkdirSync(path.join(tmpDir, "baseline"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "baseline", "old.json"), "stale");
    fs.mkdirSync(path.join(tmpDir, "draft", "old_role"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "draft", "old_role", "leftover.json"), "stale");
    fs.writeFileSync(path.join(tmpDir, "manifest.json"), "stale-manifest");

    const gate = makeGate("{stage}/{role}/output.json", { field: "approved", equals: true });
    const roles: Record<string, LoadedRole> = { writer: makeRole("writer", gate) };

    const provider = createStubProvider(() => {
      const dir = path.join(tmpDir, "draft", "writer");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "output.json"), JSON.stringify({ approved: true }));
    });

    const pipeline: PipelineConfig = {
      name: "current",
      stages: [{ name: "draft", roles: ["writer"], max_retries: 1 }],
    };
    const engine = new Engine({ provider, roles, artifactBaseDir: tmpDir });

    const result = await engine.run(pipeline, "go");
    expect(result.status).toBe("done");
    // Out-of-pipeline subdirs are removed
    expect(fs.existsSync(path.join(tmpDir, "propose"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "baseline"))).toBe(false);
    // Stale role subdir under a current-pipeline stage is removed
    expect(fs.existsSync(path.join(tmpDir, "draft", "old_role"))).toBe(false);
    // Current run's role artifact is present
    expect(fs.existsSync(path.join(tmpDir, "draft", "writer", "output.json"))).toBe(true);
  });

  it("runs a command stage to completion (exit 0)", async () => {
    const pipeline: PipelineConfig = {
      name: "cmd-pipeline",
      stages: [{ name: "measure", command: "exit 0" }],
    };
    const engine = new Engine({
      provider: createStubProvider(() => {}),
      roles: {},
      artifactBaseDir: tmpDir,
    });
    const result = await engine.run(pipeline, "go");
    expect(result.status).toBe("done");
  });

  it("blocks the run when a command stage exits non-zero", async () => {
    const pipeline: PipelineConfig = {
      name: "cmd-pipeline",
      stages: [{ name: "measure", command: "exit 1" }],
    };
    const engine = new Engine({
      provider: createStubProvider(() => {}),
      roles: {},
      artifactBaseDir: tmpDir,
    });
    const result = await engine.run(pipeline, "go");
    expect(result.status).toBe("blocked");
    expect(result.stage).toBe("measure");
    expect(result.reason).toMatch(/Command exec failed/i);
    expect(result.reason).toContain("exit 1");
  });

  it("runs a multi-line fold-style command as one script (issue #57)", async () => {
    const pipeline: PipelineConfig = {
      name: "cmd-pipeline",
      stages: [{ name: "measure", command: "echo\n  ok_line1 > {artifact_dir}/out.txt" }],
    };
    const engine = new Engine({
      provider: createStubProvider(() => {}),
      roles: {},
      artifactBaseDir: tmpDir,
    });
    const result = await engine.run(pipeline, "go");
    expect(result.status).toBe("done");
    expect(fs.readFileSync(path.join(tmpDir, "measure", "out.txt"), "utf-8").trim()).toBe("ok_line1");
  });

  it("includes full prepared command on multi-line exec failure (issue #57)", async () => {
    const pipeline: PipelineConfig = {
      name: "cmd-pipeline",
      stages: [{ name: "measure", command: "exit\n  1" }],
    };
    const engine = new Engine({
      provider: createStubProvider(() => {}),
      roles: {},
      artifactBaseDir: tmpDir,
    });
    const result = await engine.run(pipeline, "go");
    expect(result.status).toBe("blocked");
    expect(result.reason).toMatch(/Command exec failed/i);
    expect(result.reason).toContain("exit 1");
  });

  it("blocks with Command config failed when command is empty after normalize", async () => {
    const pipeline: PipelineConfig = {
      name: "cmd-pipeline",
      stages: [{ name: "measure", command: "   \n  " }],
    };
    const engine = new Engine({
      provider: createStubProvider(() => {}),
      roles: {},
      artifactBaseDir: tmpDir,
    });
    const result = await engine.run(pipeline, "go");
    expect(result.status).toBe("blocked");
    expect(result.reason).toMatch(/Command config failed/i);
  });

  it("uses Command gate failed prefix when exit 0 but gate rejects (issue #57)", async () => {
    const pipeline: PipelineConfig = {
      name: "cmd-pipeline",
      stages: [
        {
          name: "measure",
          command: `echo '{"ok": false}' > {artifact_dir}/result.json`,
          gate: {
            id: "measured",
            evidence: {
              path: "{stage}/result.json",
              check: { field: "ok", equals: true },
            },
          },
        },
      ],
    };
    const engine = new Engine({
      provider: createStubProvider(() => {}),
      roles: {},
      artifactBaseDir: tmpDir,
    });
    const result = await engine.run(pipeline, "go");
    expect(result.status).toBe("blocked");
    expect(result.reason).toMatch(/Command gate failed/i);
    expect(result.reason).not.toMatch(/Command exec failed/i);
  });

  it("substitutes {artifact_dir} and creates the command stage artifact dir", async () => {
    const pipeline: PipelineConfig = {
      name: "cmd-pipeline",
      stages: [{ name: "measure", command: "echo hi > {artifact_dir}/out.txt" }],
    };
    const engine = new Engine({
      provider: createStubProvider(() => {}),
      roles: {},
      artifactBaseDir: tmpDir,
    });
    const result = await engine.run(pipeline, "go");
    expect(result.status).toBe("done");
    expect(fs.existsSync(path.join(tmpDir, "measure", "out.txt"))).toBe(true);
  });

  it("runs a command stage on every iteration of a repeat block", async () => {
    // A repeat block with only a command stage has no until-gate evidence,
    // so it runs to max_iterations and then blocks. We assert the command
    // executed once per iteration.
    const pipeline: PipelineConfig = {
      name: "cmd-repeat",
      stages: [
        {
          repeat: {
            name: "loop",
            max_iterations: 3,
            until: "never-set",
            stages: [
              { name: "tick", command: "echo x >> {artifact_dir}/runs.txt" },
            ],
          },
        },
      ],
    };
    const engine = new Engine({
      provider: createStubProvider(() => {}),
      roles: {},
      artifactBaseDir: tmpDir,
    });
    const result = await engine.run(pipeline, "go");
    expect(result.status).toBe("blocked");
    const runs = fs.readFileSync(path.join(tmpDir, "tick", "runs.txt"), "utf-8");
    expect(runs.trim().split("\n")).toHaveLength(3);
  });

  it("preserves stale artifacts when resuming via skipTo", async () => {
    // skipTo intentionally reuses previous run's artifacts as inputs to later stages
    fs.mkdirSync(path.join(tmpDir, "draft", "writer"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "draft", "writer", "output.json"),
      JSON.stringify({ approved: true }),
    );

    const gate = makeGate("{stage}/{role}/output.json", { field: "approved", equals: true });
    const roles: Record<string, LoadedRole> = {
      writer: makeRole("writer", gate),
      reviewer: makeRole("reviewer", gate),
    };

    const provider = createStubProvider((config) => {
      const roleName = config.persona.replace(" persona", "");
      const dir = path.join(tmpDir, "review", roleName);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "output.json"), JSON.stringify({ approved: true }));
    });

    const pipeline: PipelineConfig = {
      name: "current",
      stages: [
        { name: "draft", roles: ["writer"], max_retries: 1 },
        { name: "review", roles: ["reviewer"], max_retries: 1 },
      ],
    };
    const engine = new Engine({ provider, roles, artifactBaseDir: tmpDir, skipTo: "review" });

    const result = await engine.run(pipeline, "resume");
    expect(result.status).toBe("done");
    // Earlier stage's artifact still present (resume relies on it)
    expect(fs.existsSync(path.join(tmpDir, "draft", "writer", "output.json"))).toBe(true);
  });

  it("a command stage with a passing gate completes the run", async () => {
    const pipeline: PipelineConfig = {
      name: "gated-cmd",
      stages: [
        {
          name: "measure",
          command: "echo '{\"ok\": true}' > {artifact_dir}/result.json",
          gate: {
            id: "measured",
            evidence: { path: "{stage}/result.json", check: { field: "ok", equals: true } },
          },
        },
      ],
    };
    const engine = new Engine({
      provider: createStubProvider(() => {}),
      roles: {},
      artifactBaseDir: tmpDir,
    });
    const result = await engine.run(pipeline, "go");
    expect(result.status).toBe("done");
  });

  it("a command stage with a failing gate blocks the run", async () => {
    const pipeline: PipelineConfig = {
      name: "gated-cmd",
      stages: [
        {
          name: "measure",
          command: "echo '{\"ok\": false}' > {artifact_dir}/result.json",
          gate: {
            id: "measured",
            evidence: { path: "{stage}/result.json", check: { field: "ok", equals: true } },
          },
        },
      ],
    };
    const engine = new Engine({
      provider: createStubProvider(() => {}),
      roles: {},
      artifactBaseDir: tmpDir,
    });
    const result = await engine.run(pipeline, "go");
    expect(result.status).toBe("blocked");
    expect(result.stage).toBe("measure");
    expect(result.reason).toMatch(/ok/);
  });

  it("a command stage gate satisfies a repeat block's until condition", async () => {
    const pipeline: PipelineConfig = {
      name: "gated-cmd-repeat",
      stages: [
        {
          repeat: {
            name: "loop",
            max_iterations: 3,
            until: "measured",
            stages: [
              {
                name: "measure",
                command: "echo '{\"ok\": true}' > {artifact_dir}/result.json",
                gate: {
                  id: "measured",
                  evidence: { path: "{stage}/result.json", check: { field: "ok", equals: true } },
                },
              },
            ],
          },
        },
      ],
    };
    const engine = new Engine({
      provider: createStubProvider(() => {}),
      roles: {},
      artifactBaseDir: tmpDir,
    });
    const result = await engine.run(pipeline, "go");
    expect(result.status).toBe("done");
  });

  it("snapshots a command stage's output into the run directory", async () => {
    const pipeline: PipelineConfig = {
      name: "cmd-snapshot",
      stages: [
        { name: "measure", command: "echo '{\"ok\": true}' > {artifact_dir}/result.json" },
      ],
    };
    const logger = new RunLogger(tmpDir, pipeline.name, "go");
    const engine = new Engine({
      provider: createStubProvider(() => {}),
      roles: {},
      artifactBaseDir: path.join(tmpDir, "artifacts"),
      logger,
    });
    const result = await engine.run(pipeline, "go");
    logger.finish(result.status, result.stage, result.reason);

    expect(result.status).toBe("done");
    const snapshot = path.join(logger.runDir, "artifacts", "001-measure", "result.json");
    expect(fs.existsSync(snapshot)).toBe(true);
    expect(JSON.parse(fs.readFileSync(snapshot, "utf-8"))).toEqual({ ok: true });
    // StageLog must bind snapshot paths for web attempt panels (issue #18)
    const runLog = JSON.parse(fs.readFileSync(path.join(logger.runDir, "run.json"), "utf-8"));
    const cmdEntry = runLog.stages.find((s: { role: string }) => s.role === "command");
    expect(cmdEntry).toBeDefined();
    expect(Array.isArray(cmdEntry.artifacts)).toBe(true);
    expect(cmdEntry.artifacts.length).toBeGreaterThan(0);
    expect(cmdEntry.artifacts.some((a: string) => a.includes("result.json"))).toBe(true);
  });

  it("on max_iterations exhaust emits minimal patch list and resume guidance (#69)", async () => {
    const reviewGate: GateConfig = {
      id: "review-approved",
      contract: { type: "review" },
      evidence: {
        path: "{stage}/{role}/review.json",
        check: { field: "approved", equals: true },
      },
    };
    const roles: Record<string, LoadedRole> = {
      reviewer: makeRole("reviewer", reviewGate),
    };

    const provider = createStubProvider(() => {
      const dir = path.join(tmpDir, "review", "reviewer");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "review.json"),
        JSON.stringify({
          approved: false,
          findings: [
            {
              id: "F-007",
              severity: "HIGH",
              description: "export blocked",
              blocks_approval: true,
              file: "src/export.ts",
            },
            { id: "F-006", severity: "MEDIUM", description: "nit" },
          ],
          previous_findings: [],
          acceptance: [{ id: "S1", status: "passed" }],
        }),
      );
    });

    const pipeline: PipelineConfig = {
      name: "exhaust-pipeline",
      stages: [
        {
          repeat: {
            name: "develop-review-cycle",
            max_iterations: 2,
            until: "review-approved",
            stages: [{ name: "review", roles: ["reviewer"], max_retries: 0 }],
          },
        },
      ],
    };

    const engine = new Engine({
      provider,
      roles,
      artifactBaseDir: tmpDir,
    });

    const result = await engine.run(pipeline, "Exhaust");
    expect(result.status).toBe("blocked");
    expect(result.stage).toBe("develop-review-cycle");
    expect(result.reason).toMatch(/Max iterations \(2\) exhausted/i);
    expect(result.reason).toMatch(/F-007/);
    expect(result.reason).toMatch(/skip-to develop|--skip-to/i);
    expect(result.reason).not.toMatch(/F-006/);

    const exhaustionPath = path.join(tmpDir, "develop-review-cycle", "exhaustion.json");
    expect(fs.existsSync(exhaustionPath)).toBe(true);
    const report = JSON.parse(fs.readFileSync(exhaustionPath, "utf-8"));
    expect(report.minimal_patch).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "F-007", severity: "HIGH" }),
      ]),
    );
    expect(report.resume_hint).toMatch(/--skip-to develop/);
  });
});
