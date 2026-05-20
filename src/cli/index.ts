import { Command } from "commander";
import { runCommand } from "./run.js";
import { validateCommand } from "./validate.js";
import { initCommand } from "./init.js";
import { statusCommand } from "./status.js";
import { logCommand } from "./log.js";
import { listTemplatesCommand, listPlaybooksCommand } from "./list.js";
import { webCommand } from "./web.js";
import { createCommand } from "./create.js";
import { branchForkCommand, branchInitCommand, branchListCommand } from "./branch.js";

const program = new Command();
program.name("petri").description("Multi-agent stage runner").version("0.1.0");

program
  .command("run")
  .description("Run a pipeline")
  .option("-p, --pipeline <file>", "Pipeline file", "pipeline.yaml")
  .option("-i, --input <text>", "Input text")
  .option("--from <file>", "Read input from file")
  .option("--skip-to <stage>", "Resume from a stage, skipping earlier stages (reuses existing artifacts)")
  .option("--require-clean", "Ensure git working tree is clean before running")
  .option("--worktree [name]", "Run in a temporary git worktree to isolate changes")
  .option("--branch <id>", "Run under a named exploration branch")
  .action(runCommand);

program
  .command("validate")
  .description("Validate project configuration")
  .action(validateCommand);

program
  .command("init")
  .description("Initialize a new Petri project")
  .option("-t, --template <name>", "Template to use", "code-dev")
  .action(initCommand);

program
  .command("status")
  .description("Show current/recent run status")
  .option("--branch <id>", "Show status for a named exploration branch")
  .action(statusCommand);

program
  .command("log")
  .description("View run logs")
  .option("--run <id>", "Run ID (e.g. 001 or run-001)")
  .option("--branch <id>", "Read logs from a named exploration branch")
  .action(logCommand);

const list = program
  .command("list")
  .description("List available resources");

list
  .command("templates")
  .description("List available project templates")
  .action(listTemplatesCommand);

program
  .command("web")
  .description("Start web dashboard")
  .option("--port <number>", "Port number")
  .action(webCommand);

list
  .command("playbooks")
  .description("List built-in playbooks")
  .action(listPlaybooksCommand);

program
  .command("create")
  .description("Generate a pipeline from a natural-language description")
  .argument("[description]", "What you want to build")
  .option("--from <file>", "Read description from a file instead of the argument")
  .action(createCommand);

const branch = program
  .command("branch")
  .description("Manage exploration branches");

branch
  .command("init")
  .description("Create a named exploration branch")
  .argument("<id>", "Branch id")
  .option("--objective <text>", "Branch objective")
  .option("--baseline <text>", "Baseline artifact or strategy")
  .action(branchInitCommand);

branch
  .command("list")
  .description("List exploration branches")
  .action(branchListCommand);

branch
  .command("fork")
  .description("Fork a new exploration branch from an existing branch run")
  .argument("<id>", "New branch id")
  .requiredOption("--from-branch <id>", "Parent branch id")
  .requiredOption("--from-run <id>", "Parent run id")
  .option("--artifact <path>", "Parent run artifact that motivated the fork")
  .option("--reason <text>", "Reason for the fork")
  .option("--objective <text>", "Branch objective")
  .option("--baseline <text>", "Baseline artifact or strategy")
  .action(branchForkCommand);

program.parse();
