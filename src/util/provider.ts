import { loadPetriConfig } from "../config/loader.js";
import { ClaudeCodeProvider } from "../providers/claude-code.js";
import { PiProvider } from "../providers/pi.js";
import type { AgentProvider } from "../types.js";

/**
 * Create an AgentProvider from the project's petri.yaml configuration.
 */
export function createProviderFromConfig(projectDir: string): AgentProvider {
  const petriConfig = loadPetriConfig(projectDir);
  const providerEntries = Object.entries(petriConfig.providers);
  const hasClaudeCode = providerEntries.some(([, v]) => v.type === "claude_code");
  const defaultModel = petriConfig.defaults.model;

  if (hasClaudeCode) {
    return new ClaudeCodeProvider(defaultModel);
  }

  const modelMappings: Record<string, { piProvider: string; piModel: string }> = {};
  for (const [modelAlias, modelCfg] of Object.entries(petriConfig.models ?? {})) {
    const provCfg = petriConfig.providers[modelCfg.provider];
    if (provCfg) {
      modelMappings[modelAlias] = { piProvider: modelCfg.provider, piModel: modelCfg.model };
    }
  }
  return new PiProvider(modelMappings);
}
