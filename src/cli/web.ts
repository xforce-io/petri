import * as path from "node:path";
import * as fs from "node:fs";
import chalk from "chalk";
import { parse as parseYaml } from "yaml";
import { createPetriServer } from "../web/server.js";

interface WebOptions {
  port?: string;
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

  const result = await createPetriServer({ projectDir: cwd, port });
  console.log(chalk.blue(`Petri web dashboard running at http://localhost:${result.port}`));
  console.log(chalk.gray("Press Ctrl+C to stop."));
}
