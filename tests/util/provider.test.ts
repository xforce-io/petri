import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PetriConfig } from "../../src/types.js";

const { mockLoad } = vi.hoisted(() => ({ mockLoad: vi.fn() }));

vi.mock("../../src/config/loader.js", () => ({
  loadPetriConfig: mockLoad,
}));

import { createProviderFromConfig, selectProviderType } from "../../src/util/provider.js";
import { ClaudeCodeProvider } from "../../src/providers/claude-code.js";
import { CodexProvider } from "../../src/providers/codex.js";
import { GrokProvider } from "../../src/providers/grok.js";
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

describe("selectProviderType", () => {
  it("prefers grok over every other declared type", () => {
    expect(
      selectProviderType(["claude_code", "milkie", "pi", "codex", "grok"]),
    ).toBe("grok");
  });

  it("prefers codex over claude_code / milkie / pi when grok is absent", () => {
    expect(selectProviderType(["claude_code", "codex", "milkie"])).toBe("codex");
  });

  it("keeps historical claude_code > milkie > pi when neither grok nor codex", () => {
    expect(selectProviderType(["milkie", "claude_code", "pi"])).toBe("claude_code");
    expect(selectProviderType(["milkie", "pi"])).toBe("milkie");
    expect(selectProviderType(["pi"])).toBe("pi");
  });

  it("defaults to grok when no provider types are declared", () => {
    expect(selectProviderType([])).toBe("grok");
  });
});

describe("createProviderFromConfig", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns GrokProvider when type is grok", () => {
    mockLoad.mockReturnValue(config({ providers: { default: { type: "grok" } } }));
    expect(createProviderFromConfig("/proj")).toBeInstanceOf(GrokProvider);
  });

  it("returns CodexProvider when type is codex", () => {
    mockLoad.mockReturnValue(config({ providers: { default: { type: "codex" } } }));
    expect(createProviderFromConfig("/proj")).toBeInstanceOf(CodexProvider);
  });

  it("defaults to GrokProvider when providers map is empty", () => {
    mockLoad.mockReturnValue(config({ providers: {} }));
    expect(createProviderFromConfig("/proj")).toBeInstanceOf(GrokProvider);
  });

  it("prefers grok when multiple types including claude_code are present", () => {
    mockLoad.mockReturnValue(
      config({ providers: { a: { type: "claude_code" }, b: { type: "grok" } } }),
    );
    expect(createProviderFromConfig("/proj")).toBeInstanceOf(GrokProvider);
  });

  it("prefers codex over claude_code when both present and no grok", () => {
    mockLoad.mockReturnValue(
      config({ providers: { a: { type: "claude_code" }, b: { type: "codex" } } }),
    );
    expect(createProviderFromConfig("/proj")).toBeInstanceOf(CodexProvider);
  });

  it("prefers claude_code when present without grok/codex", () => {
    mockLoad.mockReturnValue(
      config({ providers: { a: { type: "claude_code" }, b: { type: "milkie" } } }),
    );
    expect(createProviderFromConfig("/proj")).toBeInstanceOf(ClaudeCodeProvider);
  });

  it("uses milkie when declared and no higher-priority type", () => {
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
    const mapping = (provider as unknown as { modelMappings: Record<string, { adapter: string }> })
      .modelMappings;
    expect(mapping.m.adapter).toBe("openai-compatible");
  });

  it("falls back to pi when only pi is declared", () => {
    mockLoad.mockReturnValue(
      config({
        providers: { default: { type: "pi" } },
        models: { m: { provider: "anthropic", model: "claude-x" } },
      }),
    );
    expect(createProviderFromConfig("/proj")).toBeInstanceOf(PiProvider);
  });
});
