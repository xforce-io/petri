import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import { generatePipeline } from "../engine/generator.js";
import { loadPetriConfig } from "../config/loader.js";
import { createProviderFromConfig } from "../util/provider.js";
import type { AgentProvider } from "../types.js";

export interface CreateOptions {
  description?: string;
}

/**
 * Testable core: generate a pipeline using the given provider, print summary.
 * `cwd` is the project directory containing petri.yaml.
 */
export async function runCreate(
  opts: CreateOptions,
  provider: AgentProvider,
  cwd: string,
): Promise<void> {
  const description = opts.description?.trim();
  if (!description) {
    throw new Error("Missing description. Pass it as a positional argument.");
  }

  const petriYamlPath = path.join(cwd, "petri.yaml");
  if (!fs.existsSync(petriYamlPath)) {
    throw new Error(
      `petri.yaml not found in ${cwd}. Run 'petri init' first.`,
    );
  }

  const petriConfig = loadPetriConfig(cwd);

  console.log(chalk.blue("Generating pipeline..."));

  const result = await generatePipeline(
    {
      description,
      projectDir: cwd,
      model: petriConfig.defaults.model,
    },
    provider,
  );

  const generatedDir = path.join(cwd, ".petri", "generated");

  console.log();
  if (result.status === "ok") {
    console.log(chalk.green(`✔ status: ok`) + chalk.gray(`  (retries: ${result.retries})`));
  } else {
    console.log(chalk.yellow(`⚠ status: validation_failed`) + chalk.gray(`  (retries: ${result.retries})`));
  }

  if (result.errors && result.errors.length > 0) {
    console.log();
    console.log(chalk.yellow("Errors:"));
    for (const err of result.errors) {
      console.log(chalk.yellow(`  - ${err}`));
    }
  }

  if (result.files.length > 0) {
    console.log();
    console.log(chalk.bold(`Files (${result.files.length}):`));
    for (const f of result.files) {
      console.log(`  ${f}`);
    }
  }

  console.log();
  console.log(chalk.gray(`Output: ${path.relative(cwd, generatedDir) || generatedDir}`));
}

/**
 * CLI entry point: wires up provider from project config, then runs.
 */
export async function createCommand(
  description: string | undefined,
  _opts: Record<string, unknown>,
): Promise<void> {
  const cwd = process.cwd();
  try {
    const provider: AgentProvider = createProviderFromConfig(cwd);
    await runCreate({ description }, provider, cwd);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Error: ${msg}`));
    process.exit(1);
  }
}
