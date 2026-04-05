import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { loadPetriConfig, loadPipelineConfig, loadRole } from "../src/config/loader.js";
import { Engine } from "../src/engine/engine.js";
import { isRepeatBlock } from "../src/types.js";
import type { AgentProvider, PetriAgent, AgentConfig, AgentResult, LoadedRole } from "../src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templateDir = path.join(__dirname, "..", "src", "templates", "code-dev");

describe("Integration: code-dev pipeline end-to-end", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("runs full code-dev pipeline to completion", async () => {
    // 1. Copy template to a temp directory
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "petri-integration-"));
    fs.cpSync(templateDir, tmpDir, { recursive: true });

    // 2. Load config, pipeline, and all roles using the real config loader
    const petriConfig = loadPetriConfig(tmpDir);
    const pipeline = loadPipelineConfig(tmpDir);
    const defaultModel = petriConfig.models[petriConfig.defaults.model].model;

    const roles: Record<string, LoadedRole> = {};
    for (const entry of pipeline.stages) {
      if (isRepeatBlock(entry)) {
        for (const stage of entry.repeat.stages) {
          for (const roleName of stage.roles) {
            if (!roles[roleName]) {
              roles[roleName] = loadRole(tmpDir, roleName, defaultModel);
            }
          }
        }
      } else {
        for (const roleName of entry.roles) {
          if (!roles[roleName]) {
            roles[roleName] = loadRole(tmpDir, roleName, defaultModel);
          }
        }
      }
    }

    // 3. Create a stub provider that simulates the three roles
    const artifactBaseDir = path.join(tmpDir, "artifacts");
    fs.mkdirSync(artifactBaseDir, { recursive: true });

    const stubProvider: AgentProvider = {
      createAgent(config: AgentConfig): PetriAgent {
        return {
          async run(): Promise<AgentResult> {
            const artifacts: string[] = [];

            if (config.persona.includes("architect")) {
              // Designer role: write design.md + design.json
              const dir = path.join(config.artifactDir, "design", "designer");
              fs.mkdirSync(dir, { recursive: true });

              const designMd = path.join(dir, "design.md");
              fs.writeFileSync(designMd, "# Design\n\nArchitecture overview.");
              artifacts.push(designMd);

              const designJson = path.join(dir, "design.json");
              fs.writeFileSync(designJson, JSON.stringify({ completed: true }));
              artifacts.push(designJson);
            } else if (config.persona.includes("pragmatic")) {
              // Developer role: write result.json
              const dir = path.join(config.artifactDir, "develop", "developer");
              fs.mkdirSync(dir, { recursive: true });

              const resultJson = path.join(dir, "result.json");
              fs.writeFileSync(resultJson, JSON.stringify({ tests_passed: true }));
              artifacts.push(resultJson);
            } else if (config.persona.includes("reviewer")) {
              // Code reviewer role: write review.json
              const dir = path.join(config.artifactDir, "review", "code_reviewer");
              fs.mkdirSync(dir, { recursive: true });

              const reviewJson = path.join(dir, "review.json");
              fs.writeFileSync(reviewJson, JSON.stringify({ approved: true }));
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

    // 4. Run the Engine with the real pipeline
    const engine = new Engine({
      provider: stubProvider,
      roles,
      artifactBaseDir,
      defaultGateStrategy: petriConfig.defaults.gate_strategy,
      defaultMaxRetries: petriConfig.defaults.max_retries,
    });

    const result = await engine.run(pipeline, "Build a CLI tool that converts CSV to JSON");

    // 5. Verify result.status === "done"
    expect(result.status).toBe("done");

    // 6. Verify all gate artifacts exist on disk
    expect(fs.existsSync(path.join(artifactBaseDir, "design", "designer", "design.json"))).toBe(true);
    expect(fs.existsSync(path.join(artifactBaseDir, "design", "designer", "design.md"))).toBe(true);
    expect(fs.existsSync(path.join(artifactBaseDir, "develop", "developer", "result.json"))).toBe(true);
    expect(fs.existsSync(path.join(artifactBaseDir, "review", "code_reviewer", "review.json"))).toBe(true);

    // Verify artifact content
    const designJson = JSON.parse(fs.readFileSync(path.join(artifactBaseDir, "design", "designer", "design.json"), "utf-8"));
    expect(designJson.completed).toBe(true);

    const resultJson = JSON.parse(fs.readFileSync(path.join(artifactBaseDir, "develop", "developer", "result.json"), "utf-8"));
    expect(resultJson.tests_passed).toBe(true);

    const reviewJson = JSON.parse(fs.readFileSync(path.join(artifactBaseDir, "review", "code_reviewer", "review.json"), "utf-8"));
    expect(reviewJson.approved).toBe(true);

    // 7. Verify manifest.json was created
    expect(fs.existsSync(path.join(artifactBaseDir, "manifest.json"))).toBe(true);
  });
});
