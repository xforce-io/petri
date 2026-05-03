import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { RunLogger } from "../../src/engine/logger.js";
import { createPetriServer, type ServerResult } from "../../src/web/server.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "petri-web-test-"));
}

function request(
  port: number,
  urlPath: string,
  method = "GET",
  body?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method, headers: body ? { "Content-Type": "application/json" } : {} },
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

describe("Petri Web Server", () => {
  let tmpDir: string;
  let result: ServerResult;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    // Create a minimal project structure
    fs.writeFileSync(path.join(tmpDir, "petri.yaml"), "providers:\n  pi:\n    type: pi\n", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "pipeline.yaml"), "name: test\nstages: []\n", "utf-8");
    fs.mkdirSync(path.join(tmpDir, "roles", "dev"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "roles", "dev", "role.yaml"), "persona: dev\nskills: []\n", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "roles", "dev", "soul.md"), "# Dev Soul\n", "utf-8");
    fs.mkdirSync(path.join(tmpDir, "roles", "dev", "skills"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "roles", "dev", "skills", "coding.md"), "# Coding\n", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "roles", "dev", "gate.yaml"), "id: tests-pass\nevidence:\n  path: output.json\n", "utf-8");

    result = await createPetriServer({ projectDir: tmpDir, port: 0 });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => result.server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("serves index.html on GET /", async () => {
    const res = await request(result.port, "/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("<!DOCTYPE html>");
    expect(res.body).toContain("Petri");
  });

  it("returns 404 for unknown routes", async () => {
    const res = await request(result.port, "/unknown-path");
    expect(res.status).toBe(404);
  });

  describe("GET /api/runs", () => {
    it("returns empty list when no runs", async () => {
      const res = await request(result.port, "/api/runs");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data).toEqual([]);
    });

    it("returns run list after creating a run", async () => {
      const petriDir = path.join(tmpDir, ".petri");
      const logger = new RunLogger(petriDir, "test-pipe", "test input");
      logger.finish("done");

      const res = await request(result.port, "/api/runs");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data).toHaveLength(1);
      expect(data[0].runId).toBe("001");
      expect(data[0].pipeline).toBe("test-pipe");
      expect(data[0].status).toBe("done");
    });
  });

  describe("GET /api/runs/:id", () => {
    it("returns run detail", async () => {
      const petriDir = path.join(tmpDir, ".petri");
      const logger = new RunLogger(petriDir, "test-pipe", "test input");
      logger.finish("done");

      const res = await request(result.port, "/api/runs/001");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.runId).toBe("001");
      expect(data.pipeline).toBe("test-pipe");
      expect(data.status).toBe("done");
    });

    it("returns 404 for missing run", async () => {
      const res = await request(result.port, "/api/runs/999");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/runs/:id/log", () => {
    it("returns log text", async () => {
      const petriDir = path.join(tmpDir, ".petri");
      const logger = new RunLogger(petriDir, "test-pipe", "test input");
      logger.finish("done");

      const res = await request(result.port, "/api/runs/001/log");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/plain");
      expect(res.body).toContain("Pipeline: test-pipe");
    });
  });

  describe("GET /api/config/files", () => {
    it("lists project files", async () => {
      const res = await request(result.port, "/api/config/files");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data).toBeInstanceOf(Array);
      expect(data).toContain("petri.yaml");
      expect(data).toContain("pipeline.yaml");
      expect(data).toContain("roles/dev/role.yaml");
      expect(data).toContain("roles/dev/soul.md");
      expect(data).toContain("roles/dev/gate.yaml");
      expect(data).toContain("roles/dev/skills/coding.md");
    });
  });

  describe("GET /api/config/file", () => {
    it("reads file content", async () => {
      const res = await request(result.port, "/api/config/file?path=petri.yaml");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.content).toContain("providers:");
    });

    it("rejects path traversal", async () => {
      const res = await request(result.port, "/api/config/file?path=../../../etc/passwd");
      expect(res.status).toBe(403);
    });
  });

  describe("PUT /api/config/file", () => {
    it("saves valid content", async () => {
      const newContent = "name: updated\nstages: []\n";
      const res = await request(
        result.port,
        "/api/config/file?path=pipeline.yaml",
        "PUT",
        JSON.stringify({ content: newContent }),
      );
      expect(res.status).toBe(200);
      const saved = fs.readFileSync(path.join(tmpDir, "pipeline.yaml"), "utf-8");
      expect(saved).toBe(newContent);
    });

    it("rejects invalid YAML", async () => {
      const res = await request(
        result.port,
        "/api/config/file?path=pipeline.yaml",
        "PUT",
        JSON.stringify({ content: ":\n  - :\n    invalid: [unterminated" }),
      );
      expect(res.status).toBe(400);
    });

    it("rejects path traversal", async () => {
      const res = await request(
        result.port,
        "/api/config/file?path=../../etc/passwd",
        "PUT",
        JSON.stringify({ content: "hack" }),
      );
      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/templates", () => {
    it("returns a JSON array with at least the code-dev template", async () => {
      const res = await request(result.port, "/api/templates");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThanOrEqual(1);

      const codeDev = data.find((t: { id: string }) => t.id === "code-dev");
      expect(codeDev).toBeDefined();
      expect(codeDev.id).toBe("code-dev");
      expect(codeDev.name).toBe("code-dev");
      expect(codeDev.description).toBe("Software development pipeline — design, then iterate develop+review until approved");
      expect(codeDev.stages).toEqual(["design", "develop", "review"]);
      expect(codeDev.roles).toEqual(["designer", "developer", "code_reviewer"]);
    });
  });

  describe("POST /api/runs", () => {
    it("returns 400 for missing input", async () => {
      const res = await request(result.port, "/api/runs", "POST", "{}");
      expect(res.status).toBe(400);
      const data = JSON.parse(res.body);
      expect(data.error).toContain("input");
    });

    it("returns 400 for invalid JSON", async () => {
      const res = await request(result.port, "/api/runs", "POST", "not-json");
      expect(res.status).toBe(400);
    });

    it("starts a run and returns runId", async () => {
      // Set up a minimal project with proper petri.yaml (with defaults) and
      // an empty pipeline so the engine finishes immediately without calling any provider.
      fs.writeFileSync(
        path.join(tmpDir, "petri.yaml"),
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
        path.join(tmpDir, "pipeline.yaml"),
        [
          "name: test-pipeline",
          "stages: []",
        ].join("\n"),
        "utf-8",
      );

      const res = await request(
        result.port,
        "/api/runs",
        "POST",
        JSON.stringify({ input: "Build a hello world app" }),
      );
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.runId).toBeDefined();
      expect(typeof data.runId).toBe("string");

      // Wait briefly for the async engine.run() to finish
      await new Promise((r) => setTimeout(r, 200));
    });
  });
});
