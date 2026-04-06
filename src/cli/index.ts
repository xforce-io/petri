import { Command } from "commander";
import { runCommand } from "./run.js";
import { validateCommand } from "./validate.js";
import { initCommand } from "./init.js";
import { statusCommand } from "./status.js";
import { logCommand } from "./log.js";
import { listTemplatesCommand, listSkillsCommand } from "./list.js";
import { webCommand } from "./web.js";

const program = new Command();
program.name("petri").description("Multi-agent stage runner").version("0.1.0");

program
  .command("run")
  .description("Run a pipeline")
  .option("-p, --pipeline <file>", "Pipeline file", "pipeline.yaml")
  .option("-i, --input <text>", "Input text")
  .option("--from <file>", "Read input from file")
  .option("--skip-to <stage>", "Resume from a stage, skipping earlier stages (reuses existing artifacts)")
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
  .action(statusCommand);

program
  .command("log")
  .description("View run logs")
  .option("--run <id>", "Run ID (e.g. 001 or run-001)")
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
  .command("skills")
  .description("List built-in skills")
  .action(listSkillsCommand);

program.parse();
