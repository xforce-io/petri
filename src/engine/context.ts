import type { AttemptRecord } from "../types.js";

export interface ContextInput {
  input: string;
  artifactDir: string;
  manifestText: string;
  failureContext: string;
  attemptHistory: AttemptRecord[];
}

export function buildContext(ctx: ContextInput): string {
  const sections: string[] = [];

  // Working directory and instruction
  sections.push(`Working directory: ${ctx.artifactDir}`);
  sections.push(`Write all artifacts to ${ctx.artifactDir}.`);

  // Available artifacts from manifest
  if (ctx.manifestText) {
    sections.push(`Available artifacts:\n${ctx.manifestText}`);
  }

  // User input
  sections.push(`User input:\n${ctx.input}`);

  // Previous attempts
  if (ctx.attemptHistory.length > 0) {
    const attemptsBlock = ctx.attemptHistory
      .map((a) => `Attempt ${a.attempt}: ${a.failureReason}`)
      .join("\n");
    sections.push(
      `Previous attempts:\n${attemptsBlock}\n\nDO NOT repeat failed approaches.`,
    );
  }

  // Latest failure context
  if (ctx.failureContext) {
    sections.push(`Latest failure:\n${ctx.failureContext}`);
  }

  return sections.join("\n\n");
}
