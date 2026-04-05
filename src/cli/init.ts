import { existsSync, cpSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";

const AVAILABLE_TEMPLATES = ["code-dev"];

export async function initCommand(opts: { template?: string }) {
  const projectDir = process.cwd();
  const configPath = join(projectDir, "petri.yaml");

  // Check if petri.yaml already exists
  if (existsSync(configPath)) {
    console.log(
      chalk.yellow("⚠ petri.yaml already exists in this directory. Aborting."),
    );
    process.exit(1);
  }

  const template = opts.template ?? "code-dev";

  // Resolve template directory — check dist sibling first (bundled), then src (dev)
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(__dirname, "..", "templates", template),           // bundled: dist/../templates
    resolve(__dirname, "..", "..", "src", "templates", template), // bundled: dist/../../src/templates
    resolve(__dirname, "..", "src", "templates", template),    // dev: src/cli/../src/templates
  ];
  const templateDir = candidates.find((d) => existsSync(d));

  if (!templateDir) {
    console.log(chalk.red(`Error: template "${template}" not found.`));
    console.log(
      chalk.gray(
        `Available templates: ${AVAILABLE_TEMPLATES.join(", ")}`,
      ),
    );
    process.exit(1);
  }

  // Copy template into cwd
  cpSync(templateDir, projectDir, { recursive: true });

  console.log(chalk.green(`✔ Initialized petri project with "${template}" template.`));
  console.log();
  console.log("Next steps:");
  console.log(`  1. Review ${chalk.bold("petri.yaml")} and adjust settings`);
  console.log(`  2. Run ${chalk.bold("petri run")} to start the pipeline`);
}
