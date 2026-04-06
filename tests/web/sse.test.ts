import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { RunLogger } from "../../src/engine/logger.js";
import { createPetriServer, type ServerResult } from "../../src/web/server.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "petri-sse-test-"));
}

/**
 * Helper: connect to SSE endpoint and collect `data:` lines within a timeout.
 */
function collectSseEvents(
  port: number,
  urlPath: string,
  timeoutMs: number,
): Promise<{ status: number; events: unknown[] }> {
  return new Promise((resolve, reject) => {
    const events: unknown[] = [];
    let status = 0;

    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method: "GET" },
      (res) => {
        status = res.statusCode!;

        // If not 200, collect body and resolve
        if (status !== 200) {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve({ status, events }));
          return;
        }

        let buffer = "";
        res.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf-8");
          // Parse complete SSE messages
          const parts = buffer.split("\n\n");
          buffer = parts.pop()!; // last part is incomplete
          for (const part of parts) {
            for (const line of part.split("\n")) {
              if (line.startsWith("data: ")) {
                try {
                  events.push(JSON.parse(line.slice(6)));
                } catch {}
              }
            }
          }
        });

        res.on("end", () => {
          // Parse any remaining buffer
          if (buffer.trim()) {
            for (const line of buffer.split("\n")) {
              if (line.startsWith("data: ")) {
                try {
                  events.push(JSON.parse(line.slice(6)));
                } catch {}
              }
            }
          }
          resolve({ status, events });
        });
      },
    );

    req.on("error", reject);
    req.end();

    // Safety timeout
    setTimeout(() => {
      req.destroy();
      resolve({ status, events });
    }, timeoutMs);
  });
}

describe("SSE Event Streaming", () => {
  let tmpDir: string;
  let result: ServerResult;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    fs.writeFileSync(
      path.join(tmpDir, "petri.yaml"),
      "providers:\n  pi:\n    type: pi\n",
      "utf-8",
    );
    result = await createPetriServer({ projectDir: tmpDir, port: 0 });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => result.server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 404 for non-active run", async () => {
    const { status } = await collectSseEvents(
      result.port,
      "/api/events/nonexistent",
      500,
    );
    expect(status).toBe(404);
  });

  it("streams events from an active run logger", async () => {
    // Register a logger in activeRuns
    const petriDir = path.join(tmpDir, ".petri");
    const logger = new RunLogger(petriDir, "test-pipe", "test input");
    result.activeRuns.set(logger.runId, logger);

    // Start collecting SSE events
    const ssePromise = collectSseEvents(
      result.port,
      `/api/events/${logger.runId}`,
      2000,
    );

    // Give the connection time to establish, then emit events
    await new Promise((r) => setTimeout(r, 100));

    logger.logStageAttempt("design", 1, 3);
    const timer = logger.logRoleStart("design", "designer", "sonnet");
    logger.logRoleEnd(timer, {
      gatePassed: true,
      gateReason: "All good",
      artifacts: ["design.md"],
    });
    logger.logGateResult("design", true, "All gates passed");
    logger.finish("done");

    const { status, events } = await ssePromise;
    expect(status).toBe(200);
    expect(events.length).toBeGreaterThanOrEqual(5);

    const types = events.map((e: any) => e.type);
    expect(types).toContain("stage-start");
    expect(types).toContain("role-start");
    expect(types).toContain("role-end");
    expect(types).toContain("gate-result");
    expect(types).toContain("run-end");
  });
});
