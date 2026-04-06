import * as path from "node:path";
import chalk from "chalk";
import { latestRunDir, loadRunLog, listRuns } from "../engine/logger.js";

export async function statusCommand(): Promise<void> {
  const cwd = process.cwd();
  const runsDir = path.join(cwd, ".petri", "runs");
  const runs = listRuns(runsDir);

  if (runs.length === 0) {
    console.log(chalk.gray("No runs found. Use `petri run` to start a pipeline."));
    return;
  }

  const runDir = latestRunDir(runsDir);
  if (!runDir) {
    console.log(chalk.gray("No runs found."));
    return;
  }

  const runLog = loadRunLog(runDir);
  if (!runLog) {
    console.log(chalk.gray(`No run data found in ${runDir}`));
    return;
  }

  // Header
  const statusColor = runLog.status === "done" ? chalk.green : chalk.red;
  console.log(chalk.bold(`Run: run-${runLog.runId}`) + "  " + statusColor(runLog.status ?? "running"));
  console.log(chalk.gray(`Pipeline: ${runLog.pipeline}`));
  console.log(chalk.gray(`Started: ${runLog.startedAt}`));
  if (runLog.finishedAt) {
    const durationSec = ((runLog.durationMs ?? 0) / 1000).toFixed(1);
    console.log(chalk.gray(`Duration: ${durationSec}s`));
  }

  // Goal
  if (runLog.goal) {
    console.log(chalk.gray(`Goal: ${runLog.goal.length > 100 ? runLog.goal.slice(0, 100) + "..." : runLog.goal}`));
  }

  // Blocked info
  if (runLog.status === "blocked" && runLog.blockedStage) {
    console.log(chalk.red(`Blocked at: ${runLog.blockedStage}`));
    if (runLog.blockedReason) {
      console.log(chalk.red(`Reason: ${runLog.blockedReason}`));
    }
  }

  // Stage summary
  console.log("");
  console.log(chalk.bold("Stages:"));
  const stageMap = new Map<string, { passed: boolean; roles: string[]; attempts: number }>();
  for (const s of runLog.stages) {
    const key = s.stage;
    if (!stageMap.has(key)) {
      stageMap.set(key, { passed: s.gatePassed, roles: [], attempts: 0 });
    }
    const entry = stageMap.get(key)!;
    if (!entry.roles.includes(s.role)) entry.roles.push(s.role);
    entry.attempts = Math.max(entry.attempts, s.attempt);
    if (s.gatePassed) entry.passed = true;
  }

  for (const [stage, info] of stageMap) {
    const icon = info.passed ? chalk.green("✓") : chalk.red("✗");
    console.log(`  ${icon} ${stage} — roles: ${info.roles.join(", ")}`);
  }

  // Usage
  if (runLog.totalUsage.inputTokens > 0 || runLog.totalUsage.outputTokens > 0) {
    console.log("");
    console.log(chalk.bold("Usage:"));
    console.log(chalk.gray(`  Tokens: ${runLog.totalUsage.inputTokens} in + ${runLog.totalUsage.outputTokens} out`));
    console.log(chalk.gray(`  Cost: $${runLog.totalUsage.costUsd.toFixed(4)}`));
  }

  // Requirements
  if (runLog.requirements && runLog.requirements.length > 0) {
    console.log("");
    console.log(chalk.bold("Requirements:"));
    for (const r of runLog.requirements) {
      const icon = r.met ? chalk.green("✓") : chalk.red("✗");
      console.log(`  ${icon} ${r.id}: ${r.reason}`);
    }
  }

  // History hint
  if (runs.length > 1) {
    console.log("");
    console.log(chalk.gray(`${runs.length} total runs. Use \`petri log --run <id>\` to view a specific run.`));
  }
}
