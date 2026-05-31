import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PetriConfig } from "../../src/types.js";

const { mockLoad } = vi.hoisted(() => ({ mockLoad: vi.fn() }));

vi.mock("../../src/config/loader.js", () => ({
  loadPetriConfig: mockLoad,
}));

import { createProviderFromConfig } from "../../src/util/provider.js";
import { ClaudeCodeProvider } from "../../src/providers/claude-code.js";
import { MilkieProvider } from "../../src/providers/milkie.js";
import { PiProvider } from "../../src/providers/pi.js";

function config(partial: Partial<PetriConfig>): PetriConfig {
  return {
    providers: {},
    models: {},
    defaults: { model: "default", gate_strategy: "all", max_retries: 3 },
    ...partial,
  };
}

describe("createProviderFromConfig", () => {
  beforeEach(() => vi.clearAllMocks());

  it("prefers claude_code when present", () => {
    mockLoad.mockReturnValue(
      config({ providers: { a: { type: "claude_code" }, b: { type: "milkie" } } }),
    );
    expect(createProviderFromConfig("/proj")).toBeInstanceOf(ClaudeCodeProvider);
  });

  it("uses milkie when declared and no claude_code", () => {
    mockLoad.mockReturnValue(
      config({
        providers: { default: { type: "milkie" } },
        models: {
          doubao: {
            provider: "volcengine",
            model: "doubao-seed-2.0-lite",
            adapter: "openai-compatible",
            baseUrl: "https://example.com/api/v3",
          },
        },
      }),
    );
    expect(createProviderFromConfig("/proj")).toBeInstanceOf(MilkieProvider);
  });

  it("defaults the milkie adapter to openai-compatible when omitted", () => {
    mockLoad.mockReturnValue(
      config({
        providers: { default: { type: "milkie" } },
        models: { m: { provider: "x", model: "y" } },
      }),
    );
    const provider = createProviderFromConfig("/proj") as MilkieProvider;
    // Reach into the mapping the factory built to confirm the default.
    const mapping = (provider as unknown as { modelMappings: Record<string, { adapter: string }> })
      .modelMappings;
    expect(mapping.m.adapter).toBe("openai-compatible");
  });

  it("falls back to pi when neither claude_code nor milkie is declared", () => {
    mockLoad.mockReturnValue(
      config({
        providers: { default: { type: "pi" } },
        models: { m: { provider: "anthropic", model: "claude-x" } },
      }),
    );
    expect(createProviderFromConfig("/proj")).toBeInstanceOf(PiProvider);
  });
});
