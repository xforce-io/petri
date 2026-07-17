// src/web/routes/api.ts

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { listRuns, loadRunLog, type RunLog, type RunLogger, type StageLog } from "../../engine/logger.js";
import { generatePipeline } from "../../engine/generator.js";
import { promoteGenerated } from "../../engine/promote.js";
import { validateProject } from "../../engine/validate.js";
import { createProviderFromConfig } from "../../util/provider.js";
import { sendJson, readBody } from "../server.js";
import { startRun } from "../runner.js";
import { listFilesRecursive, filterGeneratedFiles } from "../../util/fs.js";
import { listPresetTemplates } from "../../templates/list.js";
import { listProjectPipelines } from "../pipelines.js";
import { listBranches, loadBranch, runRootForBranch } from "../../engine/branch.js";

function handleListTemplates(res: http.ServerResponse): void {
  sendJson(res, 200, listPresetTemplates());
}

function petriRootForRequest(projectDir: string, url: URL): string {
  const branch = url.searchParams.get("branch") || undefined;
  if (branch) {
    loadBranch(projectDir, branch); // throws if missing
  }
  return runRootForBranch(projectDir, branch || undefined);
}

function handleListBranches(res: http.ServerResponse, projectDir: string): void {
  const branches = listBranches(projectDir).map((b) => ({
    branch_id: b.branch_id,
    status: b.status ?? "active",
    objective: b.objective ?? null,
    baseline: b.baseline ?? null,
    created_at: b.created_at ?? null,
  }));
  sendJson(res, 200, branches);
}

function handleListPipelines(res: http.ServerResponse, projectDir: string): void {
  sendJson(res, 200, listProjectPipelines(projectDir));
}

/** Group stage logs into evolution-friendly stage → attempts shape. */
export function buildEvolutionView(stages: StageLog[]): Array<{
  stage: string;
  attempts: Array<{
    attempt: number;
    role: string;
    model: string;
    gatePassed: boolean;
    gateReason: string;
    durationMs: number;
    artifacts: string[];
  }>;
}> {
  const order: string[] = [];
  const byStage = new Map<string, StageLog[]>();
  for (const s of stages) {
    if (!byStage.has(s.stage)) {
      byStage.set(s.stage, []);
      order.push(s.stage);
    }
    byStage.get(s.stage)!.push(s);
  }
  return order.map((stage) => ({
    stage,
    attempts: (byStage.get(stage) ?? []).map((s) => ({
      attempt: s.attempt,
      role: s.role,
      model: s.model,
      gatePassed: s.gatePassed,
      gateReason: s.gateReason,
      durationMs: s.durationMs,
      artifacts: s.artifacts,
    })),
  }));
}

function enrichRunDetail(log: RunLog): Record<string, unknown> {
  return {
    ...log,
    blockedReason: log.blockedReason ?? null,
    blockedStage: log.blockedStage ?? null,
    evolution: buildEvolutionView(log.stages ?? []),
  };
}

export async function handleApiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  projectDir: string,
  activeRuns: Map<string, RunLogger>,
): Promise<void> {
  const method = req.method ?? "GET";
  const pathname = url.pathname;

  // POST /api/runs — start a new run
  if (pathname === "/api/runs" && method === "POST") {
    try {
      const body = await readBody(req);
      let parsed: { pipeline?: string; input?: string; branch?: string };
      try {
        parsed = JSON.parse(body);
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" });
        return;
      }

      if (!parsed.input || typeof parsed.input !== "string") {
        sendJson(res, 400, { error: "Missing required field: input" });
        return;
      }

      const pipelineFile = parsed.pipeline ?? "pipeline.yaml";
      const branchId = typeof parsed.branch === "string" && parsed.branch.trim()
        ? parsed.branch.trim()
        : undefined;
      if (branchId) loadBranch(projectDir, branchId);
      const result = startRun({
        projectDir,
        pipelineFile,
        input: parsed.input,
        activeRuns,
        branchId,
      });

      sendJson(res, 200, { runId: result.runId, branchId: branchId ?? null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 400, { error: message });
    }
    return;
  }

  // GET /api/branches — Petri branch list (issue #19)
  if (pathname === "/api/branches" && method === "GET") {
    return handleListBranches(res, projectDir);
  }

  // GET /api/pipelines — logical names + stage/role structure for Run + Config
  if (pathname === "/api/pipelines" && method === "GET") {
    return handleListPipelines(res, projectDir);
  }

  // GET /api/runs
  if (pathname === "/api/runs" && method === "GET") {
    return handleListRuns(res, projectDir, url);
  }

  // GET /api/runs/:id/log
  const logMatch = pathname.match(/^\/api\/runs\/(\d+)\/log$/);
  if (logMatch && method === "GET") {
    return handleRunLog(res, projectDir, logMatch[1], url);
  }

  // GET /api/runs/:id/artifacts/*
  const artifactFileMatch = pathname.match(/^\/api\/runs\/(\d+)\/artifacts\/(.+)$/);
  if (artifactFileMatch && method === "GET") {
    return handleArtifactFile(res, projectDir, artifactFileMatch[1], artifactFileMatch[2], url);
  }

  // GET /api/runs/:id/artifacts
  const artifactsMatch = pathname.match(/^\/api\/runs\/(\d+)\/artifacts$/);
  if (artifactsMatch && method === "GET") {
    return handleArtifacts(res, projectDir, artifactsMatch[1], url);
  }

  // GET /api/runs/:id
  const runMatch = pathname.match(/^\/api\/runs\/(\d+)$/);
  if (runMatch && method === "GET") {
    return handleRunDetail(res, projectDir, runMatch[1], url);
  }

  // GET /api/config/files
  if (pathname === "/api/config/files" && method === "GET") {
    return handleConfigFiles(res, projectDir);
  }

  // GET /api/config/file
  if (pathname === "/api/config/file" && method === "GET") {
    return handleConfigFileRead(res, url, projectDir);
  }

  // PUT /api/config/file
  if (pathname === "/api/config/file" && method === "PUT") {
    return handleConfigFileWrite(req, res, url, projectDir);
  }

  // POST /api/config/validate — validate current project instance config
  if (pathname === "/api/config/validate" && method === "POST") {
    const result = validateProject(projectDir);
    sendJson(res, result.valid ? 200 : 400, result);
    return;
  }

  // POST /api/generate
  if (pathname === "/api/generate" && method === "POST") {
    try {
      const body = await readBody(req);
      let parsed: { description?: string };
      try {
        parsed = JSON.parse(body);
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" });
        return;
      }
      if (!parsed.description || typeof parsed.description !== "string") {
        sendJson(res, 400, { error: "Missing required field: description" });
        return;
      }
      const provider = createProviderFromConfig(projectDir);
      const { loadPetriConfig } = await import("../../config/loader.js");
      const petriConfig = loadPetriConfig(projectDir);
      const result = await generatePipeline(
        { description: parsed.description, projectDir, model: petriConfig.defaults.model },
        provider,
      );
      sendJson(res, 200, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: message });
    }
    return;
  }

  // POST /api/generate/promote
  if (pathname === "/api/generate/promote" && method === "POST") {
    try {
      const files = promoteGenerated(projectDir);
      sendJson(res, 200, { files });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: message });
    }
    return;
  }

  // GET /api/generate/files
  if (pathname === "/api/generate/files" && method === "GET") {
    const genDir = path.join(projectDir, ".petri", "generated");
    if (!fs.existsSync(genDir)) {
      sendJson(res, 200, []);
      return;
    }
    const files = filterGeneratedFiles(listFilesRecursive(genDir));
    sendJson(res, 200, files);
    return;
  }

  // GET /api/generate/file?path=...
  if (pathname === "/api/generate/file" && method === "GET") {
    const relPath = url.searchParams.get("path");
    if (!relPath) {
      sendJson(res, 400, { error: "Missing path parameter" });
      return;
    }
    const genDir = path.join(projectDir, ".petri", "generated");
    const absPath = path.resolve(genDir, relPath);
    if (!absPath.startsWith(genDir + "/") || !fs.existsSync(absPath)) {
      sendJson(res, 404, { error: "File not found" });
      return;
    }
    const content = fs.readFileSync(absPath, "utf-8");
    sendJson(res, 200, { path: relPath, content });
    return;
  }

  // PUT /api/generate/file?path=...
  if (pathname === "/api/generate/file" && method === "PUT") {
    const relPath = url.searchParams.get("path");
    if (!relPath) {
      sendJson(res, 400, { error: "Missing path parameter" });
      return;
    }
    const genDir = path.join(projectDir, ".petri", "generated");
    const absPath = path.resolve(genDir, relPath);
    if (!absPath.startsWith(genDir + "/")) {
      sendJson(res, 403, { error: "Forbidden" });
      return;
    }
    const body = await readBody(req);
    let parsed: { content?: string };
    try {
      parsed = JSON.parse(body);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }
    if (typeof parsed.content !== "string") {
      sendJson(res, 400, { error: "Missing content field" });
      return;
    }
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, parsed.content, "utf-8");
    sendJson(res, 200, { path: relPath, saved: true });
    return;
  }

  // POST /api/generate/validate
  if (pathname === "/api/generate/validate" && method === "POST") {
    const genDir = path.join(projectDir, ".petri", "generated");
    const petriSrc = path.join(projectDir, "petri.yaml");
    const petriDst = path.join(genDir, "petri.yaml");
    let copiedPetri = false;
    if (fs.existsSync(petriSrc) && !fs.existsSync(petriDst)) {
      fs.mkdirSync(genDir, { recursive: true });
      fs.copyFileSync(petriSrc, petriDst);
      copiedPetri = true;
    }
    try {
      const result = validateProject(genDir);
      sendJson(res, 200, result);
    } finally {
      if (copiedPetri && fs.existsSync(petriDst)) {
        fs.unlinkSync(petriDst);
      }
    }
    return;
  }

  // GET /api/templates
  if (pathname === "/api/templates" && method === "GET") {
    return handleListTemplates(res);
  }

  sendJson(res, 404, { error: "Not found" });
}

function parseStagesFromLog(logText: string): Array<{
  stage: string; role: string; model: string; gatePassed: boolean;
  gateReason: string; durationMs: number; artifacts: string[];
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
}> {
  const stages: Array<{
    stage: string; role: string; model: string; gatePassed: boolean;
    gateReason: string; durationMs: number; artifacts: string[];
    usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
  }> = [];

  // Match lines like: "  stage/role done in 12.3s | tokens: 100in+50out | cost: $0.0010"
  const doneRegex = /(\S+)\/(\S+) done in ([\d.]+)s(?:\s*\|\s*tokens:\s*(\d+)in\+(\d+)out\s*\|\s*cost:\s*\$([\d.]+))?/g;
  let match;
  while ((match = doneRegex.exec(logText)) !== null) {
    const [, stage, role, durStr, tokIn, tokOut, cost] = match;
    stages.push({
      stage, role, model: "",
      gatePassed: false, gateReason: "",
      durationMs: Math.round(parseFloat(durStr) * 1000),
      artifacts: [],
      usage: tokIn ? { inputTokens: parseInt(tokIn), outputTokens: parseInt(tokOut), costUsd: cost ? parseFloat(cost) : undefined } : undefined,
    });
  }

  // Match model from "  stage/role — model: xxx"
  const modelRegex = /(\S+)\/(\S+) — model: (\S+)/g;
  while ((match = modelRegex.exec(logText)) !== null) {
    const [, stage, role, model] = match;
    const entry = stages.find((s) => s.stage === stage && s.role === role && !s.model);
    if (entry) entry.model = model;
  }

  // Match gate results: "  Gate [PASS]: reason" or "  Gate [FAIL]: reason"
  const gateRegex = /Gate \[(PASS|FAIL)\]: (.+)/g;
  let gateIdx = 0;
  // Gate results appear after stage completions — map sequentially
  const stageNames = [...new Set(stages.map((s) => s.stage))];
  while ((match = gateRegex.exec(logText)) !== null) {
    const [, result, reason] = match;
    const passed = result === "PASS";
    const stageName = stageNames[gateIdx];
    if (stageName) {
      for (const s of stages) {
        if (s.stage === stageName && !s.gateReason) {
          s.gatePassed = passed;
          s.gateReason = reason;
        }
      }
      gateIdx++;
    }
  }

  return stages;
}

function parseAttemptsFromLog(logText: string): Array<{ stage: string; attempt: number; max: number }> {
  const attempts: Array<{ stage: string; attempt: number; max: number }> = [];
  const re = /Stage "([^"]+)" attempt (\d+)\/(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(logText)) !== null) {
    attempts.push({
      stage: m[1],
      attempt: parseInt(m[2], 10),
      max: parseInt(m[3], 10),
    });
  }
  return attempts;
}

function makeRunningStub(runDir: string, runId: string): object | null {
  const logPath = path.join(runDir, "run.log");
  if (!fs.existsSync(logPath)) return null;
  const logText = fs.readFileSync(logPath, "utf-8");
  const pipelineMatch = logText.match(/Pipeline: (.+)/);
  const startMatch = logText.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/m);

  const stages = parseStagesFromLog(logText);
  const attemptBoundaries = parseAttemptsFromLog(logText);
  let blockedReason: string | null = null;
  const timeoutMatch = logText.match(/agent TIMED OUT: (.+)/i)
    ?? logText.match(/TIMEOUT: (.+)/i)
    ?? logText.match(/Stagnation detected: (.+)/i);
  if (timeoutMatch) {
    blockedReason = timeoutMatch[0].trim();
  }
  let totalIn = 0, totalOut = 0, totalCost = 0;
  for (const s of stages) {
    if (s.usage) {
      totalIn += s.usage.inputTokens;
      totalOut += s.usage.outputTokens;
      totalCost += s.usage.costUsd ?? 0;
    }
  }

  // Map role completions into StageLog-shaped entries for evolution view
  const stageLogs: StageLog[] = stages.map((s) => ({
    stage: s.stage,
    role: s.role,
    attempt: 0,
    model: s.model,
    startedAt: "",
    finishedAt: "",
    durationMs: s.durationMs,
    gatePassed: s.gatePassed,
    gateReason: s.gateReason,
    usage: s.usage,
    artifacts: s.artifacts,
  }));
  // Fill attempt numbers from boundaries when possible
  for (const boundary of attemptBoundaries) {
    const match = stageLogs.find((s) => s.stage === boundary.stage && s.attempt === 0);
    if (match) match.attempt = boundary.attempt;
  }

  return {
    runId,
    pipeline: pipelineMatch?.[1] ?? "unknown",
    status: "running",
    startedAt: startMatch?.[1] ?? new Date().toISOString(),
    stages: stageLogs,
    attemptBoundaries,
    blockedReason,
    blockedStage: null,
    evolution: buildEvolutionView(stageLogs),
    totalUsage: { inputTokens: totalIn, outputTokens: totalOut, costUsd: totalCost },
  };
}

function handleListRuns(res: http.ServerResponse, projectDir: string, url: URL): void {
  const branch = url.searchParams.get("branch") || undefined;
  try {
    const petriDir = petriRootForRequest(projectDir, url);
    const runsDir = path.join(petriDir, "runs");
    const runNames = listRuns(runsDir);
    const runs = runNames.map((name) => {
      const runDir = path.join(runsDir, name);
      const runId = name.replace("run-", "");
      const log = loadRunLog(runDir);
      if (!log) {
        const stub = makeRunningStub(runDir, runId);
        return stub ? { ...stub, branchId: branch ?? null } : { runId, status: "unknown", branchId: branch ?? null };
      }
      return { ...log, branchId: log.branchId ?? branch ?? null };
    });
    sendJson(res, 200, runs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 400, { error: message });
  }
}

function handleRunDetail(res: http.ServerResponse, projectDir: string, id: string, url?: URL): void {
  const petriDir = url ? petriRootForRequest(projectDir, url) : path.join(projectDir, ".petri");
  const branch = url?.searchParams.get("branch") || undefined;
  const runDir = path.join(petriDir, "runs", `run-${id}`);
  const log = loadRunLog(runDir);
  if (log) {
    sendJson(res, 200, { ...enrichRunDetail(log), branchId: log.branchId ?? branch ?? null });
    return;
  }
  const stub = makeRunningStub(runDir, id);
  if (stub) {
    sendJson(res, 200, { ...stub, branchId: branch ?? null });
    return;
  }
  sendJson(res, 404, { error: "Run not found", code: "NOT_FOUND" });
}

function handleRunLog(res: http.ServerResponse, projectDir: string, id: string, url?: URL): void {
  const petriDir = url ? petriRootForRequest(projectDir, url) : path.join(projectDir, ".petri");
  const logPath = path.join(petriDir, "runs", `run-${id}`, "run.log");
  if (!fs.existsSync(logPath)) {
    sendJson(res, 404, { error: "Log not found" });
    return;
  }
  const content = fs.readFileSync(logPath, "utf-8");
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(content);
}

function resolveArtifactsRoots(projectDir: string, id: string, url?: URL): string[] {
  // Prefer run-scoped snapshots under the branch/project petri root, then shared working dir
  const roots: string[] = [];
  try {
    const petriDir = url ? petriRootForRequest(projectDir, url) : path.join(projectDir, ".petri");
    roots.push(path.join(petriDir, "runs", `run-${id}`, "artifacts"));
    roots.push(path.join(petriDir, "artifacts"));
  } catch {
    /* invalid branch */
  }
  // Always allow project-level shared artifacts as last resort for non-branch runs
  roots.push(path.join(projectDir, ".petri", "artifacts"));
  // de-dupe
  return [...new Set(roots.map((r) => path.resolve(r)))];
}

function handleArtifacts(res: http.ServerResponse, projectDir: string, id: string, url?: URL): void {
  const roots = resolveArtifactsRoots(projectDir, id, url);
  const files: Array<{ path: string; size: number }> = [];
  const seen = new Set<string>();

  function walk(dir: string, rel: string): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      const entryAbs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(entryAbs, entryRel);
      } else {
        if (seen.has(entryRel)) continue;
        seen.add(entryRel);
        const stat = fs.statSync(entryAbs);
        files.push({ path: entryRel, size: stat.size });
      }
    }
  }

  for (const root of roots) {
    if (fs.existsSync(root)) walk(root, "");
  }
  sendJson(res, 200, files);
}

function handleArtifactFile(
  res: http.ServerResponse,
  projectDir: string,
  id: string,
  filePath: string,
  url?: URL,
): void {
  const cleaned = filePath.replace(/^artifacts\//, "");
  const roots = resolveArtifactsRoots(projectDir, id, url);
  for (const root of roots) {
    for (const candidate of [path.resolve(root, cleaned), path.resolve(root, filePath)]) {
      if (!candidate.startsWith(path.resolve(root))) continue;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        const content = fs.readFileSync(candidate, "utf-8");
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(content);
        return;
      }
    }
  }
  sendJson(res, 404, { error: "Artifact not found" });
}

function handleConfigFiles(res: http.ServerResponse, projectDir: string): void {
  const files: string[] = [];

  // Top-level config files
  for (const name of ["petri.yaml", "pipeline.yaml"]) {
    if (fs.existsSync(path.join(projectDir, name))) {
      files.push(name);
    }
  }

  // roles/**/*.yaml, roles/*/soul.md, roles/*/playbooks/*.md
  // Order roles by pipeline stage order, then alphabetically for any not in pipeline
  const rolesDir = path.join(projectDir, "roles");
  if (fs.existsSync(rolesDir)) {
    const roleOrder: string[] = [];
    try {
      const pipelinePath = path.join(projectDir, "pipeline.yaml");
      if (fs.existsSync(pipelinePath)) {
        const pipeline = parseYaml(fs.readFileSync(pipelinePath, "utf-8")) as any;
        for (const stage of pipeline.stages || []) {
          for (const role of stage.roles || []) {
            if (!roleOrder.includes(role)) roleOrder.push(role);
          }
        }
      }
    } catch { /* fall back to alphabetical */ }

    const roleDirs = fs.readdirSync(rolesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .sort((a, b) => {
        const ai = roleOrder.indexOf(a.name);
        const bi = roleOrder.indexOf(b.name);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return a.name.localeCompare(b.name);
      });

    for (const roleEntry of roleDirs) {
      const roleDir = path.join(rolesDir, roleEntry.name);
      const roleRel = `roles/${roleEntry.name}`;

      // YAML files in role dir
      for (const f of fs.readdirSync(roleDir, { withFileTypes: true })) {
        if (f.isFile() && f.name.endsWith(".yaml")) {
          files.push(`${roleRel}/${f.name}`);
        }
        if (f.isFile() && f.name === "soul.md") {
          files.push(`${roleRel}/soul.md`);
        }
        if (f.isDirectory() && f.name === "playbooks") {
          const playbooksDir = path.join(roleDir, f.name);
          for (const sf of fs.readdirSync(playbooksDir, { withFileTypes: true })) {
            if (sf.isFile() && sf.name.endsWith(".md")) {
              files.push(`${roleRel}/${f.name}/${sf.name}`);
            }
          }
        }
      }
    }
  }

  sendJson(res, 200, files);
}

function isPathSafe(projectDir: string, relPath: string): boolean {
  if (relPath.includes("..") || path.isAbsolute(relPath)) {
    return false;
  }
  const absPath = path.resolve(projectDir, relPath);
  return absPath.startsWith(projectDir);
}

function handleConfigFileRead(res: http.ServerResponse, url: URL, projectDir: string): void {
  const relPath = url.searchParams.get("path");
  if (!relPath) {
    sendJson(res, 400, { error: "Missing path parameter" });
    return;
  }

  if (!isPathSafe(projectDir, relPath)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  const absPath = path.resolve(projectDir, relPath);
  if (!fs.existsSync(absPath)) {
    sendJson(res, 404, { error: "File not found" });
    return;
  }

  const content = fs.readFileSync(absPath, "utf-8");
  sendJson(res, 200, { path: relPath, content });
}

async function handleConfigFileWrite(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  projectDir: string,
): Promise<void> {
  const relPath = url.searchParams.get("path");
  if (!relPath) {
    sendJson(res, 400, { error: "Missing path parameter" });
    return;
  }

  if (!isPathSafe(projectDir, relPath)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  const body = await readBody(req);
  let parsed: { content?: string };
  try {
    parsed = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return;
  }

  if (typeof parsed.content !== "string") {
    sendJson(res, 400, { error: "Missing content field" });
    return;
  }

  // YAML syntax validation for .yaml files
  if (relPath.endsWith(".yaml") || relPath.endsWith(".yml")) {
    try {
      parseYaml(parsed.content);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Invalid YAML";
      sendJson(res, 400, { error: `YAML syntax error: ${message}` });
      return;
    }
  }

  const absPath = path.resolve(projectDir, relPath);
  const dir = path.dirname(absPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(absPath, parsed.content, "utf-8");
  sendJson(res, 200, { path: relPath, saved: true });
}
