# Web Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `petri web` command that launches a local HTTP server providing pipeline monitoring, run management, and config editing.

**Architecture:** Node native `http` server in `src/web/`, frontend is pure HTML+CSS+JS in `src/web/public/`. RunLogger gains EventEmitter for real-time SSE push. Three top-level tabs: Dashboard, Runs, Config.

**Tech Stack:** Node `http` + `EventEmitter`, vanilla JS frontend, SSE for real-time updates, no frameworks.

---

## File Structure

```
src/
  cli/
    web.ts                      # NEW — petri web CLI command
    index.ts                    # MODIFY — register web command
  engine/
    logger.ts                   # MODIFY — extend RunLogger with EventEmitter
  web/
    server.ts                   # NEW — HTTP server + router
    routes/
      api.ts                    # NEW — REST API handlers
      sse.ts                    # NEW — SSE event stream handler
    runner.ts                   # NEW — run orchestration (create engine, track active runs)
    public/
      index.html                # NEW — SPA shell
      app.js                    # NEW — frontend logic
      style.css                 # NEW — dark theme styles
tests/
  engine/
    logger.test.ts              # MODIFY — add EventEmitter tests
  web/
    api.test.ts                 # NEW — API endpoint tests
    sse.test.ts                 # NEW — SSE tests
```

---

### Task 1: RunLogger EventEmitter

**Files:**
- Modify: `src/engine/logger.ts`
- Test: `tests/engine/logger.test.ts`

- [ ] **Step 1: Write failing tests for EventEmitter events**

Add to `tests/engine/logger.test.ts`:

```typescript
describe("RunLogger events", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits stage-start on logStageAttempt", () => {
    const petriDir = path.join(tmpDir, ".petri");
    const logger = new RunLogger(petriDir, "pipe", "input");
    const events: any[] = [];
    logger.on("stage-start", (e) => events.push(e));

    logger.logStageAttempt("design", 1, 3);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ stage: "design", attempt: 1, max: 3 });
  });

  it("emits role-start on logRoleStart", () => {
    const petriDir = path.join(tmpDir, ".petri");
    const logger = new RunLogger(petriDir, "pipe", "input");
    const events: any[] = [];
    logger.on("role-start", (e) => events.push(e));

    logger.logRoleStart("design", "designer", "sonnet");

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ stage: "design", role: "designer", model: "sonnet" });
  });

  it("emits role-end on logRoleEnd", () => {
    const petriDir = path.join(tmpDir, ".petri");
    const logger = new RunLogger(petriDir, "pipe", "input");
    const events: any[] = [];
    logger.on("role-end", (e) => events.push(e));

    const timer = logger.logRoleStart("design", "designer", "sonnet");
    logger.logRoleEnd(timer, {
      gatePassed: true,
      gateReason: "passed",
      usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
      artifacts: ["output.json"],
    });

    expect(events).toHaveLength(1);
    expect(events[0].stage).toBe("design");
    expect(events[0].role).toBe("designer");
    expect(events[0].gatePassed).toBe(true);
  });

  it("emits gate-result on logGateResult", () => {
    const petriDir = path.join(tmpDir, ".petri");
    const logger = new RunLogger(petriDir, "pipe", "input");
    const events: any[] = [];
    logger.on("gate-result", (e) => events.push(e));

    logger.logGateResult("design", true, "1/1 gates passed");

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ stage: "design", passed: true, reason: "1/1 gates passed" });
  });

  it("emits run-end on finish", () => {
    const petriDir = path.join(tmpDir, ".petri");
    const logger = new RunLogger(petriDir, "pipe", "input");
    const events: any[] = [];
    logger.on("run-end", (e) => events.push(e));

    logger.finish("done");

    expect(events).toHaveLength(1);
    expect(events[0].runId).toBe("001");
    expect(events[0].status).toBe("done");
    expect(typeof events[0].durationMs).toBe("number");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/engine/logger.test.ts`
Expected: FAIL — `logger.on is not a function`

- [ ] **Step 3: Implement EventEmitter on RunLogger**

Modify `src/engine/logger.ts`:

```typescript
// Add import at top
import { EventEmitter } from "node:events";

// Change class declaration
export class RunLogger extends EventEmitter {
  readonly runDir: string;
  readonly runId: string;
  private logPath: string;
  private jsonPath: string;
  private runLog: RunLog;

  constructor(petriDir: string, pipelineName: string, input: string, goal?: string) {
    super();  // ADD THIS LINE
    const runsDir = join(petriDir, "runs");
    // ... rest of constructor unchanged ...
  }

  // In logStageAttempt, add emit after append:
  logStageAttempt(stage: string, attempt: number, maxAttempts: number): void {
    this.append(`Stage "${stage}" attempt ${attempt}/${maxAttempts}`);
    this.emit("stage-start", { stage, attempt, max: maxAttempts });
  }

  // In logRoleStart, add emit before return:
  logRoleStart(stage: string, role: string, model: string): StageTimer {
    this.append(`  ${stage}/${role} — model: ${model}`);
    this.emit("role-start", { stage, role, model });
    return { stage, role, model, startedAt: new Date() };
  }

  // In logRoleEnd, add emit after append block:
  // (after the artifacts append, before the closing brace)
  // Add at end of method:
  //   this.emit("role-end", { stage: timer.stage, role: timer.role, gatePassed: opts.gatePassed, gateReason: opts.gateReason, usage: opts.usage, artifacts: opts.artifacts, durationMs });

  // In logGateResult, add emit after append:
  logGateResult(stage: string, passed: boolean, reason: string): void {
    const icon = passed ? "PASS" : "FAIL";
    this.append(`  Gate [${icon}]: ${reason}`);
    this.emit("gate-result", { stage, passed, reason });
  }

  // In finish, add emit at end (after writeFileSync):
  //   this.emit("run-end", { runId: this.runId, status, blockedStage, blockedReason, durationMs: this.runLog.durationMs });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/engine/logger.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS (EventEmitter is no-op when no listeners)

- [ ] **Step 6: Commit**

```bash
git add src/engine/logger.ts tests/engine/logger.test.ts
git commit -m "feat: add EventEmitter to RunLogger for real-time event streaming"
```

---

### Task 2: HTTP Server + Router

**Files:**
- Create: `src/web/server.ts`
- Test: `tests/web/api.test.ts`

- [ ] **Step 1: Write failing test for server startup and static file serving**

Create `tests/web/api.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createPetriServer } from "../../src/web/server.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "petri-web-test-"));
}

function request(port: number, urlPath: string, method = "GET", body?: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      hostname: "127.0.0.1",
      port,
      path: urlPath,
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode!, body: data, headers: res.headers }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

describe("Petri Web Server", () => {
  let server: http.Server;
  let tmpDir: string;
  let port: number;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("serves index.html on GET /", async () => {
    tmpDir = makeTmpDir();
    const result = createPetriServer({ projectDir: tmpDir, port: 0 });
    server = result.server;
    port = result.port;

    const res = await request(port, "/");
    expect(res.status).toBe(200);
    expect(res.body).toContain("<!DOCTYPE html>");
    expect(res.body).toContain("Petri");
  });

  it("returns 404 for unknown routes", async () => {
    tmpDir = makeTmpDir();
    const result = createPetriServer({ projectDir: tmpDir, port: 0 });
    server = result.server;
    port = result.port;

    const res = await request(port, "/nonexistent");
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/web/api.test.ts`
Expected: FAIL — cannot resolve `../../src/web/server.js`

- [ ] **Step 3: Implement server with static file serving and router**

Create `src/web/server.ts`:

```typescript
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

export interface ServerOptions {
  projectDir: string;
  port: number;
}

export interface ServerResult {
  server: http.Server;
  port: number;
}

export function createPetriServer(opts: ServerOptions): ServerResult {
  const publicDir = resolvePublicDir();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const pathname = url.pathname;

    // API routes
    if (pathname.startsWith("/api/")) {
      handleApi(req, res, url, opts.projectDir);
      return;
    }

    // Static files
    let filePath: string;
    if (pathname === "/") {
      filePath = path.join(publicDir, "index.html");
    } else if (pathname.startsWith("/public/")) {
      filePath = path.join(publicDir, pathname.slice("/public/".length));
    } else {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    serveFile(res, filePath);
  });

  const actualPort = opts.port;
  server.listen(actualPort, "127.0.0.1");

  // Wait for listening to get actual port (for port 0)
  const address = server.address();
  const resolvedPort = typeof address === "object" && address ? address.port : actualPort;

  return { server, port: resolvedPort };
}

function resolvePublicDir(): string {
  const candidates = [
    path.join(__dirname, "public"),                          // dev: src/web/public
    path.join(__dirname, "..", "web", "public"),              // bundled: dist/../web/public
    path.join(__dirname, "..", "..", "src", "web", "public"), // bundled fallback
  ];
  return candidates.find((d) => fs.existsSync(d)) ?? candidates[0];
}

function serveFile(res: http.ServerResponse, filePath: string): void {
  if (!fs.existsSync(filePath)) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
  const content = fs.readFileSync(filePath);
  res.writeHead(200, { "Content-Type": contentType });
  res.end(content);
}

function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL, projectDir: string): void {
  // Placeholder — filled in Task 3
  sendJson(res, 404, { error: "API not implemented" });
}

export function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
```

- [ ] **Step 4: Create minimal index.html**

Create `src/web/public/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Petri Dashboard</title>
  <link rel="stylesheet" href="/public/style.css">
</head>
<body>
  <nav id="tab-bar">
    <div class="logo">Petri</div>
    <button class="tab active" data-tab="dashboard">Dashboard</button>
    <button class="tab" data-tab="runs">Runs</button>
    <button class="tab" data-tab="config">Config</button>
  </nav>
  <main>
    <div id="tab-dashboard" class="tab-content active">
      <div id="dashboard-empty" class="empty-state">No runs yet. Go to Runs tab to start one.</div>
      <div id="dashboard-main" class="dashboard-layout" style="display:none;">
        <aside id="timeline"></aside>
        <section id="detail-panel"></section>
      </div>
    </div>
    <div id="tab-runs" class="tab-content">
      <div class="runs-content"></div>
    </div>
    <div id="tab-config" class="tab-content">
      <div class="config-content"></div>
    </div>
  </main>
  <script src="/public/app.js"></script>
</body>
</html>
```

- [ ] **Step 5: Create minimal style.css and app.js**

Create `src/web/public/style.css`:

```css
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #c9d1d9; }
nav#tab-bar { display: flex; align-items: center; gap: 0; background: #161b22; border-bottom: 1px solid #30363d; padding: 0 16px; }
nav .logo { font-weight: 700; font-size: 16px; color: #58a6ff; padding: 12px 16px 12px 0; margin-right: 8px; }
nav .tab { background: none; border: none; color: #8b949e; padding: 12px 16px; cursor: pointer; font-size: 14px; border-bottom: 2px solid transparent; }
nav .tab:hover { color: #c9d1d9; }
nav .tab.active { color: #c9d1d9; border-bottom-color: #58a6ff; }
main { padding: 0; }
.tab-content { display: none; padding: 20px; }
.tab-content.active { display: block; }
.empty-state { text-align: center; color: #8b949e; padding: 80px 20px; font-size: 15px; }
.dashboard-layout { display: flex; min-height: calc(100vh - 49px); }
.dashboard-layout aside { width: 280px; border-right: 1px solid #30363d; padding: 16px; flex-shrink: 0; }
.dashboard-layout section { flex: 1; padding: 16px; overflow-y: auto; }
```

Create `src/web/public/app.js`:

```javascript
// Tab switching
document.querySelectorAll('nav .tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav .tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/web/api.test.ts`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add src/web/ tests/web/
git commit -m "feat: add web server skeleton with static file serving"
```

---

### Task 3: REST API Endpoints

**Files:**
- Create: `src/web/routes/api.ts`
- Create: `src/web/runner.ts`
- Modify: `src/web/server.ts`
- Modify: `tests/web/api.test.ts`

- [ ] **Step 1: Write failing tests for runs API**

Add to `tests/web/api.test.ts`:

```typescript
import { RunLogger } from "../../src/engine/logger.js";

describe("Runs API", () => {
  let server: http.Server;
  let tmpDir: string;
  let port: number;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("GET /api/runs returns empty list when no runs", async () => {
    tmpDir = makeTmpDir();
    const result = createPetriServer({ projectDir: tmpDir, port: 0 });
    server = result.server;
    port = result.port;

    const res = await request(port, "/api/runs");
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data).toEqual([]);
  });

  it("GET /api/runs returns run list after a run", async () => {
    tmpDir = makeTmpDir();
    const petriDir = path.join(tmpDir, ".petri");
    const logger = new RunLogger(petriDir, "test-pipe", "test input");
    logger.finish("done");

    const result = createPetriServer({ projectDir: tmpDir, port: 0 });
    server = result.server;
    port = result.port;

    const res = await request(port, "/api/runs");
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data).toHaveLength(1);
    expect(data[0].runId).toBe("001");
    expect(data[0].pipeline).toBe("test-pipe");
    expect(data[0].status).toBe("done");
  });

  it("GET /api/runs/:id returns run detail", async () => {
    tmpDir = makeTmpDir();
    const petriDir = path.join(tmpDir, ".petri");
    const logger = new RunLogger(petriDir, "test-pipe", "test input");
    logger.finish("done");

    const result = createPetriServer({ projectDir: tmpDir, port: 0 });
    server = result.server;
    port = result.port;

    const res = await request(port, "/api/runs/001");
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.runId).toBe("001");
    expect(data.stages).toBeDefined();
  });

  it("GET /api/runs/:id returns 404 for missing run", async () => {
    tmpDir = makeTmpDir();
    const result = createPetriServer({ projectDir: tmpDir, port: 0 });
    server = result.server;
    port = result.port;

    const res = await request(port, "/api/runs/999");
    expect(res.status).toBe(404);
  });

  it("GET /api/runs/:id/log returns log text", async () => {
    tmpDir = makeTmpDir();
    const petriDir = path.join(tmpDir, ".petri");
    const logger = new RunLogger(petriDir, "test-pipe", "test input");
    logger.append("custom line");
    logger.finish("done");

    const result = createPetriServer({ projectDir: tmpDir, port: 0 });
    server = result.server;
    port = result.port;

    const res = await request(port, "/api/runs/001/log");
    expect(res.status).toBe(200);
    expect(res.body).toContain("custom line");
  });
});
```

- [ ] **Step 2: Write failing tests for config API**

Add to `tests/web/api.test.ts`:

```typescript
describe("Config API", () => {
  let server: http.Server;
  let tmpDir: string;
  let port: number;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("GET /api/config/files lists project files", async () => {
    tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, "petri.yaml"), "providers: {}\nmodels: {}\ndefaults:\n  model: sonnet\n  gate_strategy: all\n  max_retries: 3\n");
    fs.writeFileSync(path.join(tmpDir, "pipeline.yaml"), "name: test\nstages: []\n");

    const result = createPetriServer({ projectDir: tmpDir, port: 0 });
    server = result.server;
    port = result.port;

    const res = await request(port, "/api/config/files");
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.some((f: any) => f.path === "petri.yaml")).toBe(true);
    expect(data.some((f: any) => f.path === "pipeline.yaml")).toBe(true);
  });

  it("GET /api/config/file reads file content", async () => {
    tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, "petri.yaml"), "hello: world\n");

    const result = createPetriServer({ projectDir: tmpDir, port: 0 });
    server = result.server;
    port = result.port;

    const res = await request(port, "/api/config/file?path=petri.yaml");
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.content).toBe("hello: world\n");
  });

  it("PUT /api/config/file saves valid file", async () => {
    tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, "petri.yaml"), "old content");

    const result = createPetriServer({ projectDir: tmpDir, port: 0 });
    server = result.server;
    port = result.port;

    const res = await request(port, "/api/config/file?path=petri.yaml", "PUT", JSON.stringify({ content: "new content" }));
    expect(res.status).toBe(200);
    expect(fs.readFileSync(path.join(tmpDir, "petri.yaml"), "utf-8")).toBe("new content");
  });

  it("PUT /api/config/file rejects invalid YAML", async () => {
    tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, "petri.yaml"), "valid: yaml\n");

    const result = createPetriServer({ projectDir: tmpDir, port: 0 });
    server = result.server;
    port = result.port;

    const res = await request(port, "/api/config/file?path=petri.yaml", "PUT", JSON.stringify({ content: ":\ninvalid:\n  - :\n  bad" }));
    expect(res.status).toBe(400);
    const data = JSON.parse(res.body);
    expect(data.error).toBeDefined();
  });

  it("PUT /api/config/file rejects path traversal", async () => {
    tmpDir = makeTmpDir();

    const result = createPetriServer({ projectDir: tmpDir, port: 0 });
    server = result.server;
    port = result.port;

    const res = await request(port, "/api/config/file?path=../../etc/passwd", "PUT", JSON.stringify({ content: "hack" }));
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/web/api.test.ts`
Expected: FAIL — API endpoints return 404

- [ ] **Step 4: Implement API routes**

Create `src/web/routes/api.ts`:

```typescript
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { listRuns, loadRunLog } from "../../engine/logger.js";
import { sendJson, readBody } from "../server.js";

export function handleApiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  projectDir: string,
): void {
  const method = req.method ?? "GET";
  const pathname = url.pathname;

  // GET /api/runs
  if (pathname === "/api/runs" && method === "GET") {
    return handleListRuns(res, projectDir);
  }

  // GET /api/runs/:id
  const runMatch = pathname.match(/^\/api\/runs\/(\d{3})$/);
  if (runMatch && method === "GET") {
    return handleGetRun(res, projectDir, runMatch[1]);
  }

  // GET /api/runs/:id/log
  const logMatch = pathname.match(/^\/api\/runs\/(\d{3})\/log$/);
  if (logMatch && method === "GET") {
    return handleGetRunLog(res, projectDir, logMatch[1]);
  }

  // GET /api/runs/:id/artifacts
  const artifactsMatch = pathname.match(/^\/api\/runs\/(\d{3})\/artifacts$/);
  if (artifactsMatch && method === "GET") {
    return handleGetArtifacts(res, projectDir, artifactsMatch[1]);
  }

  // GET /api/runs/:id/artifacts/*
  const artifactFileMatch = pathname.match(/^\/api\/runs\/(\d{3})\/artifacts\/(.+)$/);
  if (artifactFileMatch && method === "GET") {
    return handleGetArtifactFile(res, projectDir, artifactFileMatch[2]);
  }

  // POST /api/runs
  if (pathname === "/api/runs" && method === "POST") {
    handleStartRun(req, res, projectDir);
    return;
  }

  // GET /api/config/files
  if (pathname === "/api/config/files" && method === "GET") {
    return handleListConfigFiles(res, projectDir);
  }

  // GET /api/config/file
  if (pathname === "/api/config/file" && method === "GET") {
    return handleReadConfigFile(res, url, projectDir);
  }

  // PUT /api/config/file
  if (pathname === "/api/config/file" && method === "PUT") {
    handleWriteConfigFile(req, res, url, projectDir);
    return;
  }

  sendJson(res, 404, { error: "API endpoint not found" });
}

function handleListRuns(res: http.ServerResponse, projectDir: string): void {
  const runsDir = path.join(projectDir, ".petri", "runs");
  const runNames = listRuns(runsDir);
  const runs = runNames.map((name) => {
    const runLog = loadRunLog(path.join(runsDir, name));
    if (!runLog) return { runId: name.replace("run-", ""), pipeline: "unknown", status: "unknown" };
    return {
      runId: runLog.runId,
      pipeline: runLog.pipeline,
      status: runLog.status ?? "running",
      startedAt: runLog.startedAt,
      durationMs: runLog.durationMs,
      totalUsage: runLog.totalUsage,
    };
  });
  sendJson(res, 200, runs);
}

function handleGetRun(res: http.ServerResponse, projectDir: string, runId: string): void {
  const runDir = path.join(projectDir, ".petri", "runs", `run-${runId}`);
  const runLog = loadRunLog(runDir);
  if (!runLog) {
    sendJson(res, 404, { error: `Run ${runId} not found` });
    return;
  }
  sendJson(res, 200, runLog);
}

function handleGetRunLog(res: http.ServerResponse, projectDir: string, runId: string): void {
  const logPath = path.join(projectDir, ".petri", "runs", `run-${runId}`, "run.log");
  if (!fs.existsSync(logPath)) {
    sendJson(res, 404, { error: `Run ${runId} log not found` });
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(fs.readFileSync(logPath, "utf-8"));
}

function handleGetArtifacts(res: http.ServerResponse, projectDir: string, runId: string): void {
  const artifactsDir = path.join(projectDir, ".petri", "artifacts");
  if (!fs.existsSync(artifactsDir)) {
    sendJson(res, 200, []);
    return;
  }
  const files = collectFiles(artifactsDir, artifactsDir);
  sendJson(res, 200, files);
}

function handleGetArtifactFile(res: http.ServerResponse, projectDir: string, relativePath: string): void {
  const fullPath = path.join(projectDir, ".petri", "artifacts", relativePath);
  const resolved = path.resolve(fullPath);
  const base = path.resolve(path.join(projectDir, ".petri", "artifacts"));
  if (!resolved.startsWith(base)) {
    sendJson(res, 400, { error: "Invalid path" });
    return;
  }
  if (!fs.existsSync(resolved)) {
    sendJson(res, 404, { error: "Artifact not found" });
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(fs.readFileSync(resolved, "utf-8"));
}

async function handleStartRun(req: http.IncomingMessage, res: http.ServerResponse, projectDir: string): Promise<void> {
  // Implemented in Task 5 (runner.ts)
  sendJson(res, 501, { error: "Run start not yet implemented" });
}

function handleListConfigFiles(res: http.ServerResponse, projectDir: string): void {
  const files: Array<{ path: string; type: string }> = [];

  // Top-level config files
  for (const name of ["petri.yaml", "pipeline.yaml"]) {
    if (fs.existsSync(path.join(projectDir, name))) {
      files.push({ path: name, type: "config" });
    }
  }

  // Additional pipeline files
  try {
    for (const f of fs.readdirSync(projectDir)) {
      if (f.startsWith("pipeline") && f.endsWith(".yaml") && f !== "pipeline.yaml") {
        files.push({ path: f, type: "pipeline" });
      }
    }
  } catch { /* ignore */ }

  // Role files
  const rolesDir = path.join(projectDir, "roles");
  if (fs.existsSync(rolesDir)) {
    for (const roleName of fs.readdirSync(rolesDir)) {
      const roleDir = path.join(rolesDir, roleName);
      if (!fs.statSync(roleDir).isDirectory()) continue;
      for (const file of ["role.yaml", "soul.md", "gate.yaml"]) {
        if (fs.existsSync(path.join(roleDir, file))) {
          files.push({ path: `roles/${roleName}/${file}`, type: "role" });
        }
      }
      const skillsDir = path.join(roleDir, "skills");
      if (fs.existsSync(skillsDir)) {
        for (const skill of fs.readdirSync(skillsDir)) {
          files.push({ path: `roles/${roleName}/skills/${skill}`, type: "skill" });
        }
      }
    }
  }

  sendJson(res, 200, files);
}

function handleReadConfigFile(res: http.ServerResponse, url: URL, projectDir: string): void {
  const filePath = url.searchParams.get("path");
  if (!filePath) {
    sendJson(res, 400, { error: "Missing path parameter" });
    return;
  }
  const fullPath = path.join(projectDir, filePath);
  const resolved = path.resolve(fullPath);
  if (!resolved.startsWith(path.resolve(projectDir))) {
    sendJson(res, 400, { error: "Invalid path" });
    return;
  }
  if (!fs.existsSync(resolved)) {
    sendJson(res, 404, { error: "File not found" });
    return;
  }
  sendJson(res, 200, { content: fs.readFileSync(resolved, "utf-8") });
}

async function handleWriteConfigFile(req: http.IncomingMessage, res: http.ServerResponse, url: URL, projectDir: string): Promise<void> {
  const filePath = url.searchParams.get("path");
  if (!filePath) {
    sendJson(res, 400, { error: "Missing path parameter" });
    return;
  }
  const fullPath = path.join(projectDir, filePath);
  const resolved = path.resolve(fullPath);
  if (!resolved.startsWith(path.resolve(projectDir))) {
    sendJson(res, 400, { error: "Invalid path" });
    return;
  }

  const body = await readBody(req);
  let content: string;
  try {
    const parsed = JSON.parse(body);
    content = parsed.content;
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return;
  }

  // Validate YAML files
  if (filePath.endsWith(".yaml") || filePath.endsWith(".yml")) {
    try {
      parseYaml(content);
    } catch (err: any) {
      sendJson(res, 400, { error: `YAML syntax error: ${err.message}` });
      return;
    }
  }

  fs.writeFileSync(resolved, content, "utf-8");
  sendJson(res, 200, { ok: true });
}

function collectFiles(dir: string, baseDir: string): Array<{ path: string; size: number }> {
  const results: Array<{ path: string; size: number }> = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "attempts" || entry.name === "manifest.json") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath, baseDir));
    } else {
      results.push({ path: path.relative(baseDir, fullPath), size: fs.statSync(fullPath).size });
    }
  }
  return results;
}
```

- [ ] **Step 5: Wire API routes into server.ts**

In `src/web/server.ts`, replace the `handleApi` placeholder function:

```typescript
import { handleApiRequest } from "./routes/api.js";

// Replace handleApi function with:
function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL, projectDir: string): void {
  handleApiRequest(req, res, url, projectDir);
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/web/api.test.ts`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add src/web/routes/api.ts src/web/server.ts tests/web/api.test.ts
git commit -m "feat: add REST API endpoints for runs and config"
```

---

### Task 4: SSE Event Streaming

**Files:**
- Create: `src/web/routes/sse.ts`
- Modify: `src/web/server.ts`
- Create: `tests/web/sse.test.ts`

- [ ] **Step 1: Write failing test for SSE endpoint**

Create `tests/web/sse.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createPetriServer } from "../../src/web/server.js";
import { RunLogger } from "../../src/engine/logger.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "petri-sse-test-"));
}

function sseRequest(port: number, urlPath: string): Promise<{ status: number; events: string[] }> {
  return new Promise((resolve, reject) => {
    const events: string[] = [];
    const req = http.request({ hostname: "127.0.0.1", port, path: urlPath }, (res) => {
      res.on("data", (chunk) => {
        const lines = chunk.toString().split("\n");
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            events.push(line.slice(6));
          }
        }
      });
      // Give it a moment to collect events, then resolve
      setTimeout(() => {
        req.destroy();
        resolve({ status: res.statusCode!, events });
      }, 200);
    });
    req.on("error", (err) => {
      if ((err as any).code === "ECONNRESET") {
        resolve({ status: 200, events });
      } else {
        reject(err);
      }
    });
    req.end();
  });
}

describe("SSE endpoint", () => {
  let server: http.Server;
  let tmpDir: string;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("streams events from active run logger", async () => {
    tmpDir = makeTmpDir();
    const petriDir = path.join(tmpDir, ".petri");
    const logger = new RunLogger(petriDir, "pipe", "input");

    const result = createPetriServer({ projectDir: tmpDir, port: 0 });
    server = result.server;

    // Register logger as active run
    result.activeRuns.set(logger.runId, logger);

    // Start SSE connection, then emit events
    const ssePromise = sseRequest(result.port, `/api/events/${logger.runId}`);

    // Small delay to let SSE connection establish
    await new Promise((r) => setTimeout(r, 50));
    logger.logStageAttempt("design", 1, 3);
    logger.logGateResult("design", true, "passed");

    const sse = await ssePromise;
    expect(sse.status).toBe(200);
    expect(sse.events.length).toBeGreaterThanOrEqual(2);

    const parsed = sse.events.map((e) => JSON.parse(e));
    expect(parsed.some((e: any) => e.type === "stage-start")).toBe(true);
    expect(parsed.some((e: any) => e.type === "gate-result")).toBe(true);
  });

  it("returns 404 for non-active run", async () => {
    tmpDir = makeTmpDir();
    const result = createPetriServer({ projectDir: tmpDir, port: 0 });
    server = result.server;

    const res = await new Promise<number>((resolve) => {
      const req = http.request({ hostname: "127.0.0.1", port: result.port, path: "/api/events/999" }, (res) => {
        resolve(res.statusCode!);
        req.destroy();
      });
      req.end();
    });
    expect(res).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/web/sse.test.ts`
Expected: FAIL — `activeRuns` not exposed, SSE route not implemented

- [ ] **Step 3: Implement SSE route**

Create `src/web/routes/sse.ts`:

```typescript
import * as http from "node:http";
import type { RunLogger } from "../../engine/logger.js";
import { sendJson } from "../server.js";

export function handleSseRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
  activeRuns: Map<string, RunLogger>,
): void {
  const logger = activeRuns.get(runId);
  if (!logger) {
    sendJson(res, 404, { error: `No active run with id ${runId}` });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  function send(type: string, data: any): void {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  }

  const onStageStart = (e: any) => send("stage-start", e);
  const onRoleStart = (e: any) => send("role-start", e);
  const onRoleEnd = (e: any) => send("role-end", e);
  const onGateResult = (e: any) => send("gate-result", e);
  const onRunEnd = (e: any) => {
    send("run-end", e);
    cleanup();
    res.end();
  };

  logger.on("stage-start", onStageStart);
  logger.on("role-start", onRoleStart);
  logger.on("role-end", onRoleEnd);
  logger.on("gate-result", onGateResult);
  logger.on("run-end", onRunEnd);

  function cleanup(): void {
    logger.off("stage-start", onStageStart);
    logger.off("role-start", onRoleStart);
    logger.off("role-end", onRoleEnd);
    logger.off("gate-result", onGateResult);
    logger.off("run-end", onRunEnd);
  }

  req.on("close", cleanup);
}
```

- [ ] **Step 4: Update server.ts to expose activeRuns and wire SSE route**

Modify `src/web/server.ts`:

Add `activeRuns` to `ServerResult`:

```typescript
export interface ServerResult {
  server: http.Server;
  port: number;
  activeRuns: Map<string, import("../engine/logger.js").RunLogger>;
}
```

In `createPetriServer`, create the map and pass it:

```typescript
import { handleSseRequest } from "./routes/sse.js";
import type { RunLogger } from "../engine/logger.js";

export function createPetriServer(opts: ServerOptions): ServerResult {
  const publicDir = resolvePublicDir();
  const activeRuns = new Map<string, RunLogger>();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const pathname = url.pathname;

    // SSE events route
    const sseMatch = pathname.match(/^\/api\/events\/(\d{3})$/);
    if (sseMatch) {
      handleSseRequest(req, res, sseMatch[1], activeRuns);
      return;
    }

    // API routes
    if (pathname.startsWith("/api/")) {
      handleApi(req, res, url, opts.projectDir);
      return;
    }

    // Static files (unchanged)
    // ...
  });

  server.listen(actualPort, "127.0.0.1");
  const address = server.address();
  const resolvedPort = typeof address === "object" && address ? address.port : actualPort;

  return { server, port: resolvedPort, activeRuns };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/web/sse.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/web/routes/sse.ts src/web/server.ts tests/web/sse.test.ts
git commit -m "feat: add SSE endpoint for real-time run event streaming"
```

---

### Task 5: Run Orchestration (POST /api/runs)

**Files:**
- Create: `src/web/runner.ts`
- Modify: `src/web/routes/api.ts`
- Modify: `tests/web/api.test.ts`

- [ ] **Step 1: Write failing test for POST /api/runs**

Add to `tests/web/api.test.ts`:

```typescript
describe("POST /api/runs", () => {
  let server: http.Server;
  let tmpDir: string;
  let port: number;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts a run and returns runId", async () => {
    tmpDir = makeTmpDir();
    // Set up a minimal project
    fs.writeFileSync(path.join(tmpDir, "petri.yaml"), `
providers:
  default:
    type: pi
models:
  sonnet:
    provider: default
    model: claude-sonnet-4-6
defaults:
  model: sonnet
  gate_strategy: all
  max_retries: 1
`);
    fs.writeFileSync(path.join(tmpDir, "pipeline.yaml"), `
name: test-pipe
stages:
  - name: step1
    roles: [worker]
`);
    fs.mkdirSync(path.join(tmpDir, "roles", "worker", "skills"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "roles", "worker", "role.yaml"), "persona: worker\nskills: []\n");
    fs.writeFileSync(path.join(tmpDir, "roles", "worker", "soul.md"), "You are a worker.\n");

    const result = createPetriServer({ projectDir: tmpDir, port: 0 });
    server = result.server;
    port = result.port;

    const res = await request(port, "/api/runs", "POST", JSON.stringify({
      pipeline: "pipeline.yaml",
      input: "test input",
    }));
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.runId).toBeDefined();
  });

  it("returns 400 for missing input", async () => {
    tmpDir = makeTmpDir();

    const result = createPetriServer({ projectDir: tmpDir, port: 0 });
    server = result.server;
    port = result.port;

    const res = await request(port, "/api/runs", "POST", JSON.stringify({ pipeline: "pipeline.yaml" }));
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/web/api.test.ts`
Expected: FAIL — POST /api/runs returns 501

- [ ] **Step 3: Implement runner.ts**

Create `src/web/runner.ts`:

```typescript
import * as path from "node:path";
import { loadPetriConfig, loadPipelineConfig, loadRole } from "../config/loader.js";
import { Engine } from "../engine/engine.js";
import { RunLogger } from "../engine/logger.js";
import { PiProvider } from "../providers/pi.js";
import { ClaudeCodeProvider } from "../providers/claude-code.js";
import { isRepeatBlock } from "../types.js";
import type { AgentProvider, LoadedRole } from "../types.js";

export interface StartRunOpts {
  projectDir: string;
  pipelineFile: string;
  input: string;
  activeRuns: Map<string, RunLogger>;
}

export interface StartRunResult {
  runId: string;
  logger: RunLogger;
}

export function startRun(opts: StartRunOpts): StartRunResult {
  const { projectDir, pipelineFile, input, activeRuns } = opts;

  // Load configs
  const petriConfig = loadPetriConfig(projectDir);
  const pipelineConfig = loadPipelineConfig(projectDir, pipelineFile);

  // Collect roles
  const roleNames = new Set<string>();
  for (const entry of pipelineConfig.stages) {
    if (isRepeatBlock(entry)) {
      for (const stage of entry.repeat.stages) {
        for (const role of stage.roles) roleNames.add(role);
      }
    } else {
      for (const role of entry.roles) roleNames.add(role);
    }
  }

  const defaultModel = petriConfig.defaults.model;
  const roles: Record<string, LoadedRole> = {};
  for (const name of roleNames) {
    roles[name] = loadRole(projectDir, name, defaultModel);
  }

  // Create provider
  const defaultProviderType = Object.values(petriConfig.providers)[0]?.type ?? "pi";
  let provider: AgentProvider;
  if (defaultProviderType === "claude_code") {
    provider = new ClaudeCodeProvider(defaultModel);
  } else {
    const modelMappings: Record<string, { piProvider: string; piModel: string }> = {};
    for (const [alias, mc] of Object.entries(petriConfig.models)) {
      modelMappings[alias] = { piProvider: "anthropic", piModel: mc.model };
    }
    provider = new PiProvider(modelMappings);
  }

  // Create logger and engine
  const petriDir = path.join(projectDir, ".petri");
  const artifactBaseDir = path.join(petriDir, "artifacts");
  const logger = new RunLogger(petriDir, pipelineConfig.name, input, pipelineConfig.goal);

  const engine = new Engine({
    provider,
    roles,
    artifactBaseDir,
    defaultGateStrategy: petriConfig.defaults.gate_strategy,
    defaultMaxRetries: petriConfig.defaults.max_retries,
    logger,
  });

  // Register as active and run async
  activeRuns.set(logger.runId, logger);

  engine.run(pipelineConfig, input).then((result) => {
    if (result.status === "done") {
      logger.finish("done");
    } else {
      logger.finish("blocked", result.stage, result.reason);
    }
    activeRuns.delete(logger.runId);
  }).catch((err) => {
    logger.finish("blocked", undefined, String(err));
    activeRuns.delete(logger.runId);
  });

  return { runId: logger.runId, logger };
}
```

- [ ] **Step 4: Wire runner into API route**

In `src/web/routes/api.ts`, update `handleStartRun`:

```typescript
import { startRun } from "../runner.js";
import type { RunLogger } from "../../engine/logger.js";

// Add activeRuns parameter to handleApiRequest signature:
export function handleApiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  projectDir: string,
  activeRuns: Map<string, RunLogger>,
): void {
  // ... existing routing ...

  // Update POST /api/runs handler:
  if (pathname === "/api/runs" && method === "POST") {
    handleStartRun(req, res, projectDir, activeRuns);
    return;
  }
}

async function handleStartRun(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  projectDir: string,
  activeRuns: Map<string, RunLogger>,
): Promise<void> {
  const body = await readBody(req);
  let payload: { pipeline?: string; input?: string };
  try {
    payload = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return;
  }

  if (!payload.input) {
    sendJson(res, 400, { error: "Missing 'input' field" });
    return;
  }

  try {
    const result = startRun({
      projectDir,
      pipelineFile: payload.pipeline ?? "pipeline.yaml",
      input: payload.input,
      activeRuns,
    });
    sendJson(res, 200, { runId: result.runId });
  } catch (err: any) {
    sendJson(res, 400, { error: err.message });
  }
}
```

Also update `server.ts` to pass `activeRuns` to `handleApiRequest`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/web/api.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/web/runner.ts src/web/routes/api.ts src/web/server.ts tests/web/api.test.ts
git commit -m "feat: add POST /api/runs to start pipeline runs from web"
```

---

### Task 6: Frontend — Dashboard Tab

**Files:**
- Modify: `src/web/public/index.html`
- Modify: `src/web/public/app.js`
- Modify: `src/web/public/style.css`

- [ ] **Step 1: Implement Dashboard HTML structure**

Update `src/web/public/index.html`, replace the `#tab-dashboard` div content:

```html
<div id="tab-dashboard" class="tab-content active">
  <div id="dashboard-empty" class="empty-state">No runs yet. Go to Runs tab to start one.</div>
  <div id="dashboard-main" class="dashboard-layout" style="display:none;">
    <aside id="timeline">
      <div class="timeline-header">
        <span class="timeline-title">Stages</span>
        <span id="timeline-summary" class="timeline-summary"></span>
      </div>
      <div id="timeline-stages" class="timeline-stages"></div>
      <div id="timeline-info" class="timeline-info"></div>
    </aside>
    <section id="detail-panel">
      <div id="detail-header" class="detail-header"></div>
      <div class="detail-tabs">
        <button class="detail-tab active" data-detail="log">Log</button>
        <button class="detail-tab" data-detail="artifacts">Artifacts</button>
        <button class="detail-tab" data-detail="gate">Gate</button>
      </div>
      <div id="detail-log" class="detail-content active">
        <pre id="log-output" class="log-output"></pre>
      </div>
      <div id="detail-artifacts" class="detail-content">
        <div id="artifacts-list"></div>
        <pre id="artifact-preview" class="log-output" style="display:none;"></pre>
      </div>
      <div id="detail-gate" class="detail-content">
        <div id="gate-result"></div>
      </div>
    </section>
  </div>
</div>
```

- [ ] **Step 2: Implement Dashboard JS logic in app.js**

Add to `src/web/public/app.js`:

```javascript
// State
let currentRunId = null;
let currentStage = null;
let eventSource = null;

// API helpers
async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (opts.method === 'PUT' || opts.method === 'POST') {
    return { status: res.status, data: await res.json() };
  }
  if (res.headers.get('content-type')?.includes('text/plain')) {
    return { status: res.status, data: await res.text() };
  }
  return { status: res.status, data: await res.json() };
}

// Dashboard
async function loadDashboard(runId) {
  const { status, data } = runId
    ? await api(`/api/runs/${runId}`)
    : await api('/api/runs');

  if (!runId) {
    if (data.length === 0) {
      document.getElementById('dashboard-empty').style.display = '';
      document.getElementById('dashboard-main').style.display = 'none';
      return;
    }
    // Load latest run
    return loadDashboard(data[data.length - 1].runId);
  }

  if (status !== 200) return;
  currentRunId = runId;

  document.getElementById('dashboard-empty').style.display = 'none';
  document.getElementById('dashboard-main').style.display = 'flex';

  renderTimeline(data);
  if (data.stages.length > 0) {
    selectStage(data.stages[data.stages.length - 1].stage, data);
  }

  // Connect SSE if run is still active
  if (!data.status || data.status === 'running') {
    connectSSE(runId);
  }
}

function renderTimeline(runLog) {
  const stagesDiv = document.getElementById('timeline-stages');
  const stageMap = new Map();

  for (const s of runLog.stages) {
    if (!stageMap.has(s.stage)) {
      stageMap.set(s.stage, { roles: [], passed: false, durationMs: 0 });
    }
    const entry = stageMap.get(s.stage);
    if (!entry.roles.includes(s.role)) entry.roles.push(s.role);
    if (s.gatePassed) entry.passed = true;
    entry.durationMs += s.durationMs;
    entry.model = s.model;
  }

  const passed = [...stageMap.values()].filter(s => s.passed).length;
  document.getElementById('timeline-summary').textContent = `${passed}/${stageMap.size} passed`;

  stagesDiv.innerHTML = '';
  for (const [name, info] of stageMap) {
    const statusClass = info.passed ? 'passed' : 'failed';
    const div = document.createElement('div');
    div.className = `timeline-stage ${statusClass}${currentStage === name ? ' selected' : ''}`;
    div.dataset.stage = name;
    div.innerHTML = `
      <div class="stage-dot"></div>
      <div class="stage-info">
        <div class="stage-name">${name}</div>
        <div class="stage-meta">${info.roles.join(', ')} · ${(info.durationMs / 1000).toFixed(1)}s</div>
      </div>
    `;
    div.addEventListener('click', () => selectStage(name, runLog));
    stagesDiv.appendChild(div);
  }

  // Run info
  const infoDiv = document.getElementById('timeline-info');
  const u = runLog.totalUsage;
  infoDiv.innerHTML = `
    <div>Started: ${new Date(runLog.startedAt).toLocaleTimeString()}</div>
    <div>Tokens: ${u.inputTokens} in + ${u.outputTokens} out</div>
    <div>Cost: $${u.costUsd.toFixed(4)}</div>
  `;
}

function selectStage(stageName, runLog) {
  currentStage = stageName;
  // Update selection highlight
  document.querySelectorAll('.timeline-stage').forEach(el => {
    el.classList.toggle('selected', el.dataset.stage === stageName);
  });

  const stageEntries = runLog.stages.filter(s => s.stage === stageName);
  const latest = stageEntries[stageEntries.length - 1];
  if (!latest) return;

  // Header
  const statusLabel = latest.gatePassed ? 'PASSED' : 'FAILED';
  const statusClass = latest.gatePassed ? 'passed' : 'failed';
  document.getElementById('detail-header').innerHTML = `
    <div class="detail-title">
      <div class="detail-stage-name">${stageName}</div>
      <div class="detail-stage-meta">Role: ${latest.role} · Model: ${latest.model}</div>
    </div>
    <span class="status-badge ${statusClass}">${statusLabel}</span>
  `;

  // Gate
  document.getElementById('gate-result').innerHTML = stageEntries.map(s =>
    `<div class="gate-entry ${s.gatePassed ? 'passed' : 'failed'}">
      <span class="gate-icon">${s.gatePassed ? '✓' : '✗'}</span>
      <span>${s.role}: ${s.gateReason}</span>
    </div>`
  ).join('');

  // Load log
  loadStageLog();
  // Load artifacts
  loadArtifacts(stageName);
}

async function loadStageLog() {
  if (!currentRunId) return;
  const { data } = await api(`/api/runs/${currentRunId}/log`);
  document.getElementById('log-output').textContent = data;
}

async function loadArtifacts(stageName) {
  if (!currentRunId) return;
  const { data } = await api(`/api/runs/${currentRunId}/artifacts`);
  const filtered = data.filter(a => a.path.startsWith(stageName + '/'));
  const listDiv = document.getElementById('artifacts-list');
  if (filtered.length === 0) {
    listDiv.innerHTML = '<div class="empty-state" style="padding:20px">No artifacts</div>';
    return;
  }
  listDiv.innerHTML = filtered.map(a =>
    `<div class="artifact-entry" data-path="${a.path}">
      <span class="artifact-name">${a.path}</span>
      <span class="artifact-size">${formatSize(a.size)}</span>
    </div>`
  ).join('');
  listDiv.querySelectorAll('.artifact-entry').forEach(el => {
    el.addEventListener('click', async () => {
      const { data } = await api(`/api/runs/${currentRunId}/artifacts/${el.dataset.path}`);
      const preview = document.getElementById('artifact-preview');
      preview.style.display = 'block';
      preview.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    });
  });
}

function connectSSE(runId) {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/api/events/${runId}`);
  eventSource.onmessage = (e) => {
    const event = JSON.parse(e.data);
    const logOutput = document.getElementById('log-output');
    const ts = new Date().toLocaleTimeString();
    logOutput.textContent += `[${ts}] ${event.type}: ${JSON.stringify(event)}\n`;
    logOutput.scrollTop = logOutput.scrollHeight;

    if (event.type === 'run-end') {
      eventSource.close();
      loadDashboard(runId);
    }
  };
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  return (bytes / 1024).toFixed(1) + ' KB';
}

// Detail tab switching
document.querySelectorAll('.detail-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.detail-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.detail-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('detail-' + btn.dataset.detail).classList.add('active');
  });
});

// Init: load dashboard on page load
loadDashboard();
```

- [ ] **Step 3: Add Dashboard styles to style.css**

Append to `src/web/public/style.css`:

```css
/* Timeline */
.timeline-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.timeline-title { font-weight: 700; font-size: 14px; }
.timeline-summary { color: #8b949e; font-size: 12px; }
.timeline-stages { padding-left: 14px; border-left: 3px solid #30363d; margin-left: 8px; }
.timeline-stage { position: relative; padding: 6px 0 14px 16px; cursor: pointer; border-radius: 6px; }
.timeline-stage:hover { background: rgba(255,255,255,0.03); }
.timeline-stage.selected { background: rgba(88,166,255,0.08); margin-left: -8px; padding-left: 24px; }
.stage-dot { position: absolute; left: -11px; top: 8px; width: 16px; height: 16px; border-radius: 50%; border: 2px solid #0d1117; background: #30363d; }
.timeline-stage.selected .stage-dot { left: 5px; }
.timeline-stage.passed .stage-dot { background: #2d6a4f; }
.timeline-stage.failed .stage-dot { background: #da3633; }
.stage-name { font-weight: 500; }
.stage-meta { font-size: 11px; color: #8b949e; }
.timeline-info { margin-top: 16px; padding-top: 12px; border-top: 1px solid #30363d; font-size: 11px; color: #8b949e; line-height: 1.6; }

/* Detail panel */
.detail-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.detail-stage-name { font-size: 18px; font-weight: 700; }
.detail-stage-meta { font-size: 12px; color: #8b949e; }
.status-badge { font-size: 12px; padding: 4px 10px; border-radius: 4px; font-weight: 600; }
.status-badge.passed { color: #2d6a4f; border: 1px solid #2d6a4f; }
.status-badge.failed { color: #da3633; border: 1px solid #da3633; }
.detail-tabs { display: flex; border-bottom: 1px solid #30363d; margin-bottom: 12px; }
.detail-tab { background: none; border: none; color: #8b949e; padding: 6px 14px; cursor: pointer; font-size: 13px; border-bottom: 2px solid transparent; }
.detail-tab.active { color: #c9d1d9; border-bottom-color: #58a6ff; }
.detail-content { display: none; }
.detail-content.active { display: block; }
.log-output { background: #010409; border-radius: 6px; padding: 12px; font-family: 'SF Mono', Menlo, monospace; font-size: 12px; line-height: 1.6; color: #8b949e; white-space: pre-wrap; max-height: calc(100vh - 200px); overflow-y: auto; }
.artifact-entry { display: flex; justify-content: space-between; padding: 8px 10px; background: #161b22; border-radius: 4px; margin-bottom: 4px; cursor: pointer; font-size: 13px; }
.artifact-entry:hover { background: #1c2128; }
.artifact-name { color: #c9d1d9; }
.artifact-size { color: #8b949e; font-size: 11px; }
.gate-entry { padding: 8px 10px; margin-bottom: 4px; border-radius: 4px; font-size: 13px; }
.gate-entry.passed { background: rgba(45,106,79,0.15); color: #2d6a4f; }
.gate-entry.failed { background: rgba(218,54,51,0.15); color: #da3633; }
.gate-icon { margin-right: 8px; }
```

- [ ] **Step 4: Manually test dashboard**

Run: `cd /Users/xupeng/dev/github/petri && npx tsx src/cli/index.ts web`
Open: http://localhost:3000
Expected: Dashboard tab shows, empty state or latest run if available.

- [ ] **Step 5: Commit**

```bash
git add src/web/public/
git commit -m "feat: implement Dashboard tab with timeline and detail panel"
```

---

### Task 7: Frontend — Runs Tab

**Files:**
- Modify: `src/web/public/index.html`
- Modify: `src/web/public/app.js`
- Modify: `src/web/public/style.css`

- [ ] **Step 1: Implement Runs tab HTML**

In `index.html`, replace the `#tab-runs` content:

```html
<div id="tab-runs" class="tab-content">
  <div class="runs-start">
    <h3>Start New Run</h3>
    <div class="form-row">
      <label>Pipeline</label>
      <select id="run-pipeline"></select>
    </div>
    <div class="form-row">
      <label>Input</label>
      <textarea id="run-input" rows="4" placeholder="Describe the task..."></textarea>
    </div>
    <button id="run-start-btn" class="btn-primary">Run</button>
    <div id="run-error" class="form-error" style="display:none;"></div>
  </div>
  <div class="runs-history">
    <h3>History</h3>
    <table id="runs-table">
      <thead><tr><th>Run</th><th>Pipeline</th><th>Status</th><th>Started</th><th>Duration</th><th>Cost</th></tr></thead>
      <tbody id="runs-tbody"></tbody>
    </table>
  </div>
</div>
```

- [ ] **Step 2: Implement Runs tab JS**

Add to `src/web/public/app.js`:

```javascript
// Runs tab
async function loadRunsTab() {
  // Load pipelines for dropdown
  const { data: files } = await api('/api/config/files');
  const select = document.getElementById('run-pipeline');
  select.innerHTML = '';
  const pipelines = files.filter(f => f.path.includes('pipeline') && f.path.endsWith('.yaml'));
  for (const p of pipelines) {
    const opt = document.createElement('option');
    opt.value = p.path;
    opt.textContent = p.path;
    select.appendChild(opt);
  }

  // Load history
  const { data: runs } = await api('/api/runs');
  const tbody = document.getElementById('runs-tbody');
  tbody.innerHTML = '';
  for (const run of runs.reverse()) {
    const tr = document.createElement('tr');
    tr.className = 'run-row';
    const statusClass = run.status === 'done' ? 'passed' : run.status === 'blocked' ? 'failed' : '';
    tr.innerHTML = `
      <td>run-${run.runId}</td>
      <td>${run.pipeline}</td>
      <td><span class="status-badge ${statusClass}">${run.status}</span></td>
      <td>${new Date(run.startedAt).toLocaleString()}</td>
      <td>${run.durationMs ? (run.durationMs / 1000).toFixed(1) + 's' : '-'}</td>
      <td>${run.totalUsage ? '$' + run.totalUsage.costUsd.toFixed(4) : '-'}</td>
    `;
    tr.addEventListener('click', () => {
      // Switch to dashboard tab with this run
      document.querySelectorAll('nav .tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      document.querySelector('[data-tab="dashboard"]').classList.add('active');
      document.getElementById('tab-dashboard').classList.add('active');
      loadDashboard(run.runId);
    });
    tbody.appendChild(tr);
  }
}

// Start run button
document.getElementById('run-start-btn').addEventListener('click', async () => {
  const pipeline = document.getElementById('run-pipeline').value;
  const input = document.getElementById('run-input').value.trim();
  const errorDiv = document.getElementById('run-error');
  errorDiv.style.display = 'none';

  if (!input) {
    errorDiv.textContent = 'Input is required';
    errorDiv.style.display = 'block';
    return;
  }

  const { status, data } = await api('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pipeline, input }),
  });

  if (status !== 200) {
    errorDiv.textContent = data.error || 'Failed to start run';
    errorDiv.style.display = 'block';
    return;
  }

  // Switch to dashboard to watch the run
  document.querySelectorAll('nav .tab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.querySelector('[data-tab="dashboard"]').classList.add('active');
  document.getElementById('tab-dashboard').classList.add('active');
  loadDashboard(data.runId);
});

// Load runs tab when clicked
document.querySelector('[data-tab="runs"]').addEventListener('click', loadRunsTab);
```

- [ ] **Step 3: Add Runs tab styles**

Append to `src/web/public/style.css`:

```css
/* Runs tab */
.runs-start { background: #161b22; border-radius: 8px; padding: 20px; margin-bottom: 20px; }
.runs-start h3 { margin-bottom: 12px; font-size: 15px; }
.form-row { margin-bottom: 12px; }
.form-row label { display: block; font-size: 12px; color: #8b949e; margin-bottom: 4px; }
.form-row select, .form-row textarea { width: 100%; background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 8px; font-size: 13px; font-family: inherit; }
.form-row textarea { resize: vertical; }
.btn-primary { background: #238636; color: white; border: none; border-radius: 6px; padding: 8px 20px; cursor: pointer; font-size: 14px; font-weight: 500; }
.btn-primary:hover { background: #2ea043; }
.form-error { color: #da3633; font-size: 13px; margin-top: 8px; }
.runs-history h3 { font-size: 15px; margin-bottom: 12px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; color: #8b949e; font-weight: 500; padding: 8px 10px; border-bottom: 1px solid #30363d; }
td { padding: 8px 10px; border-bottom: 1px solid #21262d; }
.run-row { cursor: pointer; }
.run-row:hover { background: rgba(255,255,255,0.03); }
```

- [ ] **Step 4: Manually test Runs tab**

Run: `npx tsx src/cli/index.ts web`
Open: http://localhost:3000 → Runs tab
Expected: Pipeline dropdown populated, history table shows, Start button works.

- [ ] **Step 5: Commit**

```bash
git add src/web/public/
git commit -m "feat: implement Runs tab with start form and history table"
```

---

### Task 8: Frontend — Config Tab

**Files:**
- Modify: `src/web/public/index.html`
- Modify: `src/web/public/app.js`
- Modify: `src/web/public/style.css`

- [ ] **Step 1: Implement Config tab HTML**

In `index.html`, replace the `#tab-config` content:

```html
<div id="tab-config" class="tab-content">
  <div class="config-layout">
    <aside id="config-tree" class="config-tree"></aside>
    <section class="config-editor">
      <div id="config-file-name" class="config-file-name">Select a file to edit</div>
      <textarea id="config-textarea" class="config-textarea" spellcheck="false" disabled></textarea>
      <div class="config-actions">
        <button id="config-save-btn" class="btn-primary" disabled>Save</button>
        <span id="config-status" class="config-status"></span>
      </div>
    </section>
  </div>
</div>
```

- [ ] **Step 2: Implement Config tab JS**

Add to `src/web/public/app.js`:

```javascript
// Config tab
let currentConfigPath = null;

async function loadConfigTab() {
  const { data: files } = await api('/api/config/files');
  const tree = document.getElementById('config-tree');
  tree.innerHTML = '';

  // Group by directory
  const groups = new Map();
  for (const f of files) {
    const parts = f.path.split('/');
    const group = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(f);
  }

  for (const [group, groupFiles] of groups) {
    if (group) {
      const header = document.createElement('div');
      header.className = 'tree-group';
      header.textContent = group;
      tree.appendChild(header);
    }
    for (const f of groupFiles) {
      const item = document.createElement('div');
      item.className = 'tree-item';
      item.dataset.path = f.path;
      item.textContent = f.path.split('/').pop();
      item.addEventListener('click', () => loadConfigFile(f.path));
      tree.appendChild(item);
    }
  }
}

async function loadConfigFile(filePath) {
  currentConfigPath = filePath;
  const { data } = await api(`/api/config/file?path=${encodeURIComponent(filePath)}`);
  const textarea = document.getElementById('config-textarea');
  textarea.value = data.content;
  textarea.disabled = false;
  document.getElementById('config-file-name').textContent = filePath;
  document.getElementById('config-save-btn').disabled = false;
  document.getElementById('config-status').textContent = '';

  // Highlight selected
  document.querySelectorAll('.tree-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.path === filePath);
  });
}

document.getElementById('config-save-btn').addEventListener('click', async () => {
  if (!currentConfigPath) return;
  const content = document.getElementById('config-textarea').value;
  const statusEl = document.getElementById('config-status');

  const { status, data } = await api(`/api/config/file?path=${encodeURIComponent(currentConfigPath)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });

  if (status === 200) {
    statusEl.textContent = 'Saved';
    statusEl.className = 'config-status success';
  } else {
    statusEl.textContent = data.error || 'Save failed';
    statusEl.className = 'config-status error';
  }
  setTimeout(() => { statusEl.textContent = ''; }, 5000);
});

document.querySelector('[data-tab="config"]').addEventListener('click', loadConfigTab);
```

- [ ] **Step 3: Add Config tab styles**

Append to `src/web/public/style.css`:

```css
/* Config tab */
.config-layout { display: flex; min-height: calc(100vh - 49px); }
.config-tree { width: 240px; border-right: 1px solid #30363d; padding: 16px; flex-shrink: 0; overflow-y: auto; }
.tree-group { font-size: 11px; color: #8b949e; text-transform: uppercase; margin: 12px 0 4px; letter-spacing: 0.5px; }
.tree-item { padding: 6px 10px; border-radius: 4px; cursor: pointer; font-size: 13px; color: #c9d1d9; }
.tree-item:hover { background: rgba(255,255,255,0.05); }
.tree-item.selected { background: rgba(88,166,255,0.12); color: #58a6ff; }
.config-editor { flex: 1; padding: 16px; display: flex; flex-direction: column; }
.config-file-name { font-size: 14px; font-weight: 500; margin-bottom: 8px; color: #8b949e; }
.config-textarea { flex: 1; background: #010409; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 12px; font-family: 'SF Mono', Menlo, monospace; font-size: 13px; line-height: 1.6; resize: none; min-height: 400px; }
.config-textarea:focus { outline: none; border-color: #58a6ff; }
.config-actions { display: flex; align-items: center; gap: 12px; margin-top: 12px; }
.config-status { font-size: 13px; }
.config-status.success { color: #2d6a4f; }
.config-status.error { color: #da3633; }
```

- [ ] **Step 4: Manually test Config tab**

Run: `npx tsx src/cli/index.ts web`
Open: http://localhost:3000 → Config tab
Expected: File tree on left, click to load, edit and save works.

- [ ] **Step 5: Commit**

```bash
git add src/web/public/
git commit -m "feat: implement Config tab with file tree and YAML editor"
```

---

### Task 9: CLI Command — petri web

**Files:**
- Create: `src/cli/web.ts`
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Implement CLI command**

Create `src/cli/web.ts`:

```typescript
import * as path from "node:path";
import * as fs from "node:fs";
import chalk from "chalk";
import { parse as parseYaml } from "yaml";
import { createPetriServer } from "../web/server.js";

interface WebOptions {
  port?: string;
}

export async function webCommand(opts: WebOptions): Promise<void> {
  const cwd = process.cwd();

  // Resolve port: --port > petri.yaml web.port > 3000
  let port = 3000;
  if (opts.port) {
    port = parseInt(opts.port, 10);
  } else {
    const configPath = path.join(cwd, "petri.yaml");
    if (fs.existsSync(configPath)) {
      try {
        const config = parseYaml(fs.readFileSync(configPath, "utf-8")) as any;
        if (config?.web?.port) port = config.web.port;
      } catch { /* use default */ }
    }
  }

  const result = createPetriServer({ projectDir: cwd, port });
  console.log(chalk.blue(`Petri web dashboard running at http://localhost:${result.port}`));
  console.log(chalk.gray("Press Ctrl+C to stop."));
}
```

- [ ] **Step 2: Register in index.ts**

Add to `src/cli/index.ts`:

```typescript
import { webCommand } from "./web.js";

program
  .command("web")
  .description("Start web dashboard")
  .option("--port <number>", "Port number")
  .action(webCommand);
```

- [ ] **Step 3: Test manually**

Run: `npx tsx src/cli/index.ts web`
Expected: Server starts on :3000, all three tabs work.

Run: `npx tsx src/cli/index.ts web --port 8080`
Expected: Server starts on :8080.

- [ ] **Step 4: Commit**

```bash
git add src/cli/web.ts src/cli/index.ts
git commit -m "feat: add petri web CLI command"
```

---

### Task 10: Build Config — Copy Static Files

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add postbuild script**

In `package.json`, add to scripts:

```json
"postbuild": "cp -r src/web/public dist/web/public"
```

- [ ] **Step 2: Test build**

Run: `npm run build`
Expected: `dist/web/public/` contains `index.html`, `app.js`, `style.css`.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "build: copy web public assets to dist on build"
```

---

### Task 11: Full Integration Test

**Files:**
- Modify: `tests/web/api.test.ts`

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: ALL tests pass.

- [ ] **Step 2: Fix any issues discovered**

Address test failures from integration between server, API, SSE, and runner.

- [ ] **Step 3: Manual smoke test**

Run: `npx tsx src/cli/index.ts web`

1. Dashboard tab: shows empty state or latest run
2. Runs tab: pipeline dropdown populated, can start a run (with a real or test project)
3. Config tab: file tree loads, can edit and save files
4. SSE: start run from Runs tab, dashboard updates in real-time

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "test: verify web dashboard integration"
```
