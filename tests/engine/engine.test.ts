import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Engine } from "../../src/engine/engine.js";
import { RunLogger } from "../../src/engine/logger.js";
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

function makeRole(name: string, gate: GateConfig | null): LoadedRole {
  return {
    name,
    persona: `${name} persona`,
    model: "test-model",
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
    expect(result.reason).toMatch(/timed out|timeout|Stagnation/i);
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
    // With identical timeout failures, stagnation detection kicks in
    expect(result.reason).toMatch(/timed out|timeout|Stagnation/i);
  }, 10_000);

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
});
