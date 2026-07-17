import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { fileURLToPath } from "node:url";
import {
  listProjectPipelines,
  pipelineDisplayLabel,
} from "../../src/web/pipelines.js";
import { createPetriServer, type ServerResult } from "../../src/web/server.js";

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "petri-pipes-"));
}

function request(
  port: number,
  urlPath: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method: "GET" },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            body: Buffer.concat(chunks).toString("utf-8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("listProjectPipelines", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmp();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns logical name from YAML not bare filename", () => {
    fs.writeFileSync(
      path.join(dir, "pipeline.yaml"),
      "name: code-dev\ndescription: hello\nstages:\n  - name: design\n    roles: [designer]\n",
    );
    const list = listProjectPipelines(dir);
    expect(list).toHaveLength(1);
    expect(list[0].file).toBe("pipeline.yaml");
    expect(list[0].name).toBe("code-dev");
    expect(list[0].description).toBe("hello");
    expect(list[0].stages[0]).toMatchObject({ name: "design", roles: ["designer"], kind: "agent" });
    expect(pipelineDisplayLabel(list[0], list)).toBe("code-dev");
    expect(pipelineDisplayLabel(list[0], list)).not.toBe("pipeline.yaml");
  });

  it("lists multiple pipelines and disambiguates same logical name", () => {
    fs.writeFileSync(
      path.join(dir, "pipeline.yaml"),
      "name: main\nstages:\n  - name: a\n    roles: [x]\n",
    );
    fs.writeFileSync(
      path.join(dir, "pipeline-alt.yaml"),
      "name: main\nstages:\n  - name: b\n    roles: [y]\n",
    );
    const list = listProjectPipelines(dir);
    expect(list).toHaveLength(2);
    const labels = list.map((p) => pipelineDisplayLabel(p, list));
    expect(labels.every((l) => l.includes("main"))).toBe(true);
    expect(labels.some((l) => l.includes("pipeline.yaml"))).toBe(true);
    expect(labels.some((l) => l.includes("pipeline-alt.yaml"))).toBe(true);
  });

  it("falls back to file stem when name missing", () => {
    fs.writeFileSync(path.join(dir, "pipeline-foo.yaml"), "stages: []\n");
    const list = listProjectPipelines(dir);
    expect(list[0].file).toBe("pipeline-foo.yaml");
    expect(list[0].name).toBe("pipeline-foo");
  });

  it("extracts roles from nested repeat stages", () => {
    fs.writeFileSync(
      path.join(dir, "pipeline.yaml"),
      `name: loop
stages:
  - name: prep
    roles: [a]
  - repeat:
      name: cycle
      max_iterations: 2
      until: g
      stages:
        - name: work
          roles: [b]
`,
    );
    const list = listProjectPipelines(dir);
    expect(list[0].stages.map((s) => s.name)).toEqual(["prep", "work"]);
    expect(list[0].stages[1].roles).toEqual(["b"]);
  });
});

describe("GET /api/pipelines", () => {
  let dir: string;
  let result: ServerResult;

  beforeEach(async () => {
    dir = makeTmp();
    fs.writeFileSync(path.join(dir, "petri.yaml"), "defaults:\n  model: t\n");
    fs.writeFileSync(
      path.join(dir, "pipeline.yaml"),
      "name: code-dev\nstages:\n  - name: design\n    roles: [designer]\n",
    );
    result = await createPetriServer({
      projectDir: dir,
      projectDirs: [{ name: "p", dir }],
      workspaceRoot: path.dirname(dir),
      port: 0,
    });
  });

  afterEach(async () => {
    await new Promise<void>((r) => result.server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns file + logical name for Run/Config clients", async () => {
    const res = await request(result.port, "/api/pipelines");
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data).toHaveLength(1);
    expect(data[0].file).toBe("pipeline.yaml");
    expect(data[0].name).toBe("code-dev");
    expect(data[0].stages[0].roles).toContain("designer");
  });
});

describe("product UI source uses pipeline name API for Run + Config", () => {
  const appSrc = () =>
    fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/web/public/app.js"),
      "utf-8",
    );
  const htmlSrc = () =>
    fs.readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../src/web/public/index.html",
      ),
      "utf-8",
    );

  it("app.js loads /api/pipelines and uses name as label / file as value for Run", () => {
    const src = appSrc();
    expect(src).toMatch(/\/api\/pipelines/);
    expect(src).toMatch(/pipe\.name/);
    expect(src).toMatch(/escAttr\(\s*pipe\.file\s*\)/);
  });

  it("Config is pipeline-centric: Pipelines nav + structure + project settings", () => {
    const html = htmlSrc();
    const src = appSrc();
    expect(html).toMatch(/config-pipeline-list/);
    expect(html).toMatch(/config-project-settings|Project settings/);
    expect(html).toMatch(/config-structure-tree|Structure/);
    expect(src).toMatch(/selectConfigPipeline/);
    expect(src).toMatch(/config-pipeline-item/);
  });
});

describe("listProjectPipelines command stages (issue #18)", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmp();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("S1: extracts command stages with kind and command text", () => {
    fs.writeFileSync(
      path.join(dir, "pipeline.yaml"),
      `name: with-cmd
stages:
  - name: measure
    command: "echo hi"
    gate:
      id: ok
      evidence:
        path: "{stage}/out.json"
        check:
          field: ok
          equals: true
  - name: design
    roles: [designer]
`,
    );
    const list = listProjectPipelines(dir);
    expect(list[0].stages).toHaveLength(2);
    const cmd = list[0].stages.find((s) => s.name === "measure");
    expect(cmd?.kind).toBe("command");
    expect(cmd?.command).toContain("echo");
    expect(cmd?.hasGate).toBe(true);
    expect(cmd?.roles).toEqual([]);
    const agent = list[0].stages.find((s) => s.name === "design");
    expect(agent?.kind).toBe("agent");
  });
});
