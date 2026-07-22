import { existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import {
  applyTemplate,
  formatSkippedTemplateFiles,
  TemplateError,
} from "../templates/apply.js";
import { listPresetTemplates } from "../templates/list.js";

export async function initCommand(opts: { template?: string }) {
  const projectDir = process.cwd();
  const configPath = join(projectDir, "petri.yaml");

  if (existsSync(configPath)) {
    console.log(
      chalk.yellow("⚠ petri.yaml already exists in this directory. Aborting."),
    );
    process.exit(1);
  }

  const template = opts.template ?? "code-dev";

  try {
    const result = applyTemplate(template, projectDir);
    for (const line of formatSkippedTemplateFiles(result.skipped)) {
      console.log(chalk.yellow(`⚠ ${line}`));
    }
  } catch (err) {
    if (err instanceof TemplateError) {
      console.log(chalk.red(`Error: ${err.message}`));
      if (err.code === "NOT_FOUND") {
        const available = listPresetTemplates().map((t) => t.id);
        console.log(
          chalk.gray(
            `Available templates: ${available.length ? available.join(", ") : "(none)"}`,
          ),
        );
      }
      process.exit(1);
    }
    throw err;
  }

  console.log(chalk.green(`✔ Initialized petri project with "${template}" template.`));
  console.log();
  console.log("Next steps:");
  console.log(`  1. Review ${chalk.bold("petri.yaml")} and adjust settings`);
  console.log(`  2. Run ${chalk.bold("petri run")} to start the pipeline`);
  console.log(`  3. Or open ${chalk.bold("petri web")} for the product UI`);
}
