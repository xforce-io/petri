import { spawn } from "node:child_process";
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
    const systemPrompt = [config.persona, "---", ...config.playbooks].join("\n\n");
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
    const startedAt = new Date();
    const startedMs = Date.now();
    console.log(`  [claude-code] Running ${model} in ${config.artifactDir} (timeout: ${timeoutMin}m)...`);

    // Spawn in a new process group (detached) so we can SIGKILL the entire
    // group on timeout. execSync's default SIGTERM goes to the immediate child
    // (bash), which doesn't propagate to grand-children (claude subprocess) —
    // observed in dogfood as orphan claude processes surviving 19+ minutes
    // past their stage's nominal timeout.
    let output: string = "";
    let timedOut = false;
    let exitCode: number | null = null;
    let exitErr: Error | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("/bin/bash", ["-c", cmd], {
          cwd: config.artifactDir,
          env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
          stdio: ["ignore", "ignore", "inherit"],
          detached: true, // new process group
        });
        const timer = setTimeout(() => {
          timedOut = true;
          // Kill the entire process group (negative PID). SIGKILL because
          // SIGTERM is what we tried before and claude subprocesses ignored.
          if (child.pid !== undefined) {
            try { process.kill(-child.pid, "SIGKILL"); } catch { /* group gone */ }
          }
          try { child.kill("SIGKILL"); } catch { /* already dead */ }
        }, agentTimeout);
        child.once("exit", (code) => {
          clearTimeout(timer);
          exitCode = code;
          resolve();
        });
        child.once("error", (err) => {
          clearTimeout(timer);
          exitErr = err;
          reject(err);
        });
      });
      output = existsSync(stdoutFile) ? readFileSync(stdoutFile, "utf-8") : "";
    } catch {
      output = existsSync(stdoutFile) ? readFileSync(stdoutFile, "utf-8") : "";
    }
    const finishedAt = new Date();
    writeFileSync(join(config.artifactDir, "_agent_run.json"), JSON.stringify({
      provider: "claude_code",
      model,
      command: `cat "${promptFile}" | "${claudeBin}" -p --model ${model} --output-format json --dangerously-skip-permissions`,
      cwd: config.artifactDir,
      stdout_path: stdoutFile,
      exit_code: exitCode,
      timed_out: timedOut,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: Date.now() - startedMs,
    }, null, 2), "utf-8");
    if (timedOut) {
      const msg = `[claude-code] TIMEOUT: Agent killed after ${timeoutMin} minutes. If this task needs more time, increase the stage timeout in pipeline.yaml.`;
      console.error(`  ${msg}`);
      writeFileSync(join(config.artifactDir, "_error.txt"), msg, "utf-8");
    } else if (exitErr) {
      const errMsg = (exitErr as Error).message?.slice(0, 500) ?? "Unknown error";
      console.error(`  [claude-code] FAILED: ${errMsg}`);
      writeFileSync(join(config.artifactDir, "_error.txt"), `[claude-code] FAILED: ${errMsg}`, "utf-8");
    } else if (exitCode !== null && exitCode !== 0) {
      const msg = `[claude-code] FAILED: exit code ${exitCode}`;
      console.error(`  ${msg}`);
      writeFileSync(join(config.artifactDir, "_error.txt"), msg, "utf-8");
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
      // JSON.parse failed — record sample so the upstream "no _result.md" error
      // is debuggable. Don't throw here: the agent may legitimately have written
      // artifact files and skipped JSON output.
      const head = output.slice(0, 300).replace(/\n/g, "\\n");
      const tail = output.length > 300 ? output.slice(-300).replace(/\n/g, "\\n") : "";
      const note = [
        `[claude-code] JSON parse failed (output length=${output.length}).`,
        `head=${JSON.stringify(head)}`,
        tail ? `tail=${JSON.stringify(tail)}` : "",
        `parse_error=${e instanceof Error ? e.message : String(e)}`,
      ].filter(Boolean).join("\n");
      try {
        writeFileSync(join(config.artifactDir, "_parse_error.txt"), note, "utf-8");
      } catch {}
      console.error(`  [claude-code] JSON parse failed (length=${output.length}). See _parse_error.txt`);
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
