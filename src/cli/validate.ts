import chalk from "chalk";
import {
  loadPetriConfig,
  loadPipelineConfig,
  loadRole,
} from "../config/loader.js";
import { isRepeatBlock, isCommandStage } from "../types.js";
import { validateRoleProviderConfig } from "../util/provider.js";

export async function validateCommand(): Promise<void> {
  const cwd = process.cwd();
  let hasErrors = false;

  // 1. Load petri.yaml
  let defaultModel = "default";
  let petriConfig: ReturnType<typeof loadPetriConfig> | undefined;
  try {
    petriConfig = loadPetriConfig(cwd);
    defaultModel = petriConfig.defaults.model;
    console.log(chalk.green("✔ petri.yaml loaded"));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(chalk.red(`✘ petri.yaml: ${msg}`));
    hasErrors = true;
  }

  // 2. Load pipeline.yaml
  const roleNames = new Set<string>();
  try {
    const pipelineConfig = loadPipelineConfig(cwd);
    function collectRoles(stages: import("../types.js").StageEntry[]): number {
      let count = 0;
      for (const entry of stages) {
        if (isRepeatBlock(entry)) {
          count += collectRoles(entry.repeat.stages);
        } else {
          count++;
          if (!isCommandStage(entry)) {
            for (const role of entry.roles) {
              roleNames.add(role);
            }
          }
        }
      }
      return count;
    }
    const stageCount = collectRoles(pipelineConfig.stages);
    console.log(
      chalk.green(
        `✔ pipeline.yaml loaded — ${stageCount} stage(s), ${roleNames.size} role(s)`,
      ),
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(chalk.red(`✘ pipeline.yaml: ${msg}`));
    hasErrors = true;
  }

  // 3. Load each role
  const loadedRoles = [];
  for (const name of roleNames) {
    try {
      const role = loadRole(cwd, name, defaultModel);
      loadedRoles.push(role);
      const gateInfo = role.gate ? "gate" : "no gate";
      const playbookCount = role.playbooks.length;
      console.log(
        chalk.green(
          `✔ role "${name}" — ${playbookCount} playbook(s), ${gateInfo}`,
        ),
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(chalk.red(`✘ role "${name}": ${msg}`));
      hasErrors = true;
    }
  }

  if (petriConfig) {
    try {
      validateRoleProviderConfig(loadedRoles, petriConfig);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(chalk.red(`✘ provider routing: ${msg}`));
      hasErrors = true;
    }
  }

  if (hasErrors) {
    process.exit(1);
  }
}
