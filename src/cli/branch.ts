import chalk from "chalk";
import { createBranch, forkBranch, listBranches } from "../engine/branch.js";

export interface BranchInitOptions {
  objective?: string;
  baseline?: string;
}

export interface BranchForkOptions extends BranchInitOptions {
  fromBranch: string;
  fromRun: string;
  artifact?: string;
  reason?: string;
}

export async function branchInitCommand(branchId: string, opts: BranchInitOptions): Promise<void> {
  const cwd = process.cwd();
  try {
    const branch = createBranch(cwd, branchId, opts);
    console.log(chalk.green(`Created branch: ${branch.branch_id}`));
    if (branch.objective) console.log(chalk.gray(`Objective: ${branch.objective}`));
    if (branch.baseline) console.log(chalk.gray(`Baseline: ${branch.baseline}`));
    console.log(chalk.gray(`Path: .petri/branches/${branch.branch_id}`));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Error: ${msg}`));
    process.exit(1);
  }
}

export async function branchListCommand(): Promise<void> {
  const branches = listBranches(process.cwd());
  if (branches.length === 0) {
    console.log(chalk.gray("No branches found. Use `petri branch init <id>` to create one."));
    return;
  }

  console.log(chalk.bold("Branches:"));
  for (const branch of branches) {
    const status = branch.status ?? "active";
    const objective = branch.objective ? ` — ${branch.objective}` : "";
    const fork = branch.forked_from
      ? chalk.gray(`  forked from ${branch.forked_from.branch_id}/${branch.forked_from.run_id}`)
      : "";
    console.log(`  ${chalk.cyan(branch.branch_id)}  ${chalk.gray(status)}${objective}${fork}`);
  }
}

export async function branchForkCommand(branchId: string, opts: BranchForkOptions): Promise<void> {
  const cwd = process.cwd();
  try {
    if (!opts.fromBranch || !opts.fromRun) {
      throw new Error("Both --from-branch and --from-run are required.");
    }
    const branch = forkBranch(cwd, branchId, opts);
    console.log(chalk.green(`Created branch: ${branch.branch_id}`));
    if (branch.objective) console.log(chalk.gray(`Objective: ${branch.objective}`));
    if (branch.baseline) console.log(chalk.gray(`Baseline: ${branch.baseline}`));
    if (branch.forked_from) {
      console.log(chalk.gray(`Forked from: ${branch.forked_from.branch_id}/${branch.forked_from.run_id}`));
      if (branch.forked_from.artifact) console.log(chalk.gray(`Artifact: ${branch.forked_from.artifact}`));
      if (branch.forked_from.reason) console.log(chalk.gray(`Reason: ${branch.forked_from.reason}`));
    }
    console.log(chalk.gray(`Path: .petri/branches/${branch.branch_id}`));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Error: ${msg}`));
    process.exit(1);
  }
}
