import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, Type } from "@mariozechner/pi-ai";
import type { AgentProvider, PetriAgent, AgentConfig, AgentResult } from "./interface.js";

export interface PiModelMapping {
  piProvider: string;
  piModel: string;
}

export class PiProvider implements AgentProvider {
  constructor(private modelMappings: Record<string, PiModelMapping>) {}

  createAgent(config: AgentConfig): PetriAgent {
    return {
      run: () => this.runAgent(config),
    };
  }

  private async runAgent(config: AgentConfig): Promise<AgentResult> {
    const mapping = this.modelMappings[config.model];
    if (!mapping) {
      throw new Error(`No model mapping found for "${config.model}"`);
    }

    const model = getModel(mapping.piProvider as any, mapping.piModel as any);
    if (!model) {
      throw new Error(
        `Pi model not found: provider="${mapping.piProvider}", model="${mapping.piModel}"`,
      );
    }

    // Build system prompt from persona + skills
    const skillsText = config.skills.map((s) => `- ${s}`).join("\n");
    const systemPrompt = `${config.persona}\n\nSkills:\n${skillsText}`;

    // Create agent with tools
    const agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        thinkingLevel: "low",
        tools: buildTools(config.artifactDir),
      },
    });

    // Track usage across turns
    let totalInput = 0;
    let totalOutput = 0;
    let totalCost = 0;

    agent.subscribe((event) => {
      if (event.type === "turn_end") {
        const msg = event.message;
        if (msg && "usage" in msg && msg.role === "assistant") {
          totalInput += msg.usage.input;
          totalOutput += msg.usage.output;
          totalCost += msg.usage.cost.total;
        }
      }
    });

    // Run the agent
    await agent.prompt(config.context);
    await agent.waitForIdle();

    // Scan artifact directory for produced files
    const artifacts = scanArtifacts(config.artifactDir);

    return {
      artifacts,
      usage: {
        inputTokens: totalInput,
        outputTokens: totalOutput,
        costUsd: totalCost,
      },
    };
  }
}

function buildTools(artifactDir: string) {
  return [
    {
      name: "shell_run",
      label: "Run shell command",
      description: "Execute a shell command and return its output.",
      parameters: Type.Object({
        command: Type.String({ description: "The shell command to execute" }),
        timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds" })),
      }),
      execute: async (
        _toolCallId: string,
        params: { command: string; timeout?: number },
      ) => {
        try {
          const output = execSync(params.command, {
            cwd: artifactDir,
            timeout: params.timeout,
            encoding: "utf-8",
          });
          return {
            content: [{ type: "text" as const, text: output }],
            details: {},
          };
        } catch (err: any) {
          return {
            content: [{ type: "text" as const, text: err.message ?? String(err) }],
            details: {},
          };
        }
      },
    },
    {
      name: "file_read",
      label: "Read file",
      description: "Read the contents of a file.",
      parameters: Type.Object({
        path: Type.String({ description: "Path to the file to read" }),
      }),
      execute: async (_toolCallId: string, params: { path: string }) => {
        try {
          const content = readFileSync(params.path, "utf-8");
          return {
            content: [{ type: "text" as const, text: content }],
            details: {},
          };
        } catch (err: any) {
          return {
            content: [{ type: "text" as const, text: err.message ?? String(err) }],
            details: {},
          };
        }
      },
    },
    {
      name: "file_write",
      label: "Write file",
      description: "Write content to a file, creating parent directories if needed.",
      parameters: Type.Object({
        path: Type.String({ description: "Path to the file to write" }),
        content: Type.String({ description: "Content to write" }),
      }),
      execute: async (
        _toolCallId: string,
        params: { path: string; content: string },
      ) => {
        try {
          mkdirSync(dirname(params.path), { recursive: true });
          writeFileSync(params.path, params.content, "utf-8");
          return {
            content: [{ type: "text" as const, text: `Wrote ${params.path}` }],
            details: {},
          };
        } catch (err: any) {
          return {
            content: [{ type: "text" as const, text: err.message ?? String(err) }],
            details: {},
          };
        }
      },
    },
  ];
}

function scanArtifacts(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((name) => {
      try {
        return statSync(join(dir, name)).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}
