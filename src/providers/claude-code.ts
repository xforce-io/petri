import { execSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentProvider, PetriAgent, AgentConfig, AgentResult } from "./interface.js";

export class ClaudeCodeProvider implements AgentProvider {
  constructor(private defaultModel: string = "haiku") {}

  createAgent(config: AgentConfig): PetriAgent {
    return {
      run: () => this.runAgent(config),
    };
  }

  private async runAgent(config: AgentConfig): Promise<AgentResult> {
    const systemPrompt = [config.persona, "---", ...config.skills].join("\n\n");

    const fullPrompt = `${systemPrompt}\n\n---\n\n${config.context}`;

    // Shell out to claude CLI
    const model = config.model === "sonnet" ? "sonnet" : config.model;
    const cmd = `claude -p ${escapeShellArg(fullPrompt)} --model ${model} --output-format json --dangerously-skip-permissions`;

    let output: string;
    try {
      output = execSync(cmd, {
        cwd: config.artifactDir,
        encoding: "utf-8",
        timeout: 300_000,  // 5 min
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      });
    } catch (e: any) {
      console.error(`Claude Code error: ${e.message?.slice(0, 500)}`);
      return { artifacts: [], usage: undefined };
    }

    // Parse JSON output
    let usage: AgentResult["usage"];
    try {
      const parsed = JSON.parse(output);
      // Claude Code JSON output has: { type, subtype, cost_usd, duration_ms, ... }
      // Or it may be an array of messages
      if (parsed.cost_usd) {
        usage = {
          inputTokens: parsed.input_tokens ?? 0,
          outputTokens: parsed.output_tokens ?? 0,
          costUsd: parsed.cost_usd ?? 0,
        };
      }
    } catch {
      // non-JSON output is fine, agent still may have written files
    }

    const artifacts = scanArtifacts(config.artifactDir);
    return { artifacts, usage };
  }
}

function escapeShellArg(arg: string): string {
  // Use base64 to avoid shell injection
  const b64 = Buffer.from(arg).toString("base64");
  return `"$(echo ${b64} | base64 -d)"`;
}

function scanArtifacts(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => !name.startsWith("."))
      .filter((name) => {
        try { return statSync(join(dir, name)).isFile(); } catch { return false; }
      })
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}
