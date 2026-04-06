import * as path from "node:path";
import * as fs from "node:fs";
import chalk from "chalk";
import { parse as parseYaml } from "yaml";
import { createPetriServer } from "../web/server.js";

interface WebOptions {
  port?: string;
}

/**
 * Discover petri projects: if cwd has petri.yaml, it's a single project.
 * Otherwise, scan subdirectories for petri.yaml files.
 */
function discoverProjects(cwd: string): { name: string; dir: string }[] {
  // Current dir is a project
  if (fs.existsSync(path.join(cwd, "petri.yaml"))) {
    return [{ name: path.basename(cwd), dir: cwd }];
  }

  // Scan subdirectories
  const projects: { name: string; dir: string }[] = [];
  try {
    for (const entry of fs.readdirSync(cwd, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const subDir = path.join(cwd, entry.name);
      if (fs.existsSync(path.join(subDir, "petri.yaml"))) {
        projects.push({ name: entry.name, dir: subDir });
      }
    }
  } catch { /* ignore */ }

  return projects;
}

export async function webCommand(opts: WebOptions): Promise<void> {
  const cwd = process.cwd();

  // Resolve port: --port > petri.yaml web.port > 3000
  let port = 3000;
  if (opts.port) {
    port = parseInt(opts.port, 10);
  } else {
    const configPath = path.join(cwd, "petri.yaml");
    if (fs.existsSync(configPath)) {
      try {
        const config = parseYaml(fs.readFileSync(configPath, "utf-8")) as any;
        if (config?.web?.port) port = config.web.port;
      } catch { /* use default */ }
    }
  }

  const projects = discoverProjects(cwd);
  if (projects.length === 0) {
    console.error(chalk.red("No petri projects found. Run in a directory with petri.yaml or a parent of such directories."));
    process.exit(1);
  }

  const result = await createPetriServer({
    projectDir: projects[0].dir,
    projectDirs: projects,
    port,
  });

  console.log(chalk.blue(`Petri web dashboard running at http://localhost:${result.port}`));
  if (projects.length > 1) {
    console.log(chalk.gray(`Projects: ${projects.map((p) => p.name).join(", ")}`));
  }
  console.log(chalk.gray("Press Ctrl+C to stop."));
}
