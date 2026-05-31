import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentConfig } from "../../src/types.js";

// --- Hoisted mocks for the milkie SDK ---

const {
  captured,
  MockMilkie,
  MockMemoryStore,
  mockComplete,
  mockCreateGateway,
  resetCaptured,
} = vi.hoisted(() => {
  const captured: {
    opts?: any;
    agentConfig?: any;
    invokeReq?: any;
  } = {};

  // The fake base gateway milkie's createGateway would return. Its complete()
  // reports usage so the provider's counting proxy has something to tally.
  const mockComplete = vi.fn().mockResolvedValue({
    content: [],
    toolCalls: [],
    usage: { inputTokens: 100, outputTokens: 50, cost: 0.001 },
  });
  const mockCreateGateway = vi.fn(() => ({
    complete: mockComplete,
    stream: vi.fn(),
  }));

  class MockMilkie {
    constructor(opts: any) {
      captured.opts = opts;
    }
    registerAgent(config: any) {
      captured.agentConfig = config;
    }
    async invoke(req: any) {
      captured.invokeReq = req;
      // Simulate milkie driving one model call through the (wrapped) gateway.
      await captured.opts.gateway.complete({ model: "m", messages: [] });
      return { agentRunId: "r1", contextId: "c1", output: "done", status: "completed" };
    }
  }

  class MockMemoryStore {}

  const resetCaptured = () => {
    captured.opts = undefined;
    captured.agentConfig = undefined;
    captured.invokeReq = undefined;
  };

  return { captured, MockMilkie, MockMemoryStore, mockComplete, mockCreateGateway, resetCaptured };
});

vi.mock("milkie", () => ({
  Milkie: MockMilkie,
  MemoryStore: MockMemoryStore,
  createGateway: mockCreateGateway,
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn().mockReturnValue("file content"),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue(["result.json", "output.txt"]),
  existsSync: vi.fn().mockReturnValue(true),
  statSync: vi.fn().mockReturnValue({ isFile: () => true }),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockReturnValue(Buffer.from("command output")),
}));

// --- Import after mocks ---

import { MilkieProvider } from "../../src/providers/milkie.js";

describe("MilkieProvider", () => {
  const defaultConfig: AgentConfig = {
    persona: "You are a helpful coding assistant.",
    playbooks: ["Write clean TypeScript", "Follow best practices"],
    context: "Create a hello world program",
    artifactDir: "/tmp/test-artifacts",
    model: "doubao",
  };

  const provider = new MilkieProvider({
    doubao: {
      provider: "volcengine",
      model: "doubao-seed-2.0-lite",
      adapter: "openai-compatible",
      baseUrl: "https://example.com/api/v3",
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetCaptured();
  });

  it("assembles systemPrompt from persona + playbooks", async () => {
    await provider.createAgent(defaultConfig).run();

    const prompt: string = captured.agentConfig.systemPrompt;
    expect(prompt).toContain("You are a helpful coding assistant.");
    expect(prompt).toContain("Write clean TypeScript");
    expect(prompt).toContain("Follow best practices");
  });

  it("maps the model alias to a milkie ModelConfig", async () => {
    await provider.createAgent(defaultConfig).run();

    expect(captured.agentConfig.model).toMatchObject({
      provider: "volcengine",
      model: "doubao-seed-2.0-lite",
      adapter: "openai-compatible",
      baseUrl: "https://example.com/api/v3",
    });
    // The gateway must be built from the same model config.
    expect(mockCreateGateway).toHaveBeenCalledWith(
      expect.objectContaining({ adapter: "openai-compatible", model: "doubao-seed-2.0-lite" }),
    );
  });

  it("registers a single llm/react FSM state exposing the file + shell tools", async () => {
    await provider.createAgent(defaultConfig).run();

    const states = captured.agentConfig.fsm.states;
    expect(states).toHaveLength(1);
    expect(states[0].type).toBe("llm");
    expect(states[0].tools).toEqual(
      expect.arrayContaining(["file_read", "file_write", "shell_run"]),
    );

    // The tools themselves must be registered on the Milkie instance.
    const toolNames = captured.opts.tools.map((t: any) => t.name);
    expect(toolNames).toContain("file_read");
    expect(toolNames).toContain("file_write");
    expect(toolNames).toContain("shell_run");
  });

  it("invokes with the petri context as the agent input", async () => {
    await provider.createAgent(defaultConfig).run();

    expect(captured.invokeReq.input).toBe("Create a hello world program");
    expect(typeof captured.invokeReq.goal).toBe("string");
    expect(captured.invokeReq.goal.length).toBeGreaterThan(0);
  });

  it("returns artifacts scanned from the artifact directory", async () => {
    const result = await provider.createAgent(defaultConfig).run();
    expect(result.artifacts).toEqual(["result.json", "output.txt"]);
  });

  it("tallies usage from the wrapped gateway", async () => {
    const result = await provider.createAgent(defaultConfig).run();

    expect(result.usage).toBeDefined();
    expect(result.usage!.inputTokens).toBe(100);
    expect(result.usage!.outputTokens).toBe(50);
    expect(result.usage!.costUsd).toBeCloseTo(0.001, 6);
  });

  it("throws when the model mapping is not found", async () => {
    const agent = provider.createAgent({ ...defaultConfig, model: "unknown" });
    await expect(agent.run()).rejects.toThrow('No model mapping found for "unknown"');
  });
});
