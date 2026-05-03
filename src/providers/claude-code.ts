import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
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
    const promptFile = join(config.artifactDir, "_prompt.md");
    writeFileSync(promptFile, fullPrompt, "utf-8");

    const model = config.model === "sonnet" ? "sonnet" : config.model;

    // Find the real claude binary (execSync doesn't expand shell aliases)
    const claudeBin = findClaude();
    // Redirect stdout to disk to avoid node child_process pipe-buffer/utf-8 decode
    // truncation that drops long responses at ~16KB.
    const stdoutFile = join(config.artifactDir, "_claude_stdout.json");
    const cmd = `cat "${promptFile}" | "${claudeBin}" -p --model ${model} --output-format json --dangerously-skip-permissions > "${stdoutFile}"`;

    // Default: 4 hours. Stage timeout is passed through if set.
    const agentTimeout = config.timeout ?? 4 * 3600_000;
    const timeoutMin = Math.round(agentTimeout / 60_000);
    console.log(`  [claude-code] Running ${model} in ${config.artifactDir} (timeout: ${timeoutMin}m)...`);

    let output: string;
    try {
      execSync(cmd, {
        cwd: config.artifactDir,
        timeout: agentTimeout,
        shell: "/bin/bash",
        env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
        stdio: ["ignore", "ignore", "inherit"],
      });
      output = existsSync(stdoutFile) ? readFileSync(stdoutFile, "utf-8") : "";
    } catch (e: any) {
      // Even on error, the redirect file may have partial content
      output = existsSync(stdoutFile) ? readFileSync(stdoutFile, "utf-8") : "";
      const isTimeout = e.killed || e.signal === "SIGTERM";
      if (isTimeout) {
        const msg = `[claude-code] TIMEOUT: Agent killed after ${timeoutMin} minutes. If this task needs more time, increase the stage timeout in pipeline.yaml.`;
        console.error(`  ${msg}`);
        writeFileSync(join(config.artifactDir, "_error.txt"), msg, "utf-8");
      } else {
        const errMsg = e.message?.slice(0, 500) ?? "Unknown error";
        console.error(`  [claude-code] FAILED: ${errMsg}`);
        writeFileSync(join(config.artifactDir, "_error.txt"), `[claude-code] FAILED: ${errMsg}`, "utf-8");
      }
    }

    // Detect rate limit / quota errors — abort immediately instead of wasting iterations
    if (output.includes("hit your limit") || output.includes("rate limit") || output.includes("quota exceeded")) {
      const msg = `[claude-code] RATE LIMITED: API quota exhausted. Pipeline cannot continue. Output: ${output.slice(0, 300)}`;
      console.error(`  ${msg}`);
      writeFileSync(join(config.artifactDir, "_error.txt"), msg, "utf-8");
      throw new Error(msg);
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
        // Also check result text for rate limit messages
        if (parsed.result.includes("hit your limit") || parsed.result.includes("rate limit")) {
          const msg = `[claude-code] RATE LIMITED: ${parsed.result.slice(0, 300)}`;
          console.error(`  ${msg}`);
          writeFileSync(join(config.artifactDir, "_error.txt"), msg, "utf-8");
          throw new Error(msg);
        }
        console.log(`  [claude-code] Result: ${parsed.result.slice(0, 150)}...`);
        writeFileSync(join(config.artifactDir, "_result.md"), parsed.result, "utf-8");
      }
    } catch (e) {
      // Re-throw rate limit errors
      if (e instanceof Error && e.message.includes("RATE LIMITED")) throw e;
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
