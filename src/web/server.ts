// src/web/server.ts

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { RunLogger } from "../engine/logger.js";
import { handleApiRequest } from "./routes/api.js";

export interface ServerOptions {
  projectDir: string;
  port: number;
}

export interface ServerResult {
  server: http.Server;
  port: number;
  activeRuns: Map<string, RunLogger>;
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
    path.resolve(__dirname, "public"),                          // dev: src/web/public
    path.resolve(__dirname, "..", "web", "public"),             // bundled: dist/web/../web/public
    path.resolve(__dirname, "..", "..", "src", "web", "public"),// bundled: dist/../../src/web/public
  ];
  const found = candidates.find((d) => fs.existsSync(d));
  return found ?? candidates[0];
}

function serveStatic(
  res: http.ServerResponse,
  publicDir: string,
  urlPath: string,
): boolean {
  // Map / to /index.html
  const filePath = urlPath === "/" ? "/index.html" : urlPath;
  const absPath = path.join(publicDir, filePath);

  // Path traversal protection
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

export function createPetriServer(opts: ServerOptions): Promise<ServerResult> {
  const { projectDir, port } = opts;
  const publicDir = resolvePublicDir();
  const activeRuns = new Map<string, RunLogger>();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    try {
      // API routes
      if (pathname.startsWith("/api/")) {
        await handleApiRequest(req, res, url, projectDir, activeRuns);
        return;
      }

      // Static files
      if (serveStatic(res, publicDir, pathname)) {
        return;
      }

      // 404
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
    server.listen(port, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({ server, port: actualPort, activeRuns });
    });
  });
}
