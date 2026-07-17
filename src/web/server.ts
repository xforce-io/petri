// src/web/server.ts

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { RunLogger } from "../engine/logger.js";
import { handleApiRequest } from "./routes/api.js";
import { handleSseRequest } from "./routes/sse.js";
import {
  applyTemplate,
  resolveProjectPath,
  TemplateError,
} from "../templates/apply.js";
import { listPresetTemplates } from "../templates/list.js";

export interface ServerOptions {
  /** Primary project dir (optional when projectDirs is empty / multi) */
  projectDir?: string;
  /** Multiple project directories; empty array = zero-project onboarding */
  projectDirs?: { name: string; dir: string }[];
  /** Workspace root for creating new projects (defaults to cwd) */
  workspaceRoot?: string;
  port: number;
}

export interface ServerResult {
  server: http.Server;
  port: number;
  activeRuns: Map<string, RunLogger>;
  projects: { name: string; dir: string }[];
  workspaceRoot: string;
}

export function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function resolvePublicDir(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(__dirname, "public"),
    path.resolve(__dirname, "..", "web", "public"),
    path.resolve(__dirname, "..", "..", "src", "web", "public"),
  ];
  const found = candidates.find((d) => fs.existsSync(d));
  return found ?? candidates[0];
}

function serveStatic(
  res: http.ServerResponse,
  publicDir: string,
  urlPath: string,
): boolean {
  const filePath = urlPath === "/" ? "/index.html" : urlPath;
  const absPath = path.join(publicDir, filePath);

  if (!absPath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return true;
  }

  if (!fs.existsSync(absPath) || fs.statSync(absPath).isDirectory()) {
    return false;
  }

  const ext = path.extname(absPath);
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
  const content = fs.readFileSync(absPath);
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": content.length,
  });
  res.end(content);
  return true;
}

function projectRequiredPaths(pathname: string, method: string): boolean {
  if (pathname === "/api/projects" || pathname === "/api/meta" || pathname === "/api/templates") {
    return false;
  }
  if (pathname.startsWith("/api/events/")) return false;
  // generate routes need a project dir; still require project when none exist
  return pathname.startsWith("/api/");
}

export function createPetriServer(opts: ServerOptions): Promise<ServerResult> {
  const { port } = opts;
  const workspaceRoot = path.resolve(opts.workspaceRoot ?? process.cwd());

  // Explicit projectDirs (including []) wins; else single projectDir; else empty.
  const projects: { name: string; dir: string }[] =
    opts.projectDirs !== undefined
      ? opts.projectDirs.map((p) => ({ ...p }))
      : opts.projectDir
        ? [{ name: path.basename(opts.projectDir), dir: opts.projectDir }]
        : [];

  const publicDir = resolvePublicDir();
  const activeRuns = new Map<string, RunLogger>();

  function resolveProjectDir(url: URL): string | null {
    const projectName = url.searchParams.get("project");
    if (projectName) {
      const found = projects.find((p) => p.name === projectName);
      return found ? found.dir : null;
    }
    return projects[0]?.dir ?? null;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;
    const method = req.method ?? "GET";

    try {
      if (pathname === "/api/meta" && method === "GET") {
        sendJson(res, 200, {
          product: "petri-web",
          workspaceRoot,
          version: "0.1.0",
          projectCount: projects.length,
        });
        return;
      }

      if (pathname === "/api/projects" && method === "GET") {
        sendJson(
          res,
          200,
          projects.map((p) => ({ name: p.name, dir: p.dir })),
        );
        return;
      }

      if (pathname === "/api/projects" && method === "POST") {
        try {
          const raw = await readBody(req);
          let parsed: { name?: string; template?: string };
          try {
            parsed = JSON.parse(raw);
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          if (!parsed.name || !parsed.template) {
            sendJson(res, 400, {
              error: "Missing required fields: name, template",
              code: "MISSING_FIELDS",
            });
            return;
          }
          if (projects.some((p) => p.name === parsed.name)) {
            sendJson(res, 409, {
              error: `Project "${parsed.name}" already registered`,
              code: "EXISTS",
            });
            return;
          }

          const targetDir = resolveProjectPath(workspaceRoot, parsed.name);
          if (fs.existsSync(path.join(targetDir, "petri.yaml"))) {
            sendJson(res, 409, {
              error: `Directory already contains a Petri project: ${parsed.name}`,
              code: "EXISTS",
            });
            return;
          }

          applyTemplate(parsed.template, targetDir);
          const entry = { name: parsed.name, dir: targetDir };
          projects.push(entry);
          sendJson(res, 201, entry);
        } catch (err) {
          if (err instanceof TemplateError) {
            const status =
              err.code === "EXISTS" ? 409 : err.code === "NOT_FOUND" ? 404 : 400;
            sendJson(res, status, { error: err.message, code: err.code });
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          sendJson(res, 500, { error: message });
        }
        return;
      }

      const eventsMatch = pathname.match(/^\/api\/events\/(.+)$/);
      if (eventsMatch) {
        handleSseRequest(req, res, eventsMatch[1], activeRuns);
        return;
      }

      if (pathname.startsWith("/api/")) {
        // Templates list does not need a project
        if (pathname === "/api/templates" && method === "GET") {
          sendJson(res, 200, listPresetTemplates());
          return;
        }

        const projectDir = resolveProjectDir(url);
        if (!projectDir && projectRequiredPaths(pathname, method)) {
          sendJson(res, 400, {
            error:
              "No project selected. Create one from a preset template or open a Petri project directory.",
            code: "NO_PROJECT",
          });
          return;
        }
        if (url.searchParams.get("project") && !projectDir) {
          sendJson(res, 404, {
            error: `Unknown project: ${url.searchParams.get("project")}`,
            code: "UNKNOWN_PROJECT",
          });
          return;
        }

        await handleApiRequest(
          req,
          res,
          url,
          projectDir ?? workspaceRoot,
          activeRuns,
        );
        return;
      }

      if (serveStatic(res, publicDir, pathname)) {
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    } catch (err) {
      console.error("Server error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      }
    }
  });

  return new Promise<ServerResult>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({ server, port: actualPort, activeRuns, projects, workspaceRoot });
    });
  });
}
