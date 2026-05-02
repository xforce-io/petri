import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import { generatePipeline } from "../engine/generator.js";
import { buildPipelineSummary } from "../engine/summary.js";
import { loadPetriConfig } from "../config/loader.js";
import { createProviderFromConfig } from "../util/provider.js";
import type { AgentProvider } from "../types.js";

export interface CreateOptions {
  description?: string;
  from?: string;
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
  if (opts.description && opts.from) {
    throw new Error("Cannot use both a positional description and --from. Pick one.");
  }

  let description: string | undefined;
  if (opts.from) {
    const fromPath = path.isAbsolute(opts.from) ? opts.from : path.resolve(cwd, opts.from);
    if (!fs.existsSync(fromPath)) {
      throw new Error(`Description file not found: ${fromPath}`);
    }
    description = fs.readFileSync(fromPath, "utf-8").trim();
  } else {
    description = opts.description?.trim();
  }

  if (!description) {
    throw new Error("Missing description. Pass it as a positional argument or with --from <file>.");
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

  // Summary block — only if pipeline.yaml exists and parses
  const summary = buildPipelineSummary(generatedDir);
  if (summary) {
    console.log();
    console.log(`${chalk.bold("Pipeline:")} ${summary.name}`);
    if (summary.goal) console.log(`${chalk.bold("Goal:    ")} ${summary.goal}`);
    if (!summary.goal && summary.description) {
      console.log(`${chalk.bold("Desc:    ")} ${summary.description}`);
    }

    if (summary.stages.length > 0) {
      console.log();
      console.log(chalk.bold("Flow:"));
      const circles = ["①","②","③","④","⑤","⑥","⑦","⑧","⑨"];
      summary.stages.forEach((s, i) => {
        const tag = circles[i] ?? `(${i + 1})`;
        const roles = s.roles.join(", ");
        console.log(`  ${tag} ${s.name.padEnd(10)} →  ${roles}`);
      });
    }

    if (summary.roles.length > 0) {
      console.log();
      console.log(chalk.bold("Roles:"));
      const nameWidth = Math.max(...summary.roles.map((r) => r.name.length));
      for (const r of summary.roles) {
        const persona = r.personaFirstLine || chalk.gray("(no soul.md)");
        console.log(`  ${r.name.padEnd(nameWidth)} — ${persona}`);
      }
    }
  }

  console.log();
  const relGen = path.relative(cwd, generatedDir) || generatedDir;
  console.log(chalk.gray(`→ Inspect:  cat ${relGen}/pipeline.yaml`));
  console.log(chalk.gray(`→ Inspect:  cat ${relGen}/roles/<name>/soul.md`));
  console.log(chalk.gray(`Output: ${relGen}`));
}

/**
 * CLI entry point: wires up provider from project config, then runs.
 */
export async function createCommand(
  description: string | undefined,
  opts: { from?: string },
): Promise<void> {
  const cwd = process.cwd();
  try {
    const provider: AgentProvider = createProviderFromConfig(cwd);
    await runCreate({ description, from: opts.from }, provider, cwd);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Error: ${msg}`));
    process.exit(1);
  }
}
