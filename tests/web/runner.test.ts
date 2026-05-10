import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const mocks = vi.hoisted(() => ({
  runResult: { status: "blocked" as const, stage: "review", reason: "not approved" },
}));

vi.mock("../../src/engine/engine.js", () => ({
  Engine: class {
    async run() {
      return mocks.runResult;
    }
  },
}));

import { startRun } from "../../src/web/runner.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "petri-web-runner-test-"));
}

function writeProject(projectDir: string): void {
  fs.writeFileSync(
    path.join(projectDir, "petri.yaml"),
    [
      "providers:",
      "  claude_code:",
      "    type: claude_code",
      "defaults:",
      "  model: sonnet",
      "  gate_strategy: all",
      "  max_retries: 1",
    ].join("\n"),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(projectDir, "pipeline.yaml"),
    [
      "name: blocked-pipeline",
      "stages:",
      "  - name: review",
      "    roles: [reviewer]",
    ].join("\n"),
    "utf-8",
  );
  const roleDir = path.join(projectDir, "roles", "reviewer");
  fs.mkdirSync(path.join(roleDir, "playbooks"), { recursive: true });
  fs.writeFileSync(path.join(roleDir, "role.yaml"), "persona: soul.md\nplaybooks: []\n", "utf-8");
  fs.writeFileSync(path.join(roleDir, "soul.md"), "Review things.\n", "utf-8");
}

describe("web runner", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it("records blocked engine results as blocked instead of done", async () => {
    tmpDir = makeTmpDir();
    writeProject(tmpDir);

    const activeRuns = new Map();
    const { runId } = startRun({
      projectDir: tmpDir,
      pipelineFile: "pipeline.yaml",
      input: "test",
      activeRuns,
    });

    await vi.waitFor(() => {
      expect(activeRuns.has(runId)).toBe(false);
    });

    const runJson = JSON.parse(
      fs.readFileSync(path.join(tmpDir!, ".petri", "runs", `run-${runId}`, "run.json"), "utf-8"),
    );
    expect(runJson.status).toBe("blocked");
    expect(runJson.blockedStage).toBe("review");
    expect(runJson.blockedReason).toBe("not approved");
  });
});
