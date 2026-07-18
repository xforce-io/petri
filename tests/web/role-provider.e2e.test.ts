import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startRun } from "../../src/web/runner.js";

function writeFile(projectDir: string, relativePath: string, content: string, executable = false): void {
  const target = path.join(projectDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  if (executable) fs.chmodSync(target, 0o755);
}

describe("role provider routing E2E", () => {
  let projectDir: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (projectDir) fs.rmSync(projectDir, { recursive: true, force: true });
    projectDir = undefined;
  });

  it("runs one Web-started pipeline through Codex and Grok fake CLIs by role", async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "petri-role-provider-e2e-"));
    writeFile(projectDir, "bin/fake-codex", "#!/bin/sh\necho codex > provider.txt\necho codex\n", true);
    writeFile(projectDir, "bin/fake-grok", "#!/bin/sh\necho grok > provider.txt\necho grok\n", true);
    vi.stubEnv("PETRI_CODEX_BIN", path.join(projectDir, "bin/fake-codex"));
    vi.stubEnv("PETRI_GROK_BIN", path.join(projectDir, "bin/fake-grok"));

    writeFile(projectDir, "petri.yaml", [
      "providers:",
      "  coding:",
      "    type: codex",
      "  review:",
      "    type: grok",
      "models:",
      "  coding:",
      "    provider: coding",
      "    model: default",
      "  review:",
      "    provider: review",
      "    model: default",
      "defaults:",
      "  model: coding",
      "  gate_strategy: all",
      "  max_retries: 0",
      "",
    ].join("\n"));
    writeFile(projectDir, "pipeline.yaml", [
      "name: role-provider-e2e",
      "stages:",
      "  - name: implement",
      "    roles: [developer]",
      "  - name: review",
      "    roles: [reviewer]",
      "",
    ].join("\n"));
    writeFile(projectDir, "roles/developer/role.yaml", "persona: developer\nplaybooks: []\n");
    writeFile(projectDir, "roles/reviewer/role.yaml", "persona: reviewer\nprovider: review\nmodel: review\nplaybooks: []\n");

    const activeRuns = new Map();
    const { runId } = startRun({
      projectDir,
      pipelineFile: "pipeline.yaml",
      input: "implement then review",
      activeRuns,
    });

    await vi.waitFor(() => expect(activeRuns.has(runId)).toBe(false));

    const runDir = path.join(projectDir, ".petri", "runs", `run-${runId}`);
    const run = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8"));
    expect(run.status).toBe("done");
    expect(run.stages.map((stage: { provider: string }) => stage.provider)).toEqual(["coding", "review"]);
    expect(fs.readFileSync(path.join(projectDir, ".petri", "artifacts", "implement", "developer", "provider.txt"), "utf8").trim()).toBe("codex");
    expect(fs.readFileSync(path.join(projectDir, ".petri", "artifacts", "review", "reviewer", "provider.txt"), "utf8").trim()).toBe("grok");
  });
});
