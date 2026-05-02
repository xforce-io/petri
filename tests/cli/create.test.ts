import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type {
  AgentConfig,
  AgentProvider,
  AgentResult,
  PetriAgent,
} from "../../src/types.js";

function makeTmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "petri-create-test-"));
  // Minimal valid petri.yaml so generatePipeline's validation step has config to load
  fs.writeFileSync(
    path.join(dir, "petri.yaml"),
    [
      "providers:",
      "  pi:",
      "    type: pi",
      "models:",
      "  default:",
      "    model: claude-sonnet-4-5",
      "defaults:",
      "  model: default",
      "  gate_strategy: strict",
      "  max_retries: 1",
      "",
    ].join("\n"),
    "utf-8",
  );
  return dir;
}

function makeStubProvider(jsonOutput: string): AgentProvider {
  return {
    createAgent(config: AgentConfig): PetriAgent {
      return {
        async run(): Promise<AgentResult> {
          // generator.ts reads _result.md from config.artifactDir
          fs.writeFileSync(
            path.join(config.artifactDir, "_result.md"),
            jsonOutput,
            "utf-8",
          );
          return {
            artifacts: [],
            usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
          };
        },
      };
    },
  };
}

// A pipeline JSON the stub provider returns — passes structural validation
const VALID_PIPELINE_JSON = JSON.stringify({
  "pipeline.yaml": [
    "name: test-pipeline",
    "description: A test pipeline",
    "stages:",
    "  - name: work",
    "    roles: [worker]",
    "    requires: [work-done]",
    "",
  ].join("\n"),
  "roles/worker/role.yaml": [
    "persona: soul.md",
    "skills: []",
    "",
  ].join("\n"),
  "roles/worker/soul.md": "You are a worker.\n",
  "roles/worker/gate.yaml": [
    "id: work-done",
    "evidence:",
    "  type: artifact",
    "  path: '{stage}/{role}/done.json'",
    "  check:",
    "    field: completed",
    "    equals: true",
    "",
  ].join("\n"),
});

describe("petri create", () => {
  let tmpDir: string;
  let originalCwd: string;
  let lines: string[];
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = makeTmpProject();
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    lines = [];
    consoleSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      lines.push(args.join(" "));
    });
    consoleErrSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
      lines.push(args.join(" "));
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates a pipeline from a positional description and writes to .petri/generated/", async () => {
    const { runCreate } = await import("../../src/cli/create.js");
    const provider = makeStubProvider(VALID_PIPELINE_JSON);

    await runCreate(
      { description: "Build a worker pipeline" },
      provider,
      tmpDir,
    );

    const output = lines.join("\n");
    expect(output).toContain("ok");
    expect(output).toContain("pipeline.yaml");
    expect(output).toContain("roles/worker/role.yaml");
    expect(output).toContain(".petri/generated");

    // Files actually on disk
    expect(fs.existsSync(path.join(tmpDir, ".petri/generated/pipeline.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".petri/generated/roles/worker/role.yaml"))).toBe(true);
  });

  it("errors out when no description is provided", async () => {
    const { runCreate } = await import("../../src/cli/create.js");
    const provider = makeStubProvider(VALID_PIPELINE_JSON);

    await expect(
      runCreate({ description: undefined }, provider, tmpDir),
    ).rejects.toThrow(/description/i);
  });

  it("reports validation errors when generator fails validation", async () => {
    // Pipeline JSON missing the required role file → validation fails
    const BROKEN_JSON = JSON.stringify({
      "pipeline.yaml": [
        "name: broken",
        "stages:",
        "  - name: work",
        "    roles: [missing]",
        "    requires: [missing-gate]",
        "",
      ].join("\n"),
    });
    const { runCreate } = await import("../../src/cli/create.js");
    const provider = makeStubProvider(BROKEN_JSON);

    await runCreate(
      { description: "Build something broken" },
      provider,
      tmpDir,
    );

    const output = lines.join("\n");
    expect(output).toContain("validation_failed");
  });
});
