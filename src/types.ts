// src/types.ts

// --- Pipeline ---

export interface PipelineConfig {
  name: string;
  description?: string;
  stages: StageEntry[];
  input?: { description: string };
}

export type StageEntry = StageConfig | RepeatBlock;

export interface StageConfig {
  name: string;
  roles: string[];
  max_retries?: number;
  gate_strategy?: GateStrategy;
  overrides?: Record<string, { model?: string }>;
}

export interface RepeatBlock {
  repeat: {
    name: string;
    max_iterations: number;
    until: {
      artifact: string;
      field: string;
      equals: unknown;
    };
    stages: StageConfig[];
  };
}

export type GateStrategy = "all" | "majority" | "any";

export function isRepeatBlock(entry: StageEntry): entry is RepeatBlock {
  return "repeat" in entry;
}

// --- Role ---

export interface RoleConfig {
  persona: string;
  model?: string;
  skills: string[];
}

// --- Gate ---

export interface GateConfig {
  requires: Record<string, unknown>;
  evidence: {
    type: "artifact";
    path: string;
    check?: {
      field: string;
      equals?: unknown;
    };
  };
}

// --- Global config ---

export interface PetriConfig {
  providers: Record<string, ProviderConfig>;
  models: Record<string, ModelConfig>;
  defaults: {
    model: string;
    gate_strategy: GateStrategy;
    max_retries: number;
  };
}

export interface ProviderConfig {
  type: "pi" | "claude_code" | "codex";
}

export interface ModelConfig {
  provider: string;
  model: string;
}

// --- Runtime ---

export interface AttemptRecord {
  attempt: number;
  failureReason: string;
  failureHash: string;
}

export interface RunResult {
  status: "done" | "blocked";
  stage?: string;
  reason?: string;
}

export interface ArtifactEntry {
  stage: string;
  role: string;
  path: string;
  description?: string;
}

// --- Agent provider ---

export interface AgentConfig {
  persona: string;
  skills: string[];
  context: string;
  artifactDir: string;
  model: string;
}

export interface AgentResult {
  artifacts: string[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    costUsd?: number;
  };
}

export interface AgentProvider {
  createAgent(config: AgentConfig): PetriAgent;
}

export interface PetriAgent {
  run(): Promise<AgentResult>;
}

// --- Loaded role (resolved from disk) ---

export interface LoadedRole {
  name: string;
  persona: string;
  model: string;
  skills: string[];
  gate: GateConfig | null;
}
