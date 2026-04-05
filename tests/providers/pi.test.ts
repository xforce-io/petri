import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentConfig } from "../../src/types.js";

// --- Hoisted mocks ---

const { mockSubscribe, mockPrompt, mockWaitForIdle, mockState, MockAgent, mockGetModel } =
  vi.hoisted(() => {
    const mockSubscribe = vi.fn();
    const mockPrompt = vi.fn().mockResolvedValue(undefined);
    const mockWaitForIdle = vi.fn().mockResolvedValue(undefined);
    const mockState = {
      systemPrompt: "",
      model: null as any,
      thinkingLevel: "low" as const,
      tools: [] as any[],
      messages: [] as any[],
      isStreaming: false,
      pendingToolCalls: new Set<string>(),
    };

    const MockAgent = vi.fn().mockImplementation(() => ({
      subscribe: mockSubscribe,
      prompt: mockPrompt,
      waitForIdle: mockWaitForIdle,
      state: mockState,
    }));

    const mockModel = {
      id: "claude-sonnet-4-20250514",
      name: "Claude Sonnet 4",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      contextWindow: 200000,
      maxTokens: 8192,
    };

    const mockGetModel = vi.fn().mockReturnValue(mockModel);

    return { mockSubscribe, mockPrompt, mockWaitForIdle, mockState, MockAgent, mockGetModel };
  });

vi.mock("@mariozechner/pi-agent-core", () => ({
  Agent: MockAgent,
}));

vi.mock("@mariozechner/pi-ai", async () => {
  const { Type } = await vi.importActual<typeof import("@sinclair/typebox")>("@sinclair/typebox");
  return {
    getModel: mockGetModel,
    Type,
  };
});

// Mock fs and child_process
vi.mock("node:fs", () => ({
  readFileSync: vi.fn().mockReturnValue("file content"),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue(["output.json", "result.txt"]),
  existsSync: vi.fn().mockReturnValue(true),
  statSync: vi.fn().mockReturnValue({ isFile: () => true }),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockReturnValue(Buffer.from("command output")),
}));

// --- Import after mocks ---

import { PiProvider } from "../../src/providers/pi.js";

describe("PiProvider", () => {
  const defaultConfig: AgentConfig = {
    persona: "You are a helpful coding assistant.",
    skills: ["Write clean TypeScript", "Follow best practices"],
    context: "Create a hello world program",
    artifactDir: "/tmp/test-artifacts",
    model: "sonnet",
  };

  const provider = new PiProvider({
    sonnet: { piProvider: "anthropic", piModel: "claude-sonnet-4-20250514" },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockState.tools = [];
    mockState.messages = [];
  });

  it("creates an agent and calls prompt + waitForIdle", async () => {
    const agent = provider.createAgent(defaultConfig);
    const result = await agent.run();

    // Should have looked up the model
    expect(mockGetModel).toHaveBeenCalledWith("anthropic", "claude-sonnet-4-20250514");

    // Should have created an Agent
    expect(MockAgent).toHaveBeenCalledTimes(1);

    // Should have set system prompt, model, thinkingLevel
    const agentOpts = MockAgent.mock.calls[0][0];
    expect(agentOpts.initialState.systemPrompt).toContain("You are a helpful coding assistant.");
    expect(agentOpts.initialState.systemPrompt).toContain("Write clean TypeScript");
    expect(agentOpts.initialState.systemPrompt).toContain("Follow best practices");
    expect(agentOpts.initialState.model).toBeDefined();
    expect(agentOpts.initialState.thinkingLevel).toBe("low");

    // Should have called prompt and waitForIdle
    expect(mockPrompt).toHaveBeenCalledWith("Create a hello world program");
    expect(mockWaitForIdle).toHaveBeenCalled();

    // Should return artifacts
    expect(result.artifacts).toEqual(["output.json", "result.txt"]);
  });

  it("sets 3 tools on the agent", async () => {
    const agent = provider.createAgent(defaultConfig);
    await agent.run();

    const agentOpts = MockAgent.mock.calls[0][0];
    const tools = agentOpts.initialState.tools;
    expect(tools).toHaveLength(3);

    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).toContain("shell_run");
    expect(toolNames).toContain("file_read");
    expect(toolNames).toContain("file_write");
  });

  it("tracks usage from agent events", async () => {
    // Capture the subscribe listener
    let listener: ((event: any, signal: AbortSignal) => void) | undefined;
    mockSubscribe.mockImplementation((fn: any) => {
      listener = fn;
      return () => {};
    });

    // Make prompt trigger usage events
    mockPrompt.mockImplementation(async () => {
      if (listener) {
        const signal = new AbortController().signal;
        await listener(
          {
            type: "turn_end",
            message: {
              role: "assistant",
              usage: {
                input: 100,
                output: 50,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 150,
                cost: { input: 0.0003, output: 0.00075, cacheRead: 0, cacheWrite: 0, total: 0.00105 },
              },
            },
            toolResults: [],
          },
          signal,
        );
        await listener(
          {
            type: "turn_end",
            message: {
              role: "assistant",
              usage: {
                input: 200,
                output: 80,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 280,
                cost: { input: 0.0006, output: 0.0012, cacheRead: 0, cacheWrite: 0, total: 0.0018 },
              },
            },
            toolResults: [],
          },
          signal,
        );
      }
    });

    const agent = provider.createAgent(defaultConfig);
    const result = await agent.run();

    expect(result.usage).toBeDefined();
    expect(result.usage!.inputTokens).toBe(300);
    expect(result.usage!.outputTokens).toBe(130);
    expect(result.usage!.costUsd).toBeCloseTo(0.00285, 5);
  });

  it("throws when model mapping is not found", async () => {
    const badConfig: AgentConfig = {
      ...defaultConfig,
      model: "unknown-model",
    };
    const agent = provider.createAgent(badConfig);
    await expect(agent.run()).rejects.toThrow('No model mapping found for "unknown-model"');
  });

  it("throws when pi model is not found", async () => {
    mockGetModel.mockReturnValueOnce(undefined);
    const agent = provider.createAgent(defaultConfig);
    await expect(agent.run()).rejects.toThrow();
  });
});
