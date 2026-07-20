import { loadPetriConfig } from "../config/loader.js";
import { ClaudeCodeProvider } from "../providers/claude-code.js";
import { CodexProvider } from "../providers/codex.js";
import { GrokProvider } from "../providers/grok.js";
import { MilkieProvider, type MilkieModelMapping } from "../providers/milkie.js";
import { PiProvider } from "../providers/pi.js";
import type { AgentProvider, PetriConfig, ProviderConfig, ProviderType } from "../types.js";

export interface ProviderRegistry {
  providers: Record<string, AgentProvider>;
  defaultProviderName: string;
}

type ProviderRole = { name: string; provider?: string; model: string };

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
  const registry = createProviderRegistry(petriConfig);
  return registry.providers[registry.defaultProviderName]!;
}

/** Create every named provider so roles can choose independently at runtime. */
export function createProviderRegistryFromConfig(projectDir: string): ProviderRegistry {
  return createProviderRegistry(loadPetriConfig(projectDir));
}

export function createProviderRegistry(petriConfig: PetriConfig): ProviderRegistry {
  const providerEntries = Object.entries(petriConfig.providers ?? {});
  const providers: Record<string, AgentProvider> = {};

  for (const [name, config] of providerEntries) {
    providers[name] = createProvider(config.type, petriConfig, config);
  }

  const defaultProviderName = resolveDefaultProviderName(petriConfig);
  if (!providers[defaultProviderName]) {
    // Keep the historical empty-provider fallback, while giving it a stable
    // name that can be recorded in run logs.
    providers[defaultProviderName] = createProvider(selectProviderType([]), petriConfig);
  }

  return { providers, defaultProviderName };
}

/** Resolve the provider used by a role; omitted role.provider keeps old defaults. */
export function resolveRoleProviderName(
  role: Pick<ProviderRole, "provider" | "model">,
  petriConfig: PetriConfig,
): string {
  return role.provider ?? resolveDefaultProviderName(petriConfig);
}

/**
 * Validate routing before a run starts. Explicit bad references never silently
 * fall back to the project default, and configured model/provider pairs stay
 * coherent.
 */
export function validateRoleProviderConfig(roles: ProviderRole[], petriConfig: PetriConfig): void {
  const providerNames = new Set(Object.keys(petriConfig.providers ?? {}));
  for (const role of roles) {
    const providerName = resolveRoleProviderName(role, petriConfig);
    if (role.provider && !providerNames.has(providerName)) {
      throw new Error(`role "${role.name}": provider "${providerName}" is not declared in petri.yaml.providers`);
    }

    const modelConfig = petriConfig.models?.[role.model];
    if (
      modelConfig
      && providerNames.has(modelConfig.provider)
      && modelConfig.provider !== providerName
    ) {
      throw new Error(
        `role "${role.name}": model "${role.model}" belongs to provider "${modelConfig.provider}", but role selects provider "${providerName}"`,
      );
    }
  }
}

function resolveDefaultProviderName(petriConfig: PetriConfig): string {
  const providerEntries = Object.entries(petriConfig.providers ?? {});
  const modelProvider = petriConfig.models?.[petriConfig.defaults.model]?.provider;
  if (modelProvider && petriConfig.providers?.[modelProvider]) return modelProvider;
  if (petriConfig.providers?.default) return "default";

  const selectedType = selectProviderType(providerEntries.map(([, config]) => config.type));
  return providerEntries.find(([, config]) => config.type === selectedType)?.[0] ?? "default";
}

function createProvider(
  selected: ProviderType,
  petriConfig: PetriConfig,
  providerConfig?: ProviderConfig,
): AgentProvider {
  const defaultModel = petriConfig.defaults.model;

  switch (selected) {
    case "grok":
      return new GrokProvider(defaultModel);
    case "codex": {
      const modelMappings: Record<string, string> = {};
      for (const [alias, modelCfg] of Object.entries(petriConfig.models ?? {})) {
        modelMappings[alias] = modelCfg.model;
      }
      return new CodexProvider({
        defaultModel,
        modelMappings,
        reasoningEffort: providerConfig?.reasoning_effort,
      });
    }
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
