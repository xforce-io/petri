import { loadPetriConfig } from "../config/loader.js";
import { ClaudeCodeProvider } from "../providers/claude-code.js";
import { MilkieProvider, type MilkieModelMapping } from "../providers/milkie.js";
import { PiProvider } from "../providers/pi.js";
import type { AgentProvider } from "../types.js";

/**
 * Create an AgentProvider from the project's petri.yaml configuration.
 * Precedence when multiple provider types are declared: claude_code > milkie > pi.
 */
export function createProviderFromConfig(projectDir: string): AgentProvider {
  const petriConfig = loadPetriConfig(projectDir);
  const providerEntries = Object.entries(petriConfig.providers);
  const hasClaudeCode = providerEntries.some(([, v]) => v.type === "claude_code");
  const hasMilkie = providerEntries.some(([, v]) => v.type === "milkie");
  const defaultModel = petriConfig.defaults.model;

  if (hasClaudeCode) {
    return new ClaudeCodeProvider(defaultModel);
  }

  if (hasMilkie) {
    const milkieMappings: Record<string, MilkieModelMapping> = {};
    for (const [modelAlias, modelCfg] of Object.entries(petriConfig.models ?? {})) {
      milkieMappings[modelAlias] = {
        provider: modelCfg.provider,
        model: modelCfg.model,
        adapter: modelCfg.adapter ?? "openai-compatible",
        baseUrl: modelCfg.baseUrl,
        options: modelCfg.options,
      };
    }
    return new MilkieProvider(milkieMappings);
  }

  const modelMappings: Record<string, { piProvider: string; piModel: string }> = {};
  for (const [modelAlias, modelCfg] of Object.entries(petriConfig.models ?? {})) {
    modelMappings[modelAlias] = { piProvider: "anthropic", piModel: modelCfg.model };
  }
  return new PiProvider(modelMappings);
}
