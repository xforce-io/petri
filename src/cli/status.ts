import * as path from "node:path";
import chalk from "chalk";
import { latestRunDir, loadRunLog, listRuns } from "../engine/logger.js";
import { loadBranch, runRootForBranch } from "../engine/branch.js";
import { inspectLock, listProjectLockFiles } from "../engine/lock.js";

interface StatusOptions {
  branch?: string;
}

export async function statusCommand(opts: StatusOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const branch = opts.branch ? loadBranch(cwd, opts.branch) : undefined;
  const projectPetri = path.join(cwd, ".petri");
  const runRoot = runRootForBranch(cwd, opts.branch);
  const runsDir = path.join(runRoot, "runs");
  const runs = listRuns(runsDir);

  // Lock diagnostics (issue #78 S3): active vs stale for project + worktree namespaces
  const lockFiles = listProjectLockFiles(projectPetri);
  if (lockFiles.length > 0) {
    console.log(chalk.bold("Locks:"));
    for (const lf of lockFiles) {
      const info = inspectLock(lf);
      if (info.status === "absent") continue;
      const label =
        info.status === "active"
          ? chalk.yellow("active")
          : info.status === "stale"
            ? chalk.gray("stale")
            : chalk.red(info.status);
      const id = info.runId ? `run-${info.runId}` : "?";
      const pid = info.pid != null ? `PID ${info.pid}` : "";
      console.log(`  ${label} ${id} ${pid}`.trim());
      console.log(chalk.gray(`    ${info.lockFile}`));
      if (info.workspace) console.log(chalk.gray(`    workspace: ${info.workspace}`));
      console.log(chalk.gray(`    ${info.cleanupHint}`));
    }
    console.log("");
  }

  if (runs.length === 0) {
    const hint = branch ? `petri run --branch ${branch.branch_id}` : "petri run";
    if (lockFiles.length === 0) {
      console.log(chalk.gray(`No runs found. Use \`${hint}\` to start a pipeline.`));
    } else {
      console.log(chalk.gray(`No runs under ${runsDir}. Use \`${hint}\` to start a pipeline.`));
    }
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
  if (runLog.branchId) {
    console.log(chalk.gray(`Branch: ${runLog.branchId}`));
  }
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
