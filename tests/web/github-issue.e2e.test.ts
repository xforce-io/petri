import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveGitHubIssueInput } from "../../src/input/github-issue.js";
import { startRun } from "../../src/web/runner.js";

function writeFile(projectDir: string, relativePath: string, content: string, executable = false): void {
  const target = path.join(projectDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  if (executable) fs.chmodSync(target, 0o755);
}

describe("GitHub Issue URL E2E", () => {
  let projectDir: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (projectDir) fs.rmSync(projectDir, { recursive: true, force: true });
    projectDir = undefined;
  });

  it("puts issue body and comments into the issue role artifact", async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "petri-github-issue-e2e-"));
    writeFile(projectDir, "bin/fake-grok", [
      "#!/bin/sh",
      "cp _prompt.md issue.md",
      "printf '%s\\n' '{\"accepted\":true,\"source_url\":\"https://github.com/xforce-io/petri/issues/49\",\"comment_count\":2}' > issue.json",
      "echo issue-ready",
      "",
    ].join("\n"), true);
    vi.stubEnv("PETRI_GROK_BIN", path.join(projectDir, "bin/fake-grok"));
    writeFile(projectDir, "petri.yaml", [
      "providers:",
      "  default:",
      "    type: grok",
      "models:",
      "  default:",
      "    provider: default",
      "    model: default",
      "defaults:",
      "  model: default",
      "  gate_strategy: all",
      "  max_retries: 0",
      "",
    ].join("\n"));
    writeFile(projectDir, "pipeline.yaml", [
      "name: issue-url-e2e",
      "stages:",
      "  - name: issue",
      "    roles: [issue_analyst]",
      "    max_retries: 0",
      "",
    ].join("\n"));
    writeFile(projectDir, "roles/issue_analyst/role.yaml", "persona: issue analyst\nplaybooks: []\n");
    writeFile(projectDir, "roles/issue_analyst/gate.yaml", [
      "id: issue-accepted",
      "evidence:",
      "  path: '{stage}/{role}/issue.json'",
      "  check:",
      "    field: accepted",
      "    equals: true",
      "",
    ].join("\n"));

    const input = resolveGitHubIssueInput({
      projectDir,
      input: "https://github.com/xforce-io/petri/issues/49",
      getOrigin: () => "https://github.com/xforce-io/petri.git",
      runGh: (args) => {
        const endpoint = args.at(-1) ?? "";
        if (endpoint.endsWith("issues/49")) {
          return JSON.stringify({
            number: 49,
            title: "Issue URL context",
            body: "The issue body",
            state: "open",
            html_url: "https://github.com/xforce-io/petri/issues/49",
            user: { login: "author" },
            labels: [],
          });
        }
        if (endpoint.endsWith("page=1")) {
          return JSON.stringify([
            { id: 1, body: "first decision", created_at: "2026-07-18T00:00:00Z", user: { login: "a" } },
            { id: 2, body: "second decision", created_at: "2026-07-18T01:00:00Z", user: { login: "b" } },
          ]);
        }
        throw new Error(`unexpected endpoint: ${endpoint}`);
      },
    });

    const activeRuns = new Map();
    const { runId } = startRun({
      projectDir,
      pipelineFile: "pipeline.yaml",
      input: input.input,
      activeRuns,
    });
    await vi.waitFor(() => expect(activeRuns.has(runId)).toBe(false));

    const issueArtifact = fs.readFileSync(
      path.join(projectDir, ".petri", "artifacts", "issue", "issue_analyst", "issue.md"),
      "utf8",
    );
    expect(issueArtifact).toContain("The issue body");
    expect(issueArtifact).toContain("first decision");
    expect(issueArtifact).toContain("second decision");
    const run = JSON.parse(fs.readFileSync(
      path.join(projectDir, ".petri", "runs", `run-${runId}`, "run.json"),
      "utf8",
    ));
    expect(run.input).toContain("Comments (2)");
  });
});
