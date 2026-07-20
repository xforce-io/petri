import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { execFileSync } from "node:child_process";
import { resolveIssueInput } from "../../src/input/issue-input.js";
import { startRun } from "../../src/web/runner.js";
import { createPetriServer, type ServerResult } from "../../src/web/server.js";

function writeFile(projectDir: string, relativePath: string, content: string, executable = false): void {
  const target = path.join(projectDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  if (executable) fs.chmodSync(target, 0o755);
}

function request(
  port: number,
  urlPath: string,
  method = "GET",
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode!,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

describe("GitLab Issue URL E2E", () => {
  let projectDir: string | undefined;
  let serverResult: ServerResult | undefined;

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (serverResult) {
      await new Promise<void>((resolve) => serverResult!.server.close(() => resolve()));
      serverResult = undefined;
    }
    if (projectDir) fs.rmSync(projectDir, { recursive: true, force: true });
    projectDir = undefined;
  });

  it("puts GitLab issue body and notes into the issue role artifact", async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "petri-gitlab-issue-e2e-"));
    writeFile(projectDir, "bin/fake-grok", [
      "#!/bin/sh",
      "cp _prompt.md issue.md",
      "printf '%s\\n' '{\"accepted\":true,\"source_url\":\"https://gitlab.example.com/acme/widgets/-/issues/42\",\"comment_count\":2}' > issue.json",
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

    const input = resolveIssueInput({
      projectDir,
      input: "https://gitlab.example.com/acme/widgets/-/issues/42",
      getOrigin: () => "https://gitlab.example.com/acme/widgets.git",
      runApi: (opts) => {
        if (opts.apiPath.endsWith("/issues/42") && !opts.apiPath.includes("notes")) {
          return JSON.stringify({
            iid: 42,
            title: "GitLab Issue URL context",
            description: "The GitLab issue body",
            state: "opened",
            web_url: "https://gitlab.example.com/acme/widgets/-/issues/42",
            author: { username: "author" },
            labels: [],
          });
        }
        if (opts.apiPath.includes("notes") && opts.apiPath.includes("page=1")) {
          return JSON.stringify([
            { id: 1, body: "first decision", created_at: "2026-07-20T00:00:00Z", system: false, author: { username: "a" } },
            { id: 2, body: "second decision", created_at: "2026-07-20T01:00:00Z", system: false, author: { username: "b" } },
          ]);
        }
        throw new Error(`unexpected apiPath: ${opts.apiPath}`);
      },
    });

    expect(input.source).toBe("gitlab_issue");

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
    expect(issueArtifact).toContain("The GitLab issue body");
    expect(issueArtifact).toContain("first decision");
    expect(issueArtifact).toContain("second decision");
    const run = JSON.parse(fs.readFileSync(
      path.join(projectDir, ".petri", "runs", `run-${runId}`, "run.json"),
      "utf8",
    ));
    expect(run.input).toContain("Platform: gitlab");
    expect(run.input).toContain("Comments (2)");
  });

  it("Web POST /api/runs expands a valid GitLab Issue URL before starting", async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "petri-gitlab-web-"));
    execFileSync("git", ["init"], { cwd: projectDir, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "https://gitlab.example.com/acme/widgets.git"], {
      cwd: projectDir,
      stdio: "ignore",
    });
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
    writeFile(projectDir, "pipeline.yaml", "name: empty\nstages: []\n");

    const binDir = path.join(projectDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const fakeCurl = path.join(binDir, "curl");
    fs.writeFileSync(fakeCurl, [
      "#!/bin/sh",
      "url=\"\"",
      "for a in \"$@\"; do case \"$a\" in https://*) url=\"$a\" ;; esac; done",
      "# Match notes before issue: issue path is a prefix of the notes URL.",
      "case \"$url\" in",
      "  *'/issues/42/notes'*)",
      "    printf '%s' '[{\"id\":1,\"body\":\"comment from API\",\"system\":false,\"author\":{\"username\":\"reviewer\"}}]' ;;",
      "  *'/issues/42'*)",
      "    printf '%s' '{\"iid\":42,\"title\":\"From URL\",\"description\":\"Issue body\",\"state\":\"opened\",\"web_url\":\"https://gitlab.example.com/acme/widgets/-/issues/42\",\"labels\":[]}' ;;",
      "  *) echo \"unexpected $url\" >&2; exit 1 ;;",
      "esac",
      "",
    ].join("\n"));
    fs.chmodSync(fakeCurl, 0o755);
    vi.stubEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);
    vi.stubEnv("GITLAB_API_TOKEN", "test-token-not-real");

    serverResult = await createPetriServer({ projectDir, port: 0 });
    const res = await request(
      serverResult.port,
      "/api/runs",
      "POST",
      JSON.stringify({ input: "https://gitlab.example.com/acme/widgets/-/issues/42" }),
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).inputSource).toBe("gitlab_issue");

    await vi.waitFor(() => expect(fs.existsSync(
      path.join(projectDir!, ".petri", "runs", "run-001", "run.json"),
    )).toBe(true));
    const runInput = JSON.parse(fs.readFileSync(
      path.join(projectDir!, ".petri", "runs", "run-001", "run.json"),
      "utf8",
    )).input;
    expect(runInput).toContain("Issue body");
    expect(runInput).toContain("comment from API");
    expect(runInput).toContain("Platform: gitlab");
  });

  it("Web rejects cross-origin GitLab Issue URL before starting a run", async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "petri-gitlab-cross-"));
    execFileSync("git", ["init"], { cwd: projectDir, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "https://gitlab.example.com/acme/widgets.git"], {
      cwd: projectDir,
      stdio: "ignore",
    });
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
    writeFile(projectDir, "pipeline.yaml", "name: empty\nstages: []\n");

    serverResult = await createPetriServer({ projectDir, port: 0 });
    const res = await request(
      serverResult.port,
      "/api/runs",
      "POST",
      JSON.stringify({ input: "https://gitlab.example.com/other/repo/-/issues/1" }),
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/does not belong to current origin/);
    expect(fs.existsSync(path.join(projectDir!, ".petri", "runs"))).toBe(false);
  });
});
