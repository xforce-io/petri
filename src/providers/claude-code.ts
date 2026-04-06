import { execSync } from "node:child_process";
import { existsSync, readdirSync, statSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

    // Write prompt to temp file to avoid shell escaping issues
    mkdirSync(config.artifactDir, { recursive: true });
    const promptFile = join(config.artifactDir, ".petri-prompt.md");
    writeFileSync(promptFile, fullPrompt, "utf-8");

    const model = config.model === "sonnet" ? "sonnet" : config.model;

    // Find the real claude binary (execSync doesn't expand shell aliases)
    const claudeBin = findClaude();
    const cmd = `cat "${promptFile}" | "${claudeBin}" -p - --model ${model} --output-format json --dangerously-skip-permissions`;

    console.log(`  [claude-code] Running ${model} in ${config.artifactDir}...`);

    let output: string;
    try {
      output = execSync(cmd, {
        cwd: config.artifactDir,
        encoding: "utf-8",
        timeout: 900_000,  // 15 min
        maxBuffer: 10 * 1024 * 1024,
        shell: "/bin/bash",
        env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      });
    } catch (e: any) {
      console.error(`  [claude-code] Error: ${e.message?.slice(0, 500)}`);
      // stdout may still have useful output even on non-zero exit
      output = e.stdout ?? "";
    } finally {
      try { unlinkSync(promptFile); } catch {}
    }

    // Parse JSON output — Claude Code returns { type, result, total_cost_usd, usage: {...} }
    let usage: AgentResult["usage"];
    try {
      const parsed = JSON.parse(output);
      const totalCost = parsed.total_cost_usd ?? parsed.cost_usd ?? 0;
      const mu = parsed.modelUsage ?? {};
      const firstModel = Object.values(mu)[0] as any;
      usage = {
        inputTokens: firstModel?.inputTokens ?? 0,
        outputTokens: firstModel?.outputTokens ?? 0,
        costUsd: totalCost,
      };
      if (parsed.result) {
        console.log(`  [claude-code] Result: ${parsed.result.slice(0, 150)}...`);
      }
    } catch {
      // non-JSON output is fine, agent still may have written files
    }

    const artifacts = scanArtifacts(config.artifactDir);
    return { artifacts, usage };
  }
}

function findClaude(): string {
  // Check common locations
  const candidates = [
    process.env.HOME + "/.local/bin/claude",
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Fallback: hope it's on PATH
  return "claude";
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
