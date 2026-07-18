import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import {
  loadPetriConfig,
  loadPipelineConfig,
  loadRole,
  collectRoleNames,
} from "../src/config/loader.js";
import { Engine } from "../src/engine/engine.js";
import { isRepeatBlock, isCommandStage } from "../src/types.js";
import type {
  AgentProvider,
  PetriAgent,
  AgentConfig,
  AgentResult,
  LoadedRole,
  StageEntry,
} from "../src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templateDir = path.join(__dirname, "..", "src", "templates", "code-dev");

function walkStages(entries: StageEntry[], visit: (e: StageEntry) => void): void {
  for (const entry of entries) {
    visit(entry);
    if (isRepeatBlock(entry)) walkStages(entry.repeat.stages, visit);
  }
}

describe("code-dev template topology (issue #42 flow)", () => {
  it("loads real YAML with issue → design → develop → unit_test command → review + codex", () => {
    const petri = loadPetriConfig(templateDir);
    const pipeline = loadPipelineConfig(templateDir);

    // Codex as whole-run provider (single-provider constraint)
    expect(Object.values(petri.providers).some((p) => p.type === "codex")).toBe(true);

    const stageNames: string[] = [];
    let hasCommandUnitTest = false;
    let untilGate: string | undefined;
    walkStages(pipeline.stages, (entry) => {
      if (isRepeatBlock(entry)) {
        untilGate = entry.repeat.until;
        stageNames.push(`repeat:${entry.repeat.name}`);
      } else if (isCommandStage(entry)) {
        stageNames.push(entry.name);
        if (entry.name === "unit_test") {
          hasCommandUnitTest = true;
          expect(entry.gate?.id).toBe("unit-tests-pass");
          expect(entry.command).toMatch(/result\.json|tests_passed|npm test|vitest/i);
        }
      } else {
        stageNames.push(entry.name);
      }
    });

    expect(stageNames).toContain("issue");
    expect(stageNames).toContain("design");
    expect(stageNames).toContain("develop");
    expect(stageNames).toContain("review");
    expect(hasCommandUnitTest).toBe(true);
    expect(untilGate).toBe("review-approved");

    const roles = collectRoleNames(pipeline.stages);
    expect(roles).toEqual(
      expect.arrayContaining(["issue_analyst", "designer", "developer", "code_reviewer"]),
    );

    // Role gates exist on disk (shipped template)
    expect(
      fs.readFileSync(path.join(templateDir, "roles/issue_analyst/gate.yaml"), "utf-8"),
    ).toMatch(/issue-accepted/);
    expect(
      fs.readFileSync(path.join(templateDir, "roles/developer/gate.yaml"), "utf-8"),
    ).toMatch(/tests-pass/);
    expect(
      fs.readFileSync(path.join(templateDir, "roles/developer/playbooks/implement.md"), "utf-8"),
    ).toMatch(/TDD|tests first/i);
    expect(
      fs.readFileSync(path.join(templateDir, "roles/code_reviewer/playbooks/review.md"), "utf-8"),
    ).toMatch(/[Cc]odex/);
  });
});

describe("Integration: code-dev pipeline end-to-end", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("runs full code-dev pipeline to completion (stub agents + real command stage)", async () => {
    // 1. Copy template to a temp directory
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "petri-integration-"));
    fs.cpSync(templateDir, tmpDir, { recursive: true });

    // 2. Load config, pipeline, and all roles using the real config loader
    const petriConfig = loadPetriConfig(tmpDir);
    const pipeline = loadPipelineConfig(tmpDir);
    const defaultModel = petriConfig.models[petriConfig.defaults.model].model;

    const roles: Record<string, LoadedRole> = {};
    for (const roleName of collectRoleNames(pipeline.stages)) {
      roles[roleName] = loadRole(tmpDir, roleName, defaultModel);
    }

    // 3. Stub provider: write gate evidence by role persona (real soul.md text)
    const artifactBaseDir = path.join(tmpDir, "artifacts");
    fs.mkdirSync(artifactBaseDir, { recursive: true });
    const contexts = new Map<string, string>();

    const stubProvider: AgentProvider = {
      createAgent(config: AgentConfig): PetriAgent {
        return {
          async run(): Promise<AgentResult> {
            const artifacts: string[] = [];
            fs.mkdirSync(config.artifactDir, { recursive: true });
            contexts.set(config.artifactDir, config.context);

            if (config.persona.includes("issue analyst")) {
              const issueMd = path.join(config.artifactDir, "issue.md");
              fs.writeFileSync(
                issueMd,
                "# Issue\n\n## Goals\nBuild the feature.\n\n## Acceptance criteria\n- [ ] works\n",
              );
              artifacts.push(issueMd);
              const issueJson = path.join(config.artifactDir, "issue.json");
              fs.writeFileSync(issueJson, JSON.stringify({ accepted: true, summary: "demo" }));
              artifacts.push(issueJson);
            } else if (config.persona.includes("architect")) {
              const designMd = path.join(config.artifactDir, "design.md");
              fs.writeFileSync(designMd, "# Design\n\nArchitecture overview.\n\n## Test plan\nunit tests\n");
              artifacts.push(designMd);
              const designJson = path.join(config.artifactDir, "design.json");
              fs.writeFileSync(designJson, JSON.stringify({ completed: true }));
              artifacts.push(designJson);
            } else if (config.persona.includes("pragmatic")) {
              const resultJson = path.join(config.artifactDir, "result.json");
              fs.writeFileSync(
                resultJson,
                JSON.stringify({ tests_passed: true, test_summary: "stub green" }),
              );
              artifacts.push(resultJson);
              fs.writeFileSync(
                path.join(config.artifactDir, "package.json"),
                JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }),
              );
            } else if (config.persona.includes("reviewer")) {
              const reviewJson = path.join(config.artifactDir, "review.json");
              fs.writeFileSync(
                reviewJson,
                JSON.stringify({ approved: true, findings: [], summary: "ok" }),
              );
              artifacts.push(reviewJson);
            }

            return {
              artifacts,
              usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
            };
          },
        };
      },
    };

    // 4. Run the Engine with the real pipeline (includes real unit_test command stage)
    const engine = new Engine({
      provider: stubProvider,
      roles,
      artifactBaseDir,
      defaultGateStrategy: petriConfig.defaults.gate_strategy,
      defaultMaxRetries: petriConfig.defaults.max_retries,
    });

    const result = await engine.run(
      pipeline,
      "Build a CLI tool that converts CSV to JSON",
    );

    // 5. status done + gate artifacts
    expect(result.status).toBe("done");

    expect(contexts.get(path.join(artifactBaseDir, "design", "designer"))).toContain(
      path.join(artifactBaseDir, "issue", "issue_analyst", "issue.md"),
    );
    expect(contexts.get(path.join(artifactBaseDir, "develop", "developer"))).toContain(
      path.join(artifactBaseDir, "design", "designer", "design.md"),
    );

    expect(fs.existsSync(path.join(artifactBaseDir, "issue", "issue_analyst", "issue.json"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(artifactBaseDir, "design", "designer", "design.json"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(artifactBaseDir, "develop", "developer", "result.json"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(artifactBaseDir, "unit_test", "result.json"))).toBe(true);
    expect(
      fs.existsSync(path.join(artifactBaseDir, "review", "code_reviewer", "review.json")),
    ).toBe(true);

    const issueJson = JSON.parse(
      fs.readFileSync(path.join(artifactBaseDir, "issue", "issue_analyst", "issue.json"), "utf-8"),
    );
    expect(issueJson.accepted).toBe(true);

    const designJson = JSON.parse(
      fs.readFileSync(path.join(artifactBaseDir, "design", "designer", "design.json"), "utf-8"),
    );
    expect(designJson.completed).toBe(true);

    const resultJson = JSON.parse(
      fs.readFileSync(path.join(artifactBaseDir, "develop", "developer", "result.json"), "utf-8"),
    );
    expect(resultJson.tests_passed).toBe(true);

    const unitTestJson = JSON.parse(
      fs.readFileSync(path.join(artifactBaseDir, "unit_test", "result.json"), "utf-8"),
    );
    expect(unitTestJson.tests_passed).toBe(true);
    expect(unitTestJson.runner).toBe("npm test");

    const reviewJson = JSON.parse(
      fs.readFileSync(
        path.join(artifactBaseDir, "review", "code_reviewer", "review.json"),
        "utf-8",
      ),
    );
    expect(reviewJson.approved).toBe(true);

    expect(fs.existsSync(path.join(artifactBaseDir, "manifest.json"))).toBe(true);
  });

  it("blocks when the developer artifact has no supported test runner", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "petri-integration-"));
    fs.cpSync(templateDir, tmpDir, { recursive: true });

    const petriConfig = loadPetriConfig(tmpDir);
    const pipeline = loadPipelineConfig(tmpDir);
    const defaultModel = petriConfig.models[petriConfig.defaults.model].model;
    const roles = Object.fromEntries(
      collectRoleNames(pipeline.stages).map((name) => [name, loadRole(tmpDir, name, defaultModel)]),
    ) as Record<string, LoadedRole>;

    const artifactBaseDir = path.join(tmpDir, "artifacts");
    const stubProvider: AgentProvider = {
      createAgent(config: AgentConfig): PetriAgent {
        return {
          async run(): Promise<AgentResult> {
            fs.mkdirSync(config.artifactDir, { recursive: true });
            const artifacts: string[] = [];
            if (config.persona.includes("issue analyst")) {
              const file = path.join(config.artifactDir, "issue.json");
              fs.writeFileSync(file, JSON.stringify({ accepted: true }));
              artifacts.push(file);
            } else if (config.persona.includes("architect")) {
              const file = path.join(config.artifactDir, "design.json");
              fs.writeFileSync(file, JSON.stringify({ completed: true }));
              artifacts.push(file);
            } else if (config.persona.includes("pragmatic")) {
              const file = path.join(config.artifactDir, "result.json");
              fs.writeFileSync(file, JSON.stringify({ tests_passed: true }));
              artifacts.push(file);
            }
            return { artifacts };
          },
        };
      },
    };

    const engine = new Engine({
      provider: stubProvider,
      roles,
      artifactBaseDir,
      defaultGateStrategy: petriConfig.defaults.gate_strategy,
      defaultMaxRetries: petriConfig.defaults.max_retries,
    });

    await expect(engine.run(pipeline, "Build a CLI tool")).resolves.toMatchObject({
      status: "blocked",
      stage: "unit_test",
    });
    expect(fs.existsSync(path.join(artifactBaseDir, "unit_test", "result.json"))).toBe(false);
  });
});
