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
    sendJson(res, 404, { error: "Run not found" });
    return;
  }

  // Set SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  const eventTypes = [
    "stage-start",
    "role-start",
    "role-end",
    "gate-result",
    "run-end",
  ] as const;

  // Create listeners for each event type
  const listeners: Array<{ event: string; fn: (...args: any[]) => void }> = [];

  function cleanup(): void {
    for (const { event, fn } of listeners) {
      logger.removeListener(event, fn);
    }
    listeners.length = 0;
  }

  for (const eventType of eventTypes) {
    const fn = (payload: Record<string, unknown>) => {
      const data = JSON.stringify({ type: eventType, ...payload });
      res.write(`data: ${data}\n\n`);

      if (eventType === "run-end") {
        cleanup();
        res.end();
      }
    };
    listeners.push({ event: eventType, fn });
    logger.on(eventType, fn);
  }

  // Cleanup on client disconnect
  req.on("close", () => {
    cleanup();
  });
}
