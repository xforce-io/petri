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

// --- Branch ---

export interface BranchConfig {
  schema_version: number;
  branch_id: string;
  status?: "active" | "paused" | "closed";
  objective?: string;
  baseline?: string;
  seeded_from?: BranchSeedSource;
  forked_from?: BranchForkSource;
  created_at?: string;
  notes?: string[];
}

export interface BranchSeedSource {
  type: "external_strategy";
  project: string;
  strategy_id: string;
  strategy_path?: string;
  reason?: string;
  seeded_at: string;
}

export interface BranchForkSource {
  type: "branch_run";
  branch_id: string;
  run_id: string;
  artifact?: string;
  reason?: string;
  forked_at: string;
}

export type StageEntry = StageConfig | RepeatBlock | CommandStage;

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

/**
 * A deterministic, non-agent stage. Runs a shell command once — no roles,
 * no retry/feedback (re-running yields the same result). It may declare an
 * optional gate to check its output.
 */
export interface CommandStage {
  name: string;
  command: string;       // shell command; "{artifact_dir}" is substituted at run time
  timeout?: number;      // max wall-clock ms (default: engine defaultTimeout)
  gate?: GateConfig;     // optional pass/fail check on the command's output artifacts
}

export type GateStrategy = "all" | "majority" | "any";

export function isRepeatBlock(entry: StageEntry): entry is RepeatBlock {
  return "repeat" in entry;
}

export function isCommandStage(entry: StageEntry): entry is CommandStage {
  return "command" in entry;
}

// --- Role ---

export interface RoleConfig {
  persona: string;
  model?: string;
  playbooks: string[];
}

// --- Gate ---

export interface GateCheckClause {
  field: string;
  equals?: unknown;
  gte?: number;
  lte?: number;
  gt?: number;
  lt?: number;
  in?: unknown[];
}

export type GateCheck = GateCheckClause | GateCheckClause[];

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
  type: "pi" | "claude_code" | "codex" | "milkie";
}

export interface ModelConfig {
  provider: string;
  model: string;
  adapter?: string;                    // milkie gateway adapter, e.g. "openai-compatible" | "anthropic"
  baseUrl?: string;                    // milkie endpoint; falls back to env when omitted
  options?: Record<string, unknown>;  // passthrough to milkie ModelConfig.options
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
  playbooks: string[];
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
  run(signal?: AbortSignal): Promise<AgentResult>;
}

// --- Loaded role (resolved from disk) ---

export interface LoadedRole {
  name: string;
  persona: string;
  model: string;
  playbooks: string[];
  gate: GateConfig | null;
}
