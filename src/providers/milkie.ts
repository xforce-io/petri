import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { Milkie, MemoryStore, createGateway } from "milkie";
import type {
  ToolDefinition,
  ModelConfig as MilkieModelConfig,
  IModelGateway,
} from "milkie";
import type { AgentProvider, PetriAgent, AgentConfig, AgentResult } from "./interface.js";

/**
 * Per-alias milkie model configuration. A superset of petri's ModelConfig —
 * `adapter`/`baseUrl`/`options` select and configure milkie's gateway.
 */
export type MilkieModelMapping = MilkieModelConfig;

const AGENT_ID = "petri-role";
const MAX_ITERATIONS = 20;
const TOOL_NAMES = ["file_read", "file_write", "shell_run"];

/**
 * Runs a petri role as an in-process milkie agent. petri assembles the prompt
 * and assigns a working directory; the milkie agent writes its artifacts there
 * via the file/shell tools, and petri scans the directory afterwards — the same
 * file-based contract every other provider honors.
 */
export class MilkieProvider implements AgentProvider {
  constructor(private modelMappings: Record<string, MilkieModelMapping>) {}

  createAgent(config: AgentConfig): PetriAgent {
    return {
      run: () => this.runAgent(config),
    };
  }

  private async runAgent(config: AgentConfig): Promise<AgentResult> {
    const model = this.modelMappings[config.model];
    if (!model) {
      throw new Error(`No model mapping found for "${config.model}"`);
    }

    const systemPrompt = [config.persona, "---", ...config.playbooks].join("\n\n");

    // Wrap milkie's gateway so we can tally token usage — milkie's AgentResult
    // carries no usage, and Trajectory.metrics only reports a combined token
    // count, not the input/output split petri's AgentResult.usage needs.
    const tally = { input: 0, output: 0, cost: 0 };
    const gateway = wrapGateway(createGateway(model), tally);

    const milkie = new Milkie({
      stateStore: new MemoryStore(),
      tools: buildTools(config.artifactDir),
      gateway,
    });

    milkie.registerAgent({
      agentId: AGENT_ID,
      version: "1.0.0",
      systemPrompt,
      fsm: {
        states: [
          { name: "react", type: "llm", max_iterations: MAX_ITERATIONS, tools: TOOL_NAMES },
        ],
      },
      model,
    });

    await milkie.invoke({
      agentId: AGENT_ID,
      goal: "Complete the assigned task as described in the input.",
      input: config.context,
    });

    return {
      artifacts: scanArtifacts(config.artifactDir),
      usage: {
        inputTokens: tally.input,
        outputTokens: tally.output,
        costUsd: tally.cost,
      },
    };
  }
}

interface UsageTally {
  input: number;
  output: number;
  cost: number;
}

/**
 * Proxy a milkie gateway, accumulating usage from each model response into
 * `tally`. Both the unary `complete` path and the streaming `stream` path are
 * covered so usage is captured regardless of which one the runtime drives.
 */
function wrapGateway(base: IModelGateway, tally: UsageTally): IModelGateway {
  return {
    async complete(request) {
      const response = await base.complete(request);
      if (response.usage) {
        tally.input += response.usage.inputTokens;
        tally.output += response.usage.outputTokens;
        tally.cost += response.usage.cost ?? 0;
      }
      return response;
    },
    stream(request) {
      const iterable = base.stream(request);
      return (async function* () {
        for await (const event of iterable) {
          if (event.type === "usage") {
            tally.input += event.data.inputTokens;
            tally.output += event.data.outputTokens;
            tally.cost += event.data.cost ?? 0;
          }
          yield event;
        }
      })();
    },
  };
}

function buildTools(artifactDir: string): ToolDefinition[] {
  return [
    {
      name: "shell_run",
      description: "Execute a shell command in the working directory and return its output.",
      parallelSafe: false,
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute" },
          timeout: { type: "number", description: "Timeout in milliseconds" },
        },
        required: ["command"],
      },
      handler: async (input) => {
        const { command, timeout } = input as { command: string; timeout?: number };
        try {
          return execSync(command, { cwd: artifactDir, timeout, encoding: "utf-8" });
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      },
    },
    {
      name: "file_read",
      description: "Read the contents of a file.",
      parallelSafe: true,
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Path to the file to read" } },
        required: ["path"],
      },
      handler: async (input) => {
        const { path } = input as { path: string };
        try {
          return readFileSync(path, "utf-8");
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      },
    },
    {
      name: "file_write",
      description: "Write content to a file, creating parent directories if needed.",
      parallelSafe: false,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file to write" },
          content: { type: "string", description: "Content to write" },
        },
        required: ["path", "content"],
      },
      handler: async (input) => {
        const { path, content } = input as { path: string; content: string };
        try {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, content, "utf-8");
          return `Wrote ${path}`;
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      },
    },
  ];
}

function scanArtifacts(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => !name.startsWith("."))
      .filter((name) => {
        try {
          return statSync(join(dir, name)).isFile();
        } catch {
          return false;
        }
      })
      // Return joined paths, like claude-code.ts: the engine's manifest.collect
      // does path.relative(baseDir, p), which only yields a correct relative
      // path for absolute/joined inputs. Bare names resolve against cwd.
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}
