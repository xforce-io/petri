import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import * as os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolvePublicDir } from "../../src/web/server.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const distIndex = path.join(repoRoot, "dist", "index.js");
const distPublic = path.join(repoRoot, "dist", "web", "public");

function request(
  port: number,
  urlPath: string,
): Promise<{ status: number; body: string; contentType?: string }> {
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
            contentType: res.headers["content-type"],
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function waitForPort(port: number, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await request(port, "/api/meta");
      if (res.status === 200 || res.status === 404 || res.status === 400) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server on port ${port} did not become ready`);
}

describe("shipped dist public assets", () => {
  it("resolvePublicDir finds a directory with index.html", () => {
    const dir = resolvePublicDir();
    expect(fs.existsSync(path.join(dir, "index.html"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "index.html"), "utf-8")).toMatch(/Petri/i);
  });

  it("postbuild layout places index.html at dist/web/public (not nested public/public)", () => {
    // Requires prior npm run build in CI/local verification; skip if dist missing
    if (!fs.existsSync(distIndex)) {
      console.warn("dist/index.js missing — run npm run build first");
      return;
    }
    expect(fs.existsSync(path.join(distPublic, "index.html"))).toBe(true);
    expect(fs.existsSync(path.join(distPublic, "app.js"))).toBe(true);
    // Nested copy regression (cp -r into existing dir)
    expect(fs.existsSync(path.join(distPublic, "public", "index.html"))).toBe(false);
  });
});

describe("shipped bin: node dist/index.js web on empty workspace", () => {
  let child: ChildProcess | null = null;
  let workspace: string;
  let port: number;

  beforeAll(async () => {
    if (!fs.existsSync(distIndex)) {
      throw new Error("dist/index.js missing — run npm run build before this suite");
    }
    if (!fs.existsSync(path.join(distPublic, "index.html"))) {
      throw new Error("dist/web/public/index.html missing — postbuild failed");
    }

    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "petri-dist-web-"));
    // Pick a free port
    port = await new Promise<number>((resolve, reject) => {
      const s = http.createServer();
      s.listen(0, "127.0.0.1", () => {
        const addr = s.address();
        const p = typeof addr === "object" && addr ? addr.port : 0;
        s.close(() => resolve(p));
      });
      s.on("error", reject);
    });

    child = spawn(process.execPath, [distIndex, "web", "--port", String(port)], {
      cwd: workspace,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.stdout?.on("data", () => {
      /* drain */
    });

    try {
      await waitForPort(port);
    } catch (e) {
      child.kill("SIGKILL");
      throw new Error(`dist web failed to start: ${e}\nstderr=${stderr}`);
    }
  }, 20_000);

  afterAll(async () => {
    if (child && !child.killed) {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 200));
      if (!child.killed) child.kill("SIGKILL");
    }
    if (workspace && fs.existsSync(workspace)) {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("GET / returns 200 product home with onboarding HTML", async () => {
    const res = await request(port, "/");
    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/text\/html/);
    expect(res.body).toMatch(/Petri/i);
    expect(res.body).toMatch(/onboarding/i);
    expect(res.body).toMatch(/new-project-btn|Create project/i);
  });

  it("GET /api/projects is empty on empty workspace", async () => {
    const res = await request(port, "/api/projects");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it("POST /api/projects from shipped server applies preset template on disk", async () => {
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const body = JSON.stringify({ name: "shipped-demo", template: "code-dev" });
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/projects",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (r) => {
          const chunks: Buffer[] = [];
          r.on("data", (c) => chunks.push(c));
          r.on("end", () =>
            resolve({ status: r.statusCode!, body: Buffer.concat(chunks).toString() }),
          );
        },
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
    expect(res.status).toBe(201);
    expect(fs.existsSync(path.join(workspace, "shipped-demo", "petri.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "shipped-demo", "pipeline.yaml"))).toBe(true);
  });
});
