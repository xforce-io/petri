import * as path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import chalk from "chalk";
import { latestRunDir, listRuns } from "../engine/logger.js";

interface LogOptions {
  run?: string;
}

export async function logCommand(opts: LogOptions): Promise<void> {
  const cwd = process.cwd();
  const runsDir = path.join(cwd, ".petri", "runs");

  let runDir: string | null;

  if (opts.run) {
    // Resolve run directory: accept "001", "run-001", or full path
    const runName = opts.run.startsWith("run-") ? opts.run : `run-${opts.run}`;
    runDir = path.join(runsDir, runName);
    if (!existsSync(runDir)) {
      console.error(chalk.red(`Run not found: ${runName}`));
      const available = listRuns(runsDir);
      if (available.length > 0) {
        console.log(chalk.gray(`Available runs: ${available.join(", ")}`));
      }
      process.exit(1);
    }
  } else {
    runDir = latestRunDir(runsDir);
    if (!runDir) {
      console.log(chalk.gray("No runs found. Use `petri run` to start a pipeline."));
      return;
    }
  }

  const logPath = path.join(runDir, "run.log");
  if (!existsSync(logPath)) {
    console.log(chalk.gray(`No log file found in ${runDir}`));
    return;
  }

  const content = readFileSync(logPath, "utf-8");
  console.log(content);
}
