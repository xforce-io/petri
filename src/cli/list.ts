import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";

function resolveDir(relativePaths: string[]): string | null {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const candidates = relativePaths.map((p) => resolve(__dirname, p));
  return candidates.find((d) => existsSync(d)) ?? null;
}

function getTemplatesDir(): string | null {
  return resolveDir([
    join("..", "templates"),              // bundled: dist/../templates
    join("..", "..", "src", "templates"), // bundled: dist/../../src/templates
    join("..", "src", "templates"),       // dev: src/cli/../src/templates
  ]);
}

function getPlaybooksDir(): string | null {
  return resolveDir([
    join("..", "playbooks"),              // bundled: dist/../playbooks
    join("..", "..", "src", "playbooks"), // bundled: dist/../../src/playbooks
    join("..", "src", "playbooks"),       // dev: src/cli/../src/playbooks
  ]);
}

export async function listTemplatesCommand(): Promise<void> {
  const dir = getTemplatesDir();
  if (!dir) {
    console.log(chalk.gray("No templates directory found."));
    return;
  }

  const templates = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  if (templates.length === 0) {
    console.log(chalk.gray("No templates found."));
    return;
  }

  console.log(chalk.bold("Available templates:"));
  for (const name of templates) {
    // Try to read pipeline.yaml for a description
    const pipelinePath = join(dir, name, "pipeline.yaml");
    let desc = "";
    if (existsSync(pipelinePath)) {
      const content = readFileSync(pipelinePath, "utf-8");
      const match = content.match(/^description:\s*(.+)$/m);
      if (match) desc = chalk.gray(` — ${match[1]}`);
    }
    console.log(`  ${chalk.cyan(name)}${desc}`);
  }
}

export async function listPlaybooksCommand(): Promise<void> {
  const dir = getPlaybooksDir();
  if (!dir) {
    console.log(chalk.gray("No playbooks directory found."));
    return;
  }

  const playbooks = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));

  if (playbooks.length === 0) {
    console.log(chalk.gray("No built-in playbooks found."));
    return;
  }

  console.log(chalk.bold("Built-in playbooks (use with petri: prefix):"));
  for (const name of playbooks) {
    // Read first line of playbook for description
    const content = readFileSync(join(dir, `${name}.md`), "utf-8");
    const firstLine = content.split("\n").find((l) => l.trim() && !l.startsWith("#"));
    const desc = firstLine ? chalk.gray(` — ${firstLine.trim()}`) : "";
    console.log(`  ${chalk.cyan(`petri:${name}`)}${desc}`);
  }
}
