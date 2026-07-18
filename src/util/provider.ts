import { loadPetriConfig } from "../config/loader.js";
import { ClaudeCodeProvider } from "../providers/claude-code.js";
import { CodexProvider } from "../providers/codex.js";
import { GrokProvider } from "../providers/grok.js";
import { MilkieProvider, type MilkieModelMapping } from "../providers/milkie.js";
import { PiProvider } from "../providers/pi.js";
import type { AgentProvider, ProviderType } from "../types.js";

/**
 * Precedence when multiple provider types are declared:
 *   grok > codex > claude_code > milkie > pi
 * When none match (empty providers), default is **grok**.
 */
export function selectProviderType(types: Iterable<string>): ProviderType {
  const set = new Set(types);
  if (set.has("grok")) return "grok";
  if (set.has("codex")) return "codex";
  if (set.has("claude_code")) return "claude_code";
  if (set.has("milkie")) return "milkie";
  if (set.has("pi")) return "pi";
  return "grok";
}

/**
 * Create an AgentProvider from the project's petri.yaml configuration.
 * See {@link selectProviderType} for multi-type precedence (default: grok).
 */
export function createProviderFromConfig(projectDir: string): AgentProvider {
  const petriConfig = loadPetriConfig(projectDir);
  const providerEntries = Object.entries(petriConfig.providers);
  const types = providerEntries.map(([, v]) => v.type);
  const selected = selectProviderType(types);
  const defaultModel = petriConfig.defaults.model;

  switch (selected) {
    case "grok":
      return new GrokProvider(defaultModel);
    case "codex":
      return new CodexProvider(defaultModel);
    case "claude_code":
      return new ClaudeCodeProvider(defaultModel);
    case "milkie": {
      const milkieMappings: Record<string, MilkieModelMapping> = {};
      for (const [modelAlias, modelCfg] of Object.entries(petriConfig.models ?? {})) {
        milkieMappings[modelAlias] = {
          provider: modelCfg.provider,
          model: modelCfg.model,
          adapter: modelCfg.adapter ?? "openai-compatible",
          baseUrl: modelCfg.baseUrl,
        };
      }
      return new MilkieProvider(milkieMappings);
    }
    case "pi": {
      const modelMappings: Record<string, { piProvider: string; piModel: string }> = {};
      for (const [modelAlias, modelCfg] of Object.entries(petriConfig.models ?? {})) {
        modelMappings[modelAlias] = { piProvider: "anthropic", piModel: modelCfg.model };
      }
      return new PiProvider(modelMappings);
    }
    default: {
      const _exhaustive: never = selected;
      return _exhaustive;
    }
  }
}
