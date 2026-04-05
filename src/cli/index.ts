import { Command } from "commander";
import { runCommand } from "./run.js";
import { validateCommand } from "./validate.js";

const program = new Command();
program.name("petri").description("Multi-agent stage runner").version("0.1.0");

program
  .command("run")
  .description("Run a pipeline")
  .option("-p, --pipeline <file>", "Pipeline file", "pipeline.yaml")
  .option("-i, --input <text>", "Input text")
  .option("--from <file>", "Read input from file")
  .action(runCommand);

program
  .command("validate")
  .description("Validate project configuration")
  .action(validateCommand);

program.parse();
