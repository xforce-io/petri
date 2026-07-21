import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentProvider, PetriAgent, AgentConfig, AgentResult } from "./interface.js";
import {
  firstExistingBinary,
  scanArtifacts,
  spawnCliCommand,
} from "./cli-runner.js";

export interface CodexProviderOptions {
  /** Override binary path (tests / PETRI_CODEX_BIN). */
  binary?: string;
  defaultModel?: string;
  /**
   * Map petri.yaml model alias → CLI model id (ModelConfig.model).
   * When the agent config model is an alias present here, the mapped id is
   * passed to `codex -m`.
   */
  modelMappings?: Record<string, string>;
  /**
   * When set, every invocation gets `-c model_reasoning_effort=<value>`
   * so effort does not depend on ~/.codex/config.toml.
   */
  reasoningEffort?: string;
}

export interface CodexCliPlan {
  binary: string;
  promptFile: string;
  stdoutFile: string;
  lastMessageFile: string;
  args: string[];
  command: string;
}

/** Resolve role/default model alias to the CLI model id for codex -m. */
export function resolveCodexCliModel(
  model: string | undefined,
  modelMappings?: Record<string, string>,
): string | undefined {
  if (!model) return undefined;
  const mapped = modelMappings?.[model];
  if (mapped !== undefined) return mapped;
  return model;
}

/** Pure: assemble `codex exec` argv (prompt is fed via stdin from prompt file). */
export function buildCodexArgs(input: {
  artifactDir: string;
  workspaceDir?: string;
  lastMessageFile: string;
  model?: string;
  modelMappings?: Record<string, string>;
  reasoningEffort?: string;
}): string[] {
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--color",
    "never",
    "-C",
    input.workspaceDir ?? input.artifactDir,
    "-o",
    input.lastMessageFile,
    "--dangerously-bypass-approvals-and-sandbox",
  ];
  const cliModel = resolveCodexCliModel(input.model, input.modelMappings);
  if (cliModel && cliModel !== "default") {
    args.push("-m", cliModel);
  }
  if (input.reasoningEffort) {
    // Codex accepts -c key=value overrides (see `codex exec --help`).
    args.push("-c", `model_reasoning_effort=${input.reasoningEffort}`);
  }
  // Prompt read from stdin (piped from prompt file).
  args.push("-");
  return args;
}

export function findCodexBinary(override?: string): string {
  if (override) return override;
  if (process.env.PETRI_CODEX_BIN) return process.env.PETRI_CODEX_BIN;
  return firstExistingBinary(
    ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"],
    "codex",
  );
}

export function planCodexCli(
  config: Pick<AgentConfig, "artifactDir" | "workspaceDir" | "model"> & {
    modelMappings?: Record<string, string>;
    reasoningEffort?: string;
  },
  binary?: string,
): CodexCliPlan {
  const bin = findCodexBinary(binary);
  const promptFile = join(config.artifactDir, "_prompt.md");
  const stdoutFile = join(config.artifactDir, "_codex_stdout.txt");
  const lastMessageFile = join(config.artifactDir, "_codex_last_message.txt");
  const args = buildCodexArgs({
      artifactDir: config.artifactDir,
      workspaceDir: config.workspaceDir,
    lastMessageFile,
    model: config.model,
    modelMappings: config.modelMappings,
    reasoningEffort: config.reasoningEffort,
  });
  const quotedArgs = args.map((a) => shellQuote(a)).join(" ");
  // Feed prompt via stdin so long prompts avoid ARG_MAX / shell escaping issues.
  const command = `cat ${shellQuote(promptFile)} | ${shellQuote(bin)} ${quotedArgs} > ${shellQuote(stdoutFile)}`;
  return { binary: bin, promptFile, stdoutFile, lastMessageFile, args, command };
}

function shellQuote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

export class CodexProvider implements AgentProvider {
  private defaultModel: string;
  private binary?: string;
  private modelMappings: Record<string, string>;
  private reasoningEffort?: string;

  constructor(defaultModelOrOptions: string | CodexProviderOptions = "default") {
    if (typeof defaultModelOrOptions === "string") {
      this.defaultModel = defaultModelOrOptions;
      this.modelMappings = {};
    } else {
      this.defaultModel = defaultModelOrOptions.defaultModel ?? "default";
      this.binary = defaultModelOrOptions.binary;
      this.modelMappings = defaultModelOrOptions.modelMappings ?? {};
      this.reasoningEffort = defaultModelOrOptions.reasoningEffort;
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
    const model = config.model || this.defaultModel;
    const plan = planCodexCli(
      {
        artifactDir: config.artifactDir,
        workspaceDir: config.workspaceDir,
        model,
        modelMappings: this.modelMappings,
        reasoningEffort: this.reasoningEffort,
      },
      this.binary,
    );
    writeFileSync(plan.promptFile, fullPrompt, "utf-8");

    const agentTimeout = config.timeout ?? 4 * 3600_000;
    const timeoutMin = Math.round(agentTimeout / 60_000);
    const startedAt = new Date();
    const startedMs = Date.now();
    const workspaceDir = config.workspaceDir ?? config.artifactDir;
    console.log(`  [codex] Running in ${workspaceDir} (timeout: ${timeoutMin}m)...`);

    const { exitCode, timedOut, exitErr } = await spawnCliCommand(plan.command, {
      // Codex receives its actual source cwd through `-C workspaceDir` above.
      // Keep the wrapper shell in artifactDir so provider-side stdout helpers
      // and relative evidence output cannot leak into the source workspace.
      cwd: config.artifactDir,
      timeoutMs: agentTimeout,
      signal,
    });

    const lastMessage = existsSync(plan.lastMessageFile)
      ? readFileSync(plan.lastMessageFile, "utf-8")
      : "";
    const stdout = existsSync(plan.stdoutFile) ? readFileSync(plan.stdoutFile, "utf-8") : "";
    const finishedAt = new Date();
    const cliModel = resolveCodexCliModel(model, this.modelMappings) ?? model;
    writeFileSync(
      join(config.artifactDir, "_agent_run.json"),
      JSON.stringify(
        {
          provider: "codex",
          model,
          cli_model: cliModel,
          reasoning_effort: this.reasoningEffort ?? null,
          command: plan.command,
          cwd: workspaceDir,
          stdout_path: plan.stdoutFile,
          last_message_path: plan.lastMessageFile,
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
      const msg = `[codex] TIMEOUT: Agent killed after ${timeoutMin} minutes. If this task needs more time, increase the stage timeout in pipeline.yaml.`;
      console.error(`  ${msg}`);
      writeFileSync(join(config.artifactDir, "_error.txt"), msg, "utf-8");
      throw new Error(msg);
    } else if (exitErr) {
      const errMsg = exitErr.message?.slice(0, 500) ?? "Unknown error";
      console.error(`  [codex] FAILED: ${errMsg}`);
      writeFileSync(join(config.artifactDir, "_error.txt"), `[codex] FAILED: ${errMsg}`, "utf-8");
    } else if (exitCode !== null && exitCode !== 0) {
      const msg = `[codex] FAILED: exit code ${exitCode}`;
      console.error(`  ${msg}`);
      writeFileSync(join(config.artifactDir, "_error.txt"), msg, "utf-8");
    }

    const resultText = lastMessage.trim() || stdout.trim();
    if (resultText) {
      writeFileSync(join(config.artifactDir, "_result.md"), resultText, "utf-8");
      console.log(`  [codex] Result: ${resultText.slice(0, 150).replace(/\n/g, " ")}...`);
    }

    return { artifacts: scanArtifacts(config.artifactDir) };
  }
}
