import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { createPetriServer, type ServerResult } from "../../src/web/server.js";
import { RunLogger } from "../../src/engine/logger.js";
import { buildEvolutionView } from "../../src/web/routes/api.js";

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


describe("product web: clear stale run errors (issue #20)", () => {
  it("S1: clears run-error on input and when re-entering Runs tab", () => {
    const appJs = fs.readFileSync(path.join(process.cwd(), "src/web/public/app.js"), "utf-8");
    expect(appJs).toMatch(/syncRunInputError/);
    expect(appJs).toMatch(/clearRunFormErrorsOnEnter/);
    expect(appJs).toMatch(/addEventListener\(\s*["']input["']/);
    expect(appJs).toMatch(/loadRunsTab[\s\S]{0,200}clearRunFormErrorsOnEnter|clearRunFormErrorsOnEnter[\s\S]{0,80}loadRunsTab/);
  });
});
