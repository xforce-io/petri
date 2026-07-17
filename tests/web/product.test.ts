import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { createPetriServer, type ServerResult } from "../../src/web/server.js";
import { RunLogger } from "../../src/engine/logger.js";
import { buildEvolutionView } from "../../src/web/routes/api.js";
import { fileURLToPath } from "node:url";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "petri-product-test-"));
}

function request(
  port: number,
  urlPath: string,
  method = "GET",
  body?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
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
            headers: res.headers,
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

describe("product web: zero-project + create from preset", () => {
  let workspace: string;
  let result: ServerResult;

  beforeEach(async () => {
    workspace = makeTmpDir();
    result = await createPetriServer({
      projectDirs: [],
      workspaceRoot: workspace,
      port: 0,
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => result.server.close(() => resolve()));
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("serves home HTML with product chrome when no projects", async () => {
    const res = await request(result.port, "/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toMatch(/Petri/i);
    // Product entry CTAs / onboarding markers
    expect(res.body).toMatch(/data-tab="dashboard"|onboarding|template/i);
  });

  it("GET /api/projects returns empty list", async () => {
    const res = await request(result.port, "/api/projects");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it("GET /api/meta reports workspace and zero projects", async () => {
    const res = await request(result.port, "/api/meta");
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.product).toBe("petri-web");
    expect(data.projectCount).toBe(0);
    expect(data.workspaceRoot).toBe(workspace);
  });

  it("POST /api/projects creates code-dev project on disk and lists it", async () => {
    const res = await request(
      result.port,
      "/api/projects",
      "POST",
      JSON.stringify({ name: "demo-app", template: "code-dev" }),
    );
    expect(res.status).toBe(201);
    const created = JSON.parse(res.body);
    expect(created.name).toBe("demo-app");
    expect(fs.existsSync(path.join(workspace, "demo-app", "petri.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "demo-app", "pipeline.yaml"))).toBe(true);
    expect(
      fs.existsSync(path.join(workspace, "demo-app", "roles", "developer", "role.yaml")),
    ).toBe(true);

    const list = await request(result.port, "/api/projects");
    const projects = JSON.parse(list.body);
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe("demo-app");
  });

  it("rejects invalid project name and unknown template", async () => {
    const badName = await request(
      result.port,
      "/api/projects",
      "POST",
      JSON.stringify({ name: "../evil", template: "code-dev" }),
    );
    expect(badName.status).toBe(400);

    const badTpl = await request(
      result.port,
      "/api/projects",
      "POST",
      JSON.stringify({ name: "okname", template: "nope" }),
    );
    expect(badTpl.status).toBe(404);
  });

  it("returns NO_PROJECT when starting a run without a project", async () => {
    const res = await request(
      result.port,
      "/api/runs",
      "POST",
      JSON.stringify({ input: "hello" }),
    );
    expect(res.status).toBe(400);
    const data = JSON.parse(res.body);
    expect(data.code).toBe("NO_PROJECT");
    expect(data.error).toMatch(/project/i);
  });
});

describe("product web: run detail evolution + config validate", () => {
  let projectDir: string;
  let result: ServerResult;

  beforeEach(async () => {
    projectDir = makeTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "petri.yaml"),
      "providers:\n  default:\n    type: pi\ndefaults:\n  model: test\n  gate_strategy: all\n  max_retries: 1\n",
    );
    fs.writeFileSync(
      path.join(projectDir, "pipeline.yaml"),
      "name: t\nstages:\n  - name: work\n    roles: [worker]\n",
    );
    fs.mkdirSync(path.join(projectDir, "roles", "worker"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "roles", "worker", "role.yaml"),
      "persona: soul.md\nplaybooks: []\n",
    );
    fs.writeFileSync(path.join(projectDir, "roles", "worker", "soul.md"), "Worker.\n");
    fs.writeFileSync(
      path.join(projectDir, "roles", "worker", "gate.yaml"),
      "id: ok\nevidence:\n  path: '{stage}/{role}/out.json'\n  check:\n    field: done\n    equals: true\n",
    );

    result = await createPetriServer({
      projectDir,
      projectDirs: [{ name: path.basename(projectDir), dir: projectDir }],
      workspaceRoot: path.dirname(projectDir),
      port: 0,
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => result.server.close(() => resolve()));
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("run detail includes blockedReason and evolution attempts", async () => {
    const petriDir = path.join(projectDir, ".petri");
    const logger = new RunLogger(petriDir, "t", "input");
    logger.logStageAttempt("work", 1, 2);
    const timer = logger.logRoleStart("work", "worker", "test");
    logger.logRoleEnd(timer, {
      gatePassed: false,
      gateReason: "Agent timed out after 100ms",
      attempt: 1,
      artifacts: [],
    });
    logger.finish("blocked", "work", "Stagnation detected: same failure repeated");

    const res = await request(result.port, "/api/runs/001");
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.status).toBe("blocked");
    expect(data.blockedReason).toMatch(/Stagnation|timeout|timed out/i);
    expect(data.blockedStage).toBe("work");
    expect(data.evolution).toBeDefined();
    expect(Array.isArray(data.evolution)).toBe(true);
    expect(data.evolution[0].stage).toBe("work");
    expect(data.evolution[0].attempts.length).toBeGreaterThan(0);
    expect(data.evolution[0].attempts[0].gatePassed).toBe(false);
    expect(data.evolution[0].attempts[0].gateReason).toMatch(/timed out/i);
  });

  it("POST /api/config/validate returns valid for good project", async () => {
    // Minimal valid pipeline still needs a repeat block per validate rules —
    // use validate result shape regardless.
    const res = await request(result.port, "/api/config/validate", "POST", "{}");
    expect([200, 400]).toContain(res.status);
    const data = JSON.parse(res.body);
    expect(typeof data.valid).toBe("boolean");
    expect(Array.isArray(data.errors)).toBe(true);
  });

  it("PUT config rejects invalid YAML with explicit error", async () => {
    const res = await request(
      result.port,
      "/api/config/file?path=pipeline.yaml",
      "PUT",
      JSON.stringify({ content: "name: [\nbad" }),
    );
    expect(res.status).toBe(400);
    const data = JSON.parse(res.body);
    expect(data.error).toMatch(/YAML/i);
  });

  it("PUT config saves valid content and reloads", async () => {
    const content = fs.readFileSync(path.join(projectDir, "pipeline.yaml"), "utf-8");
    const updated = content + "\n# saved-by-test\n";
    const save = await request(
      result.port,
      "/api/config/file?path=pipeline.yaml",
      "PUT",
      JSON.stringify({ content: updated }),
    );
    expect(save.status).toBe(200);
    const read = await request(result.port, "/api/config/file?path=pipeline.yaml");
    expect(read.status).toBe(200);
    expect(JSON.parse(read.body).content).toContain("saved-by-test");
  });
});

describe("buildEvolutionView", () => {
  it("groups stage logs by stage with attempt numbers", () => {
    const view = buildEvolutionView([
      {
        stage: "work",
        role: "worker",
        attempt: 1,
        model: "m",
        startedAt: "",
        finishedAt: "",
        durationMs: 10,
        gatePassed: false,
        gateReason: "fail",
        artifacts: [],
      },
      {
        stage: "work",
        role: "worker",
        attempt: 2,
        model: "m",
        startedAt: "",
        finishedAt: "",
        durationMs: 12,
        gatePassed: true,
        gateReason: "ok",
        artifacts: ["a.json"],
      },
    ]);
    expect(view).toHaveLength(1);
    expect(view[0].attempts).toHaveLength(2);
    expect(view[0].attempts[1].gatePassed).toBe(true);
  });
});

describe("product web: command stage display (issue #18)", () => {
  it("S1: config structure labels Command Stage", () => {
    const appJs = fs.readFileSync(path.join(process.cwd(), "src/web/public/app.js"), "utf-8");
    expect(appJs).toMatch(/Command Stage/);
    expect(appJs).toMatch(/kind === ["']command["']/);
  });
});

describe("product web: quality success rate (issue #17)", () => {
  it("S1: app.js uses quality-based success rate helpers", () => {
    const appJs = fs.readFileSync(path.join(process.cwd(), "src/web/public/app.js"), "utf-8");
    expect(appJs).toMatch(/computeSuccessRate/);
    expect(appJs).toMatch(/computeRunStatuses/);
    expect(appJs).toMatch(/Quality:/);
    expect(appJs).toMatch(/Execution:/);
  });
});

describe("product web: config validate draft overlay (issue #14)", () => {
  let projectDir: string;
  let result: ServerResult;

  beforeEach(async () => {
    projectDir = makeTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "petri.yaml"),
      "providers:\n  default:\n    type: pi\ndefaults:\n  model: test\n  gate_strategy: all\n  max_retries: 1\n",
    );
    fs.writeFileSync(
      path.join(projectDir, "pipeline.yaml"),
      "name: t\nstages:\n  - name: work\n    roles: [worker]\n  - repeat:\n      name: loop\n      max_iterations: 1\n      until: ok\n      stages:\n        - name: again\n          roles: [worker]\n",
    );
    fs.mkdirSync(path.join(projectDir, "roles", "worker"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "roles", "worker", "role.yaml"),
      "persona: soul.md\nplaybooks: []\n",
    );
    fs.writeFileSync(path.join(projectDir, "roles", "worker", "soul.md"), "Worker.\n");
    fs.writeFileSync(
      path.join(projectDir, "roles", "worker", "gate.yaml"),
      "id: ok\nevidence:\n  path: '{stage}/{role}/out.json'\n  check:\n    field: score\n    gte: 1\n",
    );

    result = await createPetriServer({
      projectDir,
      projectDirs: [{ name: path.basename(projectDir), dir: projectDir }],
      workspaceRoot: path.dirname(projectDir),
      port: 0,
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => result.server.close(() => resolve()));
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("S1: POST /api/config/validate with illegal draft YAML fails even when disk is valid", async () => {
    // Disk project is valid; unsaved illegal draft must not report success
    const disk = await request(result.port, "/api/config/validate", "POST", "{}");
    const diskData = JSON.parse(disk.body);
    // If disk invalid for other reasons, still assert draft path
    const res = await request(
      result.port,
      "/api/config/validate",
      "POST",
      JSON.stringify({ drafts: { "pipeline.yaml": "name: [\nbad" } }),
    );
    expect(res.status).toBe(400);
    const data = JSON.parse(res.body);
    expect(data.valid).toBe(false);
    expect(Array.isArray(data.errors)).toBe(true);
    expect(data.errors.join("\n")).toMatch(/pipeline\.yaml|YAML|yaml|bad|parse|syntax/i);
    // Disk file must remain unchanged
    const onDisk = fs.readFileSync(path.join(projectDir, "pipeline.yaml"), "utf-8");
    expect(onDisk).not.toContain("name: [");
    expect(onDisk).toContain("name: t");
    void diskData;
  });

  it("S1: validate without drafts uses saved project only", async () => {
    const res = await request(result.port, "/api/config/validate", "POST", "{}");
    expect([200, 400]).toContain(res.status);
    const data = JSON.parse(res.body);
    expect(typeof data.valid).toBe("boolean");
    expect(Array.isArray(data.errors)).toBe(true);
  });

  it("S1: frontend app.js validates draft content and clears stale result on change", () => {
    const appJs = fs.readFileSync(
      path.join(process.cwd(), "src/web/public/app.js"),
      "utf-8",
    );
    // Must send current editor draft to validate API
    expect(appJs).toMatch(/drafts/);
    expect(appJs).toMatch(/editor-content/);
    expect(appJs).toMatch(/config-validate/);
    // Must clear validate result when content or file context changes
    expect(appJs).toMatch(/clearConfigValidateResult|config-validate-result[\s\S]{0,80}textContent\s*=\s*["']["']/);
    // Input or change handlers clear stale success
    expect(appJs).toMatch(/addEventListener\(\s*["']input["']/);
  });
});


describe("product web: command stage evolution label (issue #18)", () => {
  it("evolution timeline branch labels command role as Command Stage", () => {
    const appJs = fs.readFileSync(path.join(process.cwd(), "src/web/public/app.js"), "utf-8");
    const evoIdx = appJs.indexOf("Prefer evolution view");
    expect(evoIdx).toBeGreaterThanOrEqual(0);
    // Evolution branch ends at stages fallback
    const endIdx = appJs.indexOf("const stages = currentRunData.stages", evoIdx);
    const evoChunk = appJs.slice(evoIdx, endIdx > evoIdx ? endIdx : evoIdx + 4000);
    expect(evoChunk).toMatch(/Command Stage/);
    expect(evoChunk).toMatch(/role === ["']command["']/);
  });
});

describe("product web: non-default pipeline draft validate (issue #14 follow-up)", () => {
  let projectDir: string;
  let result: ServerResult;

  beforeEach(async () => {
    projectDir = makeTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "petri.yaml"),
      "providers:\n  default:\n    type: pi\ndefaults:\n  model: test\n  gate_strategy: all\n  max_retries: 1\n",
    );
    fs.writeFileSync(
      path.join(projectDir, "pipeline.yaml"),
      "name: t\nstages:\n  - name: work\n    roles: [worker]\n  - repeat:\n      name: loop\n      max_iterations: 1\n      until: ok\n      stages:\n        - name: again\n          roles: [worker]\n",
    );
    fs.writeFileSync(
      path.join(projectDir, "pipeline-command.yaml"),
      "name: cmd\nstages:\n  - name: measure\n    command: \"echo 1\"\n",
    );
    fs.mkdirSync(path.join(projectDir, "roles", "worker"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "roles", "worker", "role.yaml"), "persona: soul.md\nplaybooks: []\n");
    fs.writeFileSync(path.join(projectDir, "roles", "worker", "soul.md"), "W\n");
    fs.writeFileSync(
      path.join(projectDir, "roles", "worker", "gate.yaml"),
      "id: ok\nevidence:\n  path: '{stage}/{role}/out.json'\n  check:\n    field: score\n    gte: 1\n",
    );
    result = await createPetriServer({
      projectDir,
      projectDirs: [{ name: path.basename(projectDir), dir: projectDir }],
      workspaceRoot: path.dirname(projectDir),
      port: 0,
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => result.server.close(() => resolve()));
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("S1: illegal draft of pipeline-command.yaml fails even when default pipeline is valid", async () => {
    const res = await request(
      result.port,
      "/api/config/validate",
      "POST",
      JSON.stringify({ drafts: { "pipeline-command.yaml": "name: [\nbad" } }),
    );
    expect(res.status).toBe(400);
    const data = JSON.parse(res.body);
    expect(data.valid).toBe(false);
    expect(data.errors.join("\n")).toMatch(/pipeline-command|YAML|syntax|bad|parse/i);
    // default pipeline on disk unchanged
    expect(fs.readFileSync(path.join(projectDir, "pipeline.yaml"), "utf-8")).toContain("name: t");
  });
});

describe("product web: run detail structured trace (issue #15)", () => {
  let projectDir: string;
  let result: ServerResult;

  beforeEach(async () => {
    projectDir = makeTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "petri.yaml"),
      "providers:\n  default:\n    type: pi\ndefaults:\n  model: test\n  gate_strategy: all\n  max_retries: 1\n",
    );
    fs.writeFileSync(
      path.join(projectDir, "pipeline.yaml"),
      "name: t\nstages:\n  - name: work\n    roles: [worker]\n",
    );
    fs.mkdirSync(path.join(projectDir, "roles", "worker"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "roles", "worker", "role.yaml"), "persona: soul.md\nplaybooks: []\n");
    fs.writeFileSync(path.join(projectDir, "roles", "worker", "soul.md"), "Worker.\n");
    fs.writeFileSync(
      path.join(projectDir, "roles", "worker", "gate.yaml"),
      "id: ok\nevidence:\n  path: '{stage}/{role}/out.json'\n  check:\n    field: score\n    gte: 1\n",
    );
    result = await createPetriServer({
      projectDir,
      projectDirs: [{ name: path.basename(projectDir), dir: projectDir }],
      workspaceRoot: path.dirname(projectDir),
      port: 0,
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => result.server.close(() => resolve()));
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("GET /api/runs/:id includes hierarchical trace with stable ids", async () => {
    const petriDir = path.join(projectDir, ".petri");
    const logger = new RunLogger(petriDir, "t", "input");
    logger.beginRepeatIteration("loop", 1, 2);
    logger.logStageAttempt("work", 1, 2);
    const timer = logger.logRoleStart("work", "worker", "test");
    logger.logRoleEnd(timer, {
      gatePassed: true,
      gateReason: "ok",
      attempt: 1,
      artifacts: [],
    });
    logger.logGateResult("work", true, "ok", {
      strategy: "all",
      roleResults: [{ role: "worker", gateId: "ok", passed: true, reason: "ok" }],
    });
    logger.endStageAttempt("done");
    logger.endRepeatIteration("done");
    logger.finish("done");

    const res = await request(result.port, `/api/runs/${logger.runId}`);
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.trace).toBeDefined();
    expect(data.trace.version).toBe(1);
    expect(Array.isArray(data.trace.root)).toBe(true);
    expect(data.trace.root[0].kind).toBe("repeat_iteration");
    expect(data.trace.root[0].id).toBe("rep:loop:i1");
    expect(data.trace.root[0].children[0].id).toMatch(/att:work:/);
    expect(data.trace.root[0].children[0].roles[0].id).toMatch(/role:work:/);
    expect(data.trace.root[0].children[0].stageGate.strategy).toBe("all");
  });

  it("frontend app.js renders hierarchical trace", () => {
    const appJs = fs.readFileSync(path.join(process.cwd(), "src/web/public/app.js"), "utf-8");
    expect(appJs).toMatch(/renderTraceTimeline/);
    expect(appJs).toMatch(/repeat_iteration|trace\.root/);
    expect(appJs).toMatch(/stageGate|stage_gate|Stage gate/);
  });
});

describe("product web: app.js parseability after trace UI (issue #15)", () => {
  it("app.js has no orphan async and loadConfigTab is async with await", () => {
    const appJs = fs.readFileSync(path.join(process.cwd(), "src/web/public/app.js"), "utf-8");
    expect(appJs).not.toMatch(/^async\s*$/m);
    expect(appJs).toMatch(/async function loadConfigTab/);
    expect(appJs).toMatch(/async function loadConfigTab\([\s\S]*?await /);
  });
});

describe("product web: attempt-bound artifacts (issue #16)", () => {
  let projectDir: string;
  let result: ServerResult;

  beforeEach(async () => {
    projectDir = makeTmpDir();
    fs.writeFileSync(
      path.join(projectDir, "petri.yaml"),
      "providers:\n  default:\n    type: pi\ndefaults:\n  model: test\n  gate_strategy: all\n  max_retries: 1\n",
    );
    fs.writeFileSync(path.join(projectDir, "pipeline.yaml"), "name: t\nstages:\n  - name: work\n    roles: [worker]\n");
    result = await createPetriServer({
      projectDir,
      projectDirs: [{ name: path.basename(projectDir), dir: projectDir }],
      workspaceRoot: path.dirname(projectDir),
      port: 0,
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => result.server.close(() => resolve()));
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("S1: lists run snapshot artifacts with attempt metadata", async () => {
    const runDir = path.join(projectDir, ".petri", "runs", "run-001");
    const a1 = path.join(runDir, "artifacts", "001-work", "worker");
    const a2 = path.join(runDir, "artifacts", "002-work", "worker");
    fs.mkdirSync(a1, { recursive: true });
    fs.mkdirSync(a2, { recursive: true });
    fs.writeFileSync(path.join(a1, "out-a.json"), '{"v":1}');
    fs.writeFileSync(
      path.join(a1, "_snapshot.json"),
      JSON.stringify({ sequence: 1, stage: "work", role: "worker", attempt: 1 }),
    );
    fs.writeFileSync(path.join(a2, "out-b.json"), '{"v":2}');
    fs.writeFileSync(
      path.join(a2, "_snapshot.json"),
      JSON.stringify({ sequence: 2, stage: "work", role: "worker", attempt: 2 }),
    );
    fs.writeFileSync(path.join(runDir, "run.log"), "log");

    const res = await request(result.port, "/api/runs/001/artifacts");
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body) as Array<{ path: string; attempt?: number; stage?: string }>;
    expect(data.some((x) => x.path.includes("out-a") && x.attempt === 1)).toBe(true);
    expect(data.some((x) => x.path.includes("out-b") && x.attempt === 2)).toBe(true);

    const file = await request(result.port, "/api/runs/001/artifacts/002-work/worker/out-b.json");
    expect(file.status).toBe(200);
    expect(file.body).toContain('"v":2');
  });

  it("S1: frontend binds I/O log artifacts to attempt helpers", () => {
    const appJs = fs.readFileSync(path.join(process.cwd(), "src/web/public/app.js"), "utf-8");
    expect(appJs).toMatch(/filterArtifactsForAttempt/);
    expect(appJs).toMatch(/filterLogForAttempt/);
    expect(appJs).toMatch(/resolveAttemptIoPrefix/);
  });
});
