// src/types.ts

// --- Pipeline ---

export interface PipelineConfig {
  name: string;
  description?: string;
  goal?: string;
  requirements?: string[];  // list of gate ids to verify at end
  stages: StageEntry[];
  input?: { description: string };
}

export type StageEntry = StageConfig | RepeatBlock;

export interface StageConfig {
  name: string;
  roles: string[];
  max_retries?: number;
  gate_strategy?: GateStrategy;
  timeout?: number;  // per-stage agent timeout in ms
  overrides?: Record<string, { model?: string }>;
}

export interface RepeatBlock {
  repeat: {
    name: string;
    max_iterations: number;
    until: string;  // gate id to check
    stages: StageEntry[];
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

export interface GateCheck {
  field: string;
  equals?: unknown;
  gte?: number;
  lte?: number;
  gt?: number;
  lt?: number;
  in?: unknown[];
}

export interface GateConfig {
  id: string;          // canonical gate id, e.g. "tests-pass"
  description?: string;
  evidence: {
    path: string;
    check?: GateCheck;
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
  timeout?: number;  // ms — passed from stage timeout, provider should respect this
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
