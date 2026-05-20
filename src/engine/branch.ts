import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { BranchConfig } from "../types.js";

const BRANCH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface CreateBranchOptions {
  objective?: string;
  baseline?: string;
  seedProject?: string;
  seedStrategyId?: string;
  seedStrategyPath?: string;
  seedReason?: string;
}

export interface ForkBranchOptions extends CreateBranchOptions {
  fromBranch: string;
  fromRun: string;
  artifact?: string;
  reason?: string;
}

export function normalizeBranchId(branchId: string): string {
  const id = branchId.trim();
  if (!BRANCH_ID_RE.test(id)) {
    throw new Error("Branch id must start with a letter or number and contain only letters, numbers, '.', '_' or '-'.");
  }
  return id;
}

export function branchesRoot(projectDir: string): string {
  return path.join(projectDir, ".petri", "branches");
}

export function branchDir(projectDir: string, branchId: string): string {
  return path.join(branchesRoot(projectDir), normalizeBranchId(branchId));
}

export function branchConfigPath(projectDir: string, branchId: string): string {
  return path.join(branchDir(projectDir, branchId), "branch.yaml");
}

export function createBranch(projectDir: string, branchId: string, opts: CreateBranchOptions = {}): BranchConfig {
  const id = normalizeBranchId(branchId);
  const dir = branchDir(projectDir, id);
  const configPath = path.join(dir, "branch.yaml");
  if (fs.existsSync(configPath)) {
    throw new Error(`Branch already exists: ${id}`);
  }

  const config: BranchConfig = {
    schema_version: 1,
    branch_id: id,
    status: "active",
    objective: opts.objective,
    baseline: opts.baseline,
    created_at: new Date().toISOString(),
  };
  if (opts.seedProject || opts.seedStrategyId || opts.seedStrategyPath || opts.seedReason) {
    if (!opts.seedProject || !opts.seedStrategyId) {
      throw new Error("External strategy seeds require both seedProject and seedStrategyId.");
    }
    config.seeded_from = {
      type: "external_strategy",
      project: opts.seedProject,
      strategy_id: opts.seedStrategyId,
      strategy_path: opts.seedStrategyPath,
      reason: opts.seedReason,
      seeded_at: new Date().toISOString(),
    };
  }

  fs.mkdirSync(path.join(dir, "runs"), { recursive: true });
  fs.mkdirSync(path.join(dir, "artifacts"), { recursive: true });
  fs.writeFileSync(configPath, stringifyYaml(config), "utf-8");
  return config;
}

export function normalizeRunId(runId: string): string {
  const id = runId.trim();
  if (/^\d+$/.test(id)) {
    return `run-${id.padStart(3, "0")}`;
  }
  if (/^run-\d+$/.test(id)) {
    const n = id.slice("run-".length);
    return `run-${n.padStart(3, "0")}`;
  }
  throw new Error("Run id must be numeric or use the run-NNN format.");
}

export function forkBranch(projectDir: string, branchId: string, opts: ForkBranchOptions): BranchConfig {
  const parentBranch = loadBranch(projectDir, opts.fromBranch);
  const parentRunId = normalizeRunId(opts.fromRun);
  const parentRunDir = path.join(branchDir(projectDir, parentBranch.branch_id), "runs", parentRunId);
  if (!fs.existsSync(parentRunDir)) {
    throw new Error(`Parent run not found: ${parentBranch.branch_id}/${parentRunId}`);
  }

  const config = createBranch(projectDir, branchId, {
    objective: opts.objective,
    baseline: opts.baseline,
  });
  config.forked_from = {
    type: "branch_run",
    branch_id: parentBranch.branch_id,
    run_id: parentRunId,
    artifact: opts.artifact,
    reason: opts.reason,
    forked_at: new Date().toISOString(),
  };

  fs.writeFileSync(branchConfigPath(projectDir, config.branch_id), stringifyYaml(config), "utf-8");
  return config;
}

export function loadBranch(projectDir: string, branchId: string): BranchConfig {
  const id = normalizeBranchId(branchId);
  const configPath = branchConfigPath(projectDir, id);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Branch not found: ${id}. Create it with 'petri branch init ${id}'.`);
  }
  const raw = parseYaml(fs.readFileSync(configPath, "utf-8")) as BranchConfig;
  if (!raw || raw.branch_id !== id) {
    throw new Error(`Invalid branch.yaml for branch ${id}`);
  }
  return raw;
}

export function listBranches(projectDir: string): BranchConfig[] {
  const root = branchesRoot(projectDir);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .sort()
    .map((name) => {
      const configPath = path.join(root, name, "branch.yaml");
      if (!fs.existsSync(configPath)) return null;
      try {
        return parseYaml(fs.readFileSync(configPath, "utf-8")) as BranchConfig;
      } catch {
        return null;
      }
    })
    .filter((branch): branch is BranchConfig => !!branch && typeof branch.branch_id === "string");
}

export function runRootForBranch(projectDir: string, branchId?: string): string {
  return branchId ? branchDir(projectDir, branchId) : path.join(projectDir, ".petri");
}
