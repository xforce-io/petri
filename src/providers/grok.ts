import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentProvider, PetriAgent, AgentConfig, AgentResult } from "./interface.js";
import {
  firstExistingBinary,
  scanArtifacts,
  spawnCliCommand,
} from "./cli-runner.js";

export interface GrokProviderOptions {
  /** Override binary path (tests / PETRI_GROK_BIN). */
  binary?: string;
  defaultModel?: string;
}

export interface GrokCliPlan {
  binary: string;
  promptFile: string;
  stdoutFile: string;
  args: string[];
  /** Full bash command line used by spawn. */
  command: string;
}

/** Pure: assemble grok CLI argv for a prompt-file headless run. */
export function buildGrokArgs(input: {
  promptFile: string;
  artifactDir: string;
  model?: string;
}): string[] {
  const args = [
    "--prompt-file",
    input.promptFile,
    "--always-approve",
    "--output-format",
    "plain",
    "--cwd",
    input.artifactDir,
  ];
  if (input.model && input.model !== "default") {
    args.push("-m", input.model);
  }
  return args;
}

export function findGrokBinary(override?: string): string {
  if (override) return override;
  if (process.env.PETRI_GROK_BIN) return process.env.PETRI_GROK_BIN;
  const home = process.env.HOME ?? "";
  return firstExistingBinary(
    [
      join(home, ".grok", "bin", "grok"),
      "/opt/homebrew/bin/grok",
      "/usr/local/bin/grok",
    ],
    "grok",
  );
}

export function planGrokCli(
  config: Pick<AgentConfig, "artifactDir" | "model">,
  binary?: string,
): GrokCliPlan {
  const bin = findGrokBinary(binary);
  const promptFile = join(config.artifactDir, "_prompt.md");
  const stdoutFile = join(config.artifactDir, "_grok_stdout.txt");
  const args = buildGrokArgs({
    promptFile,
    artifactDir: config.artifactDir,
    model: config.model,
  });
  const quotedArgs = args.map((a) => shellQuote(a)).join(" ");
  const command = `${shellQuote(bin)} ${quotedArgs} > ${shellQuote(stdoutFile)}`;
  return { binary: bin, promptFile, stdoutFile, args, command };
}

function shellQuote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

export class GrokProvider implements AgentProvider {
  private defaultModel: string;
  private binary?: string;

  constructor(defaultModelOrOptions: string | GrokProviderOptions = "default") {
    if (typeof defaultModelOrOptions === "string") {
      this.defaultModel = defaultModelOrOptions;
    } else {
      this.defaultModel = defaultModelOrOptions.defaultModel ?? "default";
      this.binary = defaultModelOrOptions.binary;
    }
  }

  createAgent(config: AgentConfig): PetriAgent {
    return {
      run: (signal?: AbortSignal) => this.runAgent(config, signal),
    };
  }

  private async runAgent(config: AgentConfig, signal?: AbortSignal): Promise<AgentResult> {
    const systemPrompt = [config.persona, "---", ...config.playbooks].join("\n\n");
    const fullPrompt = `${systemPrompt}\n\n---\n\n${config.context}`;

    mkdirSync(config.artifactDir, { recursive: true });
    const plan = planGrokCli(
      { artifactDir: config.artifactDir, model: config.model || this.defaultModel },
      this.binary,
    );
    writeFileSync(plan.promptFile, fullPrompt, "utf-8");

    const agentTimeout = config.timeout ?? 4 * 3600_000;
    const timeoutMin = Math.round(agentTimeout / 60_000);
    const startedAt = new Date();
    const startedMs = Date.now();
    console.log(`  [grok] Running in ${config.artifactDir} (timeout: ${timeoutMin}m)...`);

    const { exitCode, timedOut, exitErr } = await spawnCliCommand(plan.command, {
      cwd: config.artifactDir,
      timeoutMs: agentTimeout,
      signal,
    });

    const output = existsSync(plan.stdoutFile) ? readFileSync(plan.stdoutFile, "utf-8") : "";
    const finishedAt = new Date();
    writeFileSync(
      join(config.artifactDir, "_agent_run.json"),
      JSON.stringify(
        {
          provider: "grok",
          model: config.model || this.defaultModel,
          command: plan.command,
          cwd: config.artifactDir,
          stdout_path: plan.stdoutFile,
          exit_code: exitCode,
          timed_out: timedOut,
          started_at: startedAt.toISOString(),
          finished_at: finishedAt.toISOString(),
          duration_ms: Date.now() - startedMs,
        },
        null,
        2,
      ),
      "utf-8",
    );

    if (timedOut) {
      const msg = `[grok] TIMEOUT: Agent killed after ${timeoutMin} minutes. If this task needs more time, increase the stage timeout in pipeline.yaml.`;
      console.error(`  ${msg}`);
      writeFileSync(join(config.artifactDir, "_error.txt"), msg, "utf-8");
      throw new Error(msg);
    } else if (exitErr) {
      const errMsg = exitErr.message?.slice(0, 500) ?? "Unknown error";
      console.error(`  [grok] FAILED: ${errMsg}`);
      writeFileSync(join(config.artifactDir, "_error.txt"), `[grok] FAILED: ${errMsg}`, "utf-8");
    } else if (exitCode !== null && exitCode !== 0) {
      const msg = `[grok] FAILED: exit code ${exitCode}`;
      console.error(`  ${msg}`);
      writeFileSync(join(config.artifactDir, "_error.txt"), msg, "utf-8");
    }

    if (output.trim()) {
      writeFileSync(join(config.artifactDir, "_result.md"), output, "utf-8");
      console.log(`  [grok] Result: ${output.slice(0, 150).replace(/\n/g, " ")}...`);
    }

    return { artifacts: scanArtifacts(config.artifactDir) };
  }
}
