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
    "  - repeat:",
    "      name: work-loop",
    "      max_iterations: 3",
    "      until: work-approved",
    "      stages:",
    "        - name: work",
    "          roles: [worker]",
    "",
  ].join("\n"),
  "roles/worker/role.yaml": [
    "persona: soul.md",
    "skills: []",
    "",
  ].join("\n"),
  "roles/worker/soul.md": "You are a worker.\n",
  "roles/worker/gate.yaml": [
    "id: work-approved",
    "evidence:",
    "  type: artifact",
    "  path: '{stage}/{role}/output.json'",
    "  check:",
    "    field: approved",
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
    expect(output).toContain("generated");
    expect(output).toContain("Pipeline: test-pipeline");
    expect(output).toContain("Flow:");
    expect(output).toContain("worker");
    expect(output).toContain("You are a worker.");
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

  it("reads description from a file when --from is passed", async () => {
    const descPath = path.join(tmpDir, "my-desc.md");
    fs.writeFileSync(descPath, "Build a worker pipeline\nwith two stages\n", "utf-8");

    const { runCreate } = await import("../../src/cli/create.js");
    const provider = makeStubProvider(VALID_PIPELINE_JSON);

    await runCreate({ from: descPath }, provider, tmpDir);

    const output = lines.join("\n");
    expect(output).toContain("generated");
    expect(fs.existsSync(path.join(tmpDir, ".petri/generated/pipeline.yaml"))).toBe(true);
  });

  it("errors when --from points at a non-existent file", async () => {
    const { runCreate } = await import("../../src/cli/create.js");
    const provider = makeStubProvider(VALID_PIPELINE_JSON);

    await expect(
      runCreate({ from: path.join(tmpDir, "nope.md") }, provider, tmpDir),
    ).rejects.toThrow(/not found/i);
  });

  it("errors when both description and --from are provided", async () => {
    const descPath = path.join(tmpDir, "my-desc.md");
    fs.writeFileSync(descPath, "From file", "utf-8");

    const { runCreate } = await import("../../src/cli/create.js");
    const provider = makeStubProvider(VALID_PIPELINE_JSON);

    await expect(
      runCreate(
        { description: "Inline", from: descPath },
        provider,
        tmpDir,
      ),
    ).rejects.toThrow(/cannot use both/i);
  });

  it("prints a Concerns block when lint flags issues", async () => {
    // Build JSON where soul.md is a placeholder — will trigger persona concern
    const PLACEHOLDER_JSON = JSON.stringify({
      "pipeline.yaml": [
        "name: t",
        "stages:",
        "  - repeat:",
        "      name: work-loop",
        "      max_iterations: 3",
        "      until: work-approved",
        "      stages:",
        "        - name: work",
        "          roles: [worker]",
        "",
      ].join("\n"),
      "roles/worker/role.yaml": "persona: soul.md\nskills: []\n",
      "roles/worker/soul.md": "Helper.\n",
      "roles/worker/gate.yaml": [
        "id: work-approved",
        "evidence:",
        "  type: artifact",
        "  path: '{stage}/{role}/output.json'",
        "  check:",
        "    field: approved",
        "    equals: true",
        "",
      ].join("\n"),
    });
    const { runCreate } = await import("../../src/cli/create.js");
    const provider = makeStubProvider(PLACEHOLDER_JSON);

    await runCreate(
      { description: "Build a worker that does important things" },
      provider,
      tmpDir,
    );

    const output = lines.join("\n");
    expect(output).toContain("Concerns");
    expect(output).toContain("[persona]");
  });
});
