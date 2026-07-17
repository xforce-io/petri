import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Resolve run input with CLI-aligned priority (issue #23):
 * explicit Input > persisted .petri/goal.md > pipeline.goal
 */
export function resolveRunInput(opts: {
  projectDir: string;
  explicitInput?: string | null;
  pipelineGoal?: string | null;
}): { input: string; source: "explicit" | "persisted_goal" | "pipeline_goal" } | { error: string } {
  const explicit = typeof opts.explicitInput === "string" ? opts.explicitInput.trim() : "";
  if (explicit) {
    return { input: opts.explicitInput as string, source: "explicit" };
  }
  const persistedPath = path.join(opts.projectDir, ".petri", "goal.md");
  if (fs.existsSync(persistedPath)) {
    const text = fs.readFileSync(persistedPath, "utf-8");
    if (text.trim()) return { input: text, source: "persisted_goal" };
  }
  if (opts.pipelineGoal && String(opts.pipelineGoal).trim()) {
    return { input: String(opts.pipelineGoal), source: "pipeline_goal" };
  }
  return {
    error:
      "No input provided. Enter Input, or set .petri/goal.md / pipeline goal (priority: explicit > goal.md > pipeline.goal).",
  };
}
