# Petri MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a working multi-agent stage runner that can execute a code-dev pipeline (design → develop → review) using pi-agent-core.

**Architecture:** Thin engine reads YAML config (pipeline, roles, gates), pushes stages sequentially, delegates work to agents via the Pi provider (pi-agent-core + pi-ai), checks gate conditions against artifacts on disk, retries with attempt history on failure, detects stagnation.

**Tech Stack:** TypeScript, pi-agent-core, pi-ai, commander (CLI), yaml (config), vitest (tests), tsup (build)

---

## File Structure

```
petri/
  package.json
  tsconfig.json
  tsup.config.ts
  src/
    types.ts                        # Core type definitions
    config/
      loader.ts                     # Load and validate YAML configs
    engine/
      engine.ts                     # Main run loop
      gate.ts                       # Gate checking
      manifest.ts                   # Artifact manifest
      context.ts                    # Context builder for agents
    providers/
      interface.ts                  # AgentProvider / Agent interfaces
      pi.ts                         # Pi provider (pi-agent-core wrapper)
    cli/
      index.ts                      # CLI entry point (commander)
      init.ts                       # petri init (interactive onboard)
      run.ts                        # petri run
      status.ts                     # petri status
      validate.ts                   # petri validate
    skills/
      file_operations.md            # Built-in skill
      shell_tools.md                # Built-in skill
    templates/
      code-dev/                     # First template
        petri.yaml
        pipeline.yaml
        roles/
          designer/
            role.yaml
            soul.md
            gate.yaml
            skills/
              design.md
          developer/
            role.yaml
            soul.md
            gate.yaml
            skills/
              implement.md
          code_reviewer/
            role.yaml
            soul.md
            gate.yaml
            skills/
              review.md
  tests/
    config/
      loader.test.ts
    engine/
      engine.test.ts
      gate.test.ts
      manifest.test.ts
      context.test.ts
    providers/
      pi.test.ts
```

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsup.config.ts`
- Create: `src/types.ts`

- [ ] **Step 1: Initialize npm project**

```bash
cd /Users/xupeng/dev/github/petri
npm init -y
```

- [ ] **Step 2: Install dependencies**

```bash
npm install @mariozechner/pi-agent-core @mariozechner/pi-ai commander yaml chalk
npm install -D typescript vitest tsup @types/node
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "resolveJsonModule": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 4: Create tsup.config.ts**

```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  outDir: "dist",
  banner: { js: "#!/usr/bin/env node" },
});
```

- [ ] **Step 5: Update package.json with scripts and bin**

Add to `package.json`:
```json
{
  "type": "module",
  "bin": {
    "petri": "./dist/cli/index.js"
  },
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "dev": "tsx src/cli/index.ts"
  }
}
```

- [ ] **Step 6: Create core types**

```typescript
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
  persona: string;       // filename, e.g. "soul.md"
  model?: string;
  skills: string[];      // e.g. ["petri:file_operations", "implement.md"]
}

// --- Gate ---

export interface GateConfig {
  requires: Record<string, unknown>;
  evidence: {
    type: "artifact";
    path: string;         // e.g. "{stage}/{role}/result.json"
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
  persona: string;          // soul.md content
  model: string;            // resolved model name
  skills: string[];         // resolved skill contents
  gate: GateConfig | null;  // null if no gate.yaml
}
```

- [ ] **Step 7: Create .gitignore**

```
node_modules/
dist/
.petri/
*.tgz
```

- [ ] **Step 8: Initialize git and commit**

```bash
cd /Users/xupeng/dev/github/petri
git init
git add package.json tsconfig.json tsup.config.ts src/types.ts .gitignore
git commit -m "feat: project scaffolding with core types"
```

---

### Task 2: Config Loader

**Files:**
- Create: `src/config/loader.ts`
- Create: `tests/config/loader.test.ts`

- [ ] **Step 1: Write failing tests for config loading**

```typescript
// tests/config/loader.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadPetriConfig,
  loadPipelineConfig,
  loadRole,
  loadBuiltinSkill,
} from "../../src/config/loader.js";

describe("loadPetriConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "petri-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads petri.yaml with providers and models", () => {
    writeFileSync(
      join(dir, "petri.yaml"),
      `
providers:
  default:
    type: pi
models:
  sonnet:
    provider: default
    model: claude-sonnet-4-6
defaults:
  model: sonnet
  gate_strategy: all
  max_retries: 3
`
    );
    const config = loadPetriConfig(dir);
    expect(config.providers.default.type).toBe("pi");
    expect(config.models.sonnet.model).toBe("claude-sonnet-4-6");
    expect(config.defaults.model).toBe("sonnet");
  });

  it("throws if petri.yaml is missing", () => {
    expect(() => loadPetriConfig(dir)).toThrow("petri.yaml not found");
  });
});

describe("loadPipelineConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "petri-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads pipeline.yaml with stages", () => {
    writeFileSync(
      join(dir, "pipeline.yaml"),
      `
name: test-pipeline
stages:
  - name: design
    roles: [designer]
    max_retries: 3
  - name: develop
    roles: [developer]
`
    );
    const pipeline = loadPipelineConfig(dir);
    expect(pipeline.name).toBe("test-pipeline");
    expect(pipeline.stages).toHaveLength(2);
  });

  it("loads pipeline with repeat block", () => {
    writeFileSync(
      join(dir, "pipeline.yaml"),
      `
name: train-pipeline
stages:
  - name: prep
    roles: [engineer]
  - repeat:
      name: train_loop
      max_iterations: 5
      until:
        artifact: "eval/evaluator/metrics.json"
        field: done
        equals: true
      stages:
        - name: train
          roles: [trainer]
        - name: eval
          roles: [evaluator]
`
    );
    const pipeline = loadPipelineConfig(dir);
    expect(pipeline.stages).toHaveLength(2);
    const repeat = pipeline.stages[1];
    expect("repeat" in repeat).toBe(true);
  });

  it("loads a named pipeline file", () => {
    writeFileSync(
      join(dir, "custom.yaml"),
      `
name: custom
stages:
  - name: step1
    roles: [worker]
`
    );
    const pipeline = loadPipelineConfig(dir, "custom.yaml");
    expect(pipeline.name).toBe("custom");
  });
});

describe("loadRole", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "petri-test-"));
    const roleDir = join(dir, "roles", "developer");
    mkdirSync(roleDir, { recursive: true });
    mkdirSync(join(roleDir, "skills"));
    writeFileSync(
      join(roleDir, "role.yaml"),
      `
persona: soul.md
model: sonnet
skills:
  - implement.md
`
    );
    writeFileSync(join(roleDir, "soul.md"), "You are a developer.");
    writeFileSync(join(roleDir, "skills", "implement.md"), "Write code.");
    writeFileSync(
      join(roleDir, "gate.yaml"),
      `
requires:
  tests_pass: true
evidence:
  type: artifact
  path: "{stage}/{role}/result.json"
  check:
    field: passed
    equals: true
`
    );
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads role with persona, skills, and gate", () => {
    const role = loadRole(dir, "developer", "sonnet");
    expect(role.name).toBe("developer");
    expect(role.persona).toBe("You are a developer.");
    expect(role.skills).toEqual(["Write code."]);
    expect(role.model).toBe("sonnet");
    expect(role.gate).not.toBeNull();
    expect(role.gate!.evidence.check!.field).toBe("passed");
  });

  it("uses default model when role has none", () => {
    const roleDir = join(dir, "roles", "reviewer");
    mkdirSync(roleDir, { recursive: true });
    writeFileSync(
      join(roleDir, "role.yaml"),
      `
persona: soul.md
skills: []
`
    );
    writeFileSync(join(roleDir, "soul.md"), "You are a reviewer.");
    const role = loadRole(dir, "reviewer", "haiku");
    expect(role.model).toBe("haiku");
  });
});

describe("loadBuiltinSkill", () => {
  it("loads a built-in skill by petri: prefix", () => {
    const content = loadBuiltinSkill("petri:shell_tools");
    expect(content).toContain("shell");
  });

  it("throws on unknown built-in skill", () => {
    expect(() => loadBuiltinSkill("petri:nonexistent")).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/xupeng/dev/github/petri
npx vitest run tests/config/loader.test.ts
```

Expected: FAIL — modules not found

- [ ] **Step 3: Implement config loader**

```typescript
// src/config/loader.ts
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { parse as parseYaml } from "yaml";
import type {
  PetriConfig,
  PipelineConfig,
  RoleConfig,
  GateConfig,
  LoadedRole,
} from "../types.js";

export function loadPetriConfig(projectDir: string): PetriConfig {
  const path = join(projectDir, "petri.yaml");
  if (!existsSync(path)) {
    throw new Error(`petri.yaml not found in ${projectDir}`);
  }
  return parseYaml(readFileSync(path, "utf-8")) as PetriConfig;
}

export function loadPipelineConfig(
  projectDir: string,
  filename = "pipeline.yaml"
): PipelineConfig {
  const path = join(projectDir, filename);
  if (!existsSync(path)) {
    throw new Error(`${filename} not found in ${projectDir}`);
  }
  return parseYaml(readFileSync(path, "utf-8")) as PipelineConfig;
}

export function loadRole(
  projectDir: string,
  roleName: string,
  defaultModel: string
): LoadedRole {
  const roleDir = join(projectDir, "roles", roleName);
  const roleYaml = parseYaml(
    readFileSync(join(roleDir, "role.yaml"), "utf-8")
  ) as RoleConfig;

  const persona = readFileSync(
    join(roleDir, roleYaml.persona),
    "utf-8"
  );

  const skills = roleYaml.skills.map((s) => {
    if (s.startsWith("petri:")) {
      return loadBuiltinSkill(s);
    }
    return readFileSync(join(roleDir, "skills", s), "utf-8");
  });

  let gate: GateConfig | null = null;
  const gatePath = join(roleDir, "gate.yaml");
  if (existsSync(gatePath)) {
    gate = parseYaml(readFileSync(gatePath, "utf-8")) as GateConfig;
  }

  return {
    name: roleName,
    persona,
    model: roleYaml.model ?? defaultModel,
    skills,
    gate,
  };
}

export function loadBuiltinSkill(ref: string): string {
  const name = ref.replace("petri:", "");
  const skillsDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "skills"
  );
  const path = join(skillsDir, `${name}.md`);
  if (!existsSync(path)) {
    throw new Error(`Built-in skill not found: ${ref}`);
  }
  return readFileSync(path, "utf-8");
}
```

- [ ] **Step 4: Create built-in skills (minimal)**

```markdown
<!-- src/skills/file_operations.md -->
# File Operations

When you need to work with files:
1. Use file_read to read file contents
2. Use file_write to create or update files
3. Always use absolute paths or paths relative to your working directory
4. When creating new files, ensure parent directories exist (use shell_run: mkdir -p)
```

```markdown
<!-- src/skills/shell_tools.md -->
# Shell Tools

When you need to run commands:
1. Use shell_run to execute shell commands
2. Common tools available: git, node, npm, python, curl, jq
3. Always check command exit codes — non-zero means failure
4. For long-running commands, set an appropriate timeout
5. Capture both stdout and stderr for debugging
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run tests/config/loader.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/config/ src/skills/ tests/config/
git commit -m "feat: config loader for petri.yaml, pipeline.yaml, roles"
```

---

### Task 3: Artifact Manifest

**Files:**
- Create: `src/engine/manifest.ts`
- Create: `tests/engine/manifest.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/engine/manifest.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ArtifactManifest } from "../../src/engine/manifest.js";

describe("ArtifactManifest", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "petri-manifest-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts empty", () => {
    const m = new ArtifactManifest(dir);
    expect(m.entries()).toEqual([]);
  });

  it("collects artifacts from a stage", () => {
    const artifactDir = join(dir, "design", "designer");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, "doc.md"), "# Design");

    const m = new ArtifactManifest(dir);
    m.collect("design", "designer", [join(artifactDir, "doc.md")]);

    const entries = m.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0].stage).toBe("design");
    expect(entries[0].role).toBe("designer");
    expect(entries[0].path).toBe("design/designer/doc.md");
  });

  it("formats manifest for agent context", () => {
    const m = new ArtifactManifest(dir);
    m.collect("design", "designer", [join(dir, "design", "designer", "doc.md")]);
    m.collect("review", "reviewer", [join(dir, "review", "reviewer", "result.json")]);

    const text = m.formatForContext();
    expect(text).toContain("design/designer/doc.md");
    expect(text).toContain("review/reviewer/result.json");
  });

  it("saves and loads manifest.json", () => {
    const m = new ArtifactManifest(dir);
    m.collect("design", "designer", [join(dir, "design", "designer", "doc.md")]);
    m.save();

    const saved = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8"));
    expect(saved.artifacts).toHaveLength(1);

    const m2 = ArtifactManifest.load(dir);
    expect(m2.entries()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/engine/manifest.test.ts
```

- [ ] **Step 3: Implement manifest**

```typescript
// src/engine/manifest.ts
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, relative } from "path";
import type { ArtifactEntry } from "../types.js";

export class ArtifactManifest {
  private artifacts: ArtifactEntry[] = [];

  constructor(private baseDir: string) {}

  collect(stage: string, role: string, filePaths: string[]): void {
    for (const fullPath of filePaths) {
      const relPath = relative(this.baseDir, fullPath);
      if (!this.artifacts.some((a) => a.path === relPath)) {
        this.artifacts.push({ stage, role, path: relPath });
      }
    }
  }

  entries(): ArtifactEntry[] {
    return [...this.artifacts];
  }

  formatForContext(): string {
    if (this.artifacts.length === 0) return "";
    const lines = this.artifacts.map(
      (a) => `  - ${a.path}${a.description ? `: "${a.description}"` : ""}`
    );
    return `Available artifacts (use file_read to access):\n${lines.join("\n")}`;
  }

  save(): void {
    const path = join(this.baseDir, "manifest.json");
    writeFileSync(
      path,
      JSON.stringify({ artifacts: this.artifacts }, null, 2),
      "utf-8"
    );
  }

  static load(baseDir: string): ArtifactManifest {
    const m = new ArtifactManifest(baseDir);
    const path = join(baseDir, "manifest.json");
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, "utf-8"));
      m.artifacts = data.artifacts ?? [];
    }
    return m;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/engine/manifest.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/engine/manifest.ts tests/engine/manifest.test.ts
git commit -m "feat: artifact manifest with collect, format, save/load"
```

---

### Task 4: Gate Checker

**Files:**
- Create: `src/engine/gate.ts`
- Create: `tests/engine/gate.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/engine/gate.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { checkGates, resolveGatePath } from "../../src/engine/gate.js";
import type { GateConfig } from "../../src/types.js";

describe("resolveGatePath", () => {
  it("replaces {stage} and {role} placeholders", () => {
    const result = resolveGatePath("{stage}/{role}/result.json", "develop", "developer");
    expect(result).toBe("develop/developer/result.json");
  });
});

describe("checkGates", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "petri-gate-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes when artifact exists and field matches", () => {
    const artifactDir = join(dir, "develop", "developer");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "result.json"),
      JSON.stringify({ passed: true })
    );

    const gate: GateConfig = {
      requires: { tests_pass: true },
      evidence: {
        type: "artifact",
        path: "{stage}/{role}/result.json",
        check: { field: "passed", equals: true },
      },
    };

    const result = checkGates(
      [{ gate, roleName: "developer" }],
      "develop",
      dir,
      "all"
    );
    expect(result.passed).toBe(true);
  });

  it("fails when artifact is missing", () => {
    const gate: GateConfig = {
      requires: { tests_pass: true },
      evidence: {
        type: "artifact",
        path: "{stage}/{role}/result.json",
      },
    };

    const result = checkGates(
      [{ gate, roleName: "developer" }],
      "develop",
      dir,
      "all"
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("artifact missing");
  });

  it("fails when field does not match", () => {
    const artifactDir = join(dir, "develop", "developer");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "result.json"),
      JSON.stringify({ passed: false })
    );

    const gate: GateConfig = {
      requires: { tests_pass: true },
      evidence: {
        type: "artifact",
        path: "{stage}/{role}/result.json",
        check: { field: "passed", equals: true },
      },
    };

    const result = checkGates(
      [{ gate, roleName: "developer" }],
      "develop",
      dir,
      "all"
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("passed");
  });

  it("passes with majority strategy when 2/3 pass", () => {
    for (const name of ["r1", "r2", "r3"]) {
      const d = join(dir, "review", name);
      mkdirSync(d, { recursive: true });
      writeFileSync(
        join(d, "review.json"),
        JSON.stringify({ approved: name !== "r3" })
      );
    }

    const makeGate = (role: string): { gate: GateConfig; roleName: string } => ({
      roleName: role,
      gate: {
        requires: { approved: true },
        evidence: {
          type: "artifact",
          path: "{stage}/{role}/review.json",
          check: { field: "approved", equals: true },
        },
      },
    });

    const result = checkGates(
      [makeGate("r1"), makeGate("r2"), makeGate("r3")],
      "review",
      dir,
      "majority"
    );
    expect(result.passed).toBe(true);
  });

  it("passes when role has no gate", () => {
    const result = checkGates([], "develop", dir, "all");
    expect(result.passed).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/engine/gate.test.ts
```

- [ ] **Step 3: Implement gate checker**

```typescript
// src/engine/gate.ts
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { GateConfig, GateStrategy } from "../types.js";

export interface GateInput {
  gate: GateConfig;
  roleName: string;
}

export interface GateResult {
  passed: boolean;
  reason: string;
  details: { roleName: string; passed: boolean; reason: string }[];
}

export function resolveGatePath(
  template: string,
  stage: string,
  role: string
): string {
  return template.replace("{stage}", stage).replace("{role}", role);
}

export function checkGates(
  gates: GateInput[],
  stageName: string,
  artifactBaseDir: string,
  strategy: GateStrategy
): GateResult {
  if (gates.length === 0) {
    return { passed: true, reason: "", details: [] };
  }

  const details = gates.map(({ gate, roleName }) => {
    const relPath = resolveGatePath(gate.evidence.path, stageName, roleName);
    const fullPath = join(artifactBaseDir, relPath);

    if (!existsSync(fullPath)) {
      return { roleName, passed: false, reason: `artifact missing: ${relPath}` };
    }

    if (gate.evidence.check) {
      try {
        const content = JSON.parse(readFileSync(fullPath, "utf-8"));
        const value = content[gate.evidence.check.field];
        if (gate.evidence.check.equals !== undefined && value !== gate.evidence.check.equals) {
          return {
            roleName,
            passed: false,
            reason: `${gate.evidence.check.field} = ${JSON.stringify(value)}, expected ${JSON.stringify(gate.evidence.check.equals)}`,
          };
        }
      } catch (e) {
        return { roleName, passed: false, reason: `failed to parse ${relPath}: ${e}` };
      }
    }

    return { roleName, passed: true, reason: "" };
  });

  const passCount = details.filter((d) => d.passed).length;
  let passed: boolean;
  switch (strategy) {
    case "all":
      passed = details.every((d) => d.passed);
      break;
    case "majority":
      passed = passCount > details.length / 2;
      break;
    case "any":
      passed = details.some((d) => d.passed);
      break;
  }

  const failedDetails = details.filter((d) => !d.passed);
  const reason = failedDetails.map((d) => `${d.roleName}: ${d.reason}`).join("; ");

  return { passed, reason, details };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/engine/gate.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/engine/gate.ts tests/engine/gate.test.ts
git commit -m "feat: gate checker with all/majority/any strategies"
```

---

### Task 5: Context Builder

**Files:**
- Create: `src/engine/context.ts`
- Create: `tests/engine/context.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/engine/context.test.ts
import { describe, it, expect } from "vitest";
import { buildContext } from "../../src/engine/context.js";
import type { AttemptRecord } from "../../src/types.js";

describe("buildContext", () => {
  it("builds context with input and manifest", () => {
    const ctx = buildContext({
      input: "Build a todo app",
      artifactDir: "/tmp/artifacts/develop/developer",
      manifestText: "  - design/designer/doc.md",
      failureContext: "",
      attemptHistory: [],
    });
    expect(ctx).toContain("Build a todo app");
    expect(ctx).toContain("design/designer/doc.md");
    expect(ctx).toContain("/tmp/artifacts/develop/developer");
    expect(ctx).not.toContain("Previous attempts");
  });

  it("includes failure context on retry", () => {
    const ctx = buildContext({
      input: "Build a todo app",
      artifactDir: "/tmp/artifacts/develop/developer",
      manifestText: "",
      failureContext: "tests failed: assertion error",
      attemptHistory: [
        { attempt: 1, failureReason: "tests failed: assertion error", failureHash: "abc" },
      ],
    });
    expect(ctx).toContain("tests failed: assertion error");
    expect(ctx).toContain("Previous attempts");
    expect(ctx).toContain("Attempt 1: FAIL");
  });

  it("formats multiple attempts", () => {
    const attempts: AttemptRecord[] = [
      { attempt: 1, failureReason: "compile error", failureHash: "a" },
      { attempt: 2, failureReason: "test timeout", failureHash: "b" },
    ];
    const ctx = buildContext({
      input: "Fix bug",
      artifactDir: "/tmp/a",
      manifestText: "",
      failureContext: "test timeout",
      attemptHistory: attempts,
    });
    expect(ctx).toContain("Attempt 1: FAIL");
    expect(ctx).toContain("Attempt 2: FAIL");
    expect(ctx).toContain("DO NOT repeat failed approaches");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/engine/context.test.ts
```

- [ ] **Step 3: Implement context builder**

```typescript
// src/engine/context.ts
import type { AttemptRecord } from "../types.js";

export interface ContextInput {
  input: string;
  artifactDir: string;
  manifestText: string;
  failureContext: string;
  attemptHistory: AttemptRecord[];
}

export function buildContext(ctx: ContextInput): string {
  const parts: string[] = [];

  parts.push(`Your working directory: ${ctx.artifactDir}`);
  parts.push(`Write your output artifacts to this directory.`);

  if (ctx.manifestText) {
    parts.push(`\nAvailable artifacts (use file_read to access):\n${ctx.manifestText}`);
  }

  parts.push(`\nUser input: ${ctx.input}`);

  if (ctx.attemptHistory.length > 0) {
    parts.push(`\nPrevious attempts (DO NOT repeat failed approaches):`);
    for (const a of ctx.attemptHistory) {
      parts.push(`  Attempt ${a.attempt}: FAIL — "${a.failureReason}"`);
    }
  }

  if (ctx.failureContext) {
    parts.push(`\nLatest failure: ${ctx.failureContext}`);
    parts.push(`Address this issue with a different approach than previous attempts.`);
  }

  return parts.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/engine/context.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/engine/context.ts tests/engine/context.test.ts
git commit -m "feat: context builder with attempt history injection"
```

---

### Task 6: Pi Provider

**Files:**
- Create: `src/providers/interface.ts`
- Create: `src/providers/pi.ts`
- Create: `tests/providers/pi.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/providers/pi.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PiProvider } from "../../src/providers/pi.js";

// Mock pi-agent-core and pi-ai
vi.mock("@mariozechner/pi-agent-core", () => {
  const MockAgent = vi.fn().mockImplementation(() => ({
    setTools: vi.fn(),
    prompt: vi.fn().mockResolvedValue(undefined),
    waitForIdle: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockReturnValue(() => {}),
    state: {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Done" }],
          usage: { input: 100, output: 50, totalTokens: 150, cost: { total: 0.001 } },
        },
      ],
    },
  }));
  return { Agent: MockAgent };
});

vi.mock("@mariozechner/pi-ai", () => ({
  getModel: vi.fn().mockReturnValue({ id: "test-model", provider: "anthropic" }),
  Type: {
    Object: vi.fn().mockReturnValue({}),
    String: vi.fn().mockReturnValue({}),
    Optional: vi.fn().mockReturnValue({}),
    Number: vi.fn().mockReturnValue({}),
  },
}));

describe("PiProvider", () => {
  let provider: PiProvider;

  beforeEach(() => {
    provider = new PiProvider({
      sonnet: { piProvider: "anthropic", piModel: "claude-sonnet-4-6" },
    });
  });

  it("creates an agent and runs it", async () => {
    const agent = provider.createAgent({
      persona: "You are a developer",
      skills: ["Write tests", "Write code"],
      context: "Build a todo app",
      artifactDir: "/tmp/test",
      model: "sonnet",
    });

    const result = await agent.run();
    expect(result.usage).toBeDefined();
    expect(result.usage!.inputTokens).toBe(100);
    expect(result.usage!.outputTokens).toBe(50);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/providers/pi.test.ts
```

- [ ] **Step 3: Create provider interface (re-export from types)**

```typescript
// src/providers/interface.ts
export type { AgentProvider, PetriAgent, AgentConfig, AgentResult } from "../types.js";
```

- [ ] **Step 4: Implement Pi provider**

```typescript
// src/providers/pi.ts
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, Type } from "@mariozechner/pi-ai";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { execSync } from "child_process";
import { dirname } from "path";
import type { AgentProvider, PetriAgent, AgentConfig, AgentResult } from "../types.js";

export interface PiModelMapping {
  piProvider: string;
  piModel: string;
}

export class PiProvider implements AgentProvider {
  constructor(private modelMappings: Record<string, PiModelMapping>) {}

  createAgent(config: AgentConfig): PetriAgent {
    const mapping = this.modelMappings[config.model];
    if (!mapping) {
      throw new Error(`No Pi model mapping for: ${config.model}`);
    }

    return new PiAgent(config, mapping);
  }
}

class PiAgent implements PetriAgent {
  constructor(
    private config: AgentConfig,
    private mapping: PiModelMapping
  ) {}

  async run(): Promise<AgentResult> {
    const model = getModel(
      this.mapping.piProvider as any,
      this.mapping.piModel as any
    );

    const systemPrompt = [
      this.config.persona,
      "---",
      ...this.config.skills,
    ].join("\n\n");

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        thinkingLevel: "low",
      },
    });

    const tools = this.createTools();
    agent.setTools(tools);

    // Collect usage across turns
    let totalInput = 0;
    let totalOutput = 0;
    let totalCost = 0;

    agent.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        const usage = event.message.usage;
        if (usage) {
          totalInput += usage.input;
          totalOutput += usage.output;
          totalCost += usage.cost?.total ?? 0;
        }
      }
    });

    await agent.prompt(this.config.context);
    await agent.waitForIdle();

    // Scan artifact directory for produced files
    const artifacts = this.scanArtifacts();

    return {
      artifacts,
      usage: {
        inputTokens: totalInput,
        outputTokens: totalOutput,
        costUsd: totalCost,
      },
    };
  }

  private createTools() {
    const shellRun = {
      name: "shell_run",
      description: "Execute a shell command and return its output",
      label: "Run Shell Command",
      parameters: Type.Object({
        command: Type.String({ description: "The shell command to execute" }),
        timeout: Type.Optional(
          Type.Number({ description: "Timeout in milliseconds (default: 30000)" })
        ),
      }),
      execute: async (id: string, params: { command: string; timeout?: number }) => {
        try {
          const output = execSync(params.command, {
            timeout: params.timeout ?? 30000,
            cwd: this.config.artifactDir,
            encoding: "utf-8",
            maxBuffer: 1024 * 1024,
          });
          return {
            content: [{ type: "text" as const, text: output }],
            details: {},
          };
        } catch (e: any) {
          return {
            content: [{ type: "text" as const, text: `Error: ${e.message}\n${e.stderr ?? ""}` }],
            details: {},
          };
        }
      },
    };

    const fileRead = {
      name: "file_read",
      description: "Read the contents of a file",
      label: "Read File",
      parameters: Type.Object({
        path: Type.String({ description: "The file path to read" }),
      }),
      execute: async (id: string, params: { path: string }) => {
        try {
          const content = readFileSync(params.path, "utf-8");
          return {
            content: [{ type: "text" as const, text: content }],
            details: {},
          };
        } catch (e: any) {
          return {
            content: [{ type: "text" as const, text: `Error reading file: ${e.message}` }],
            details: {},
          };
        }
      },
    };

    const fileWrite = {
      name: "file_write",
      description: "Write content to a file, creating directories if needed",
      label: "Write File",
      parameters: Type.Object({
        path: Type.String({ description: "The file path to write" }),
        content: Type.String({ description: "The content to write" }),
      }),
      execute: async (id: string, params: { path: string; content: string }) => {
        try {
          const dir = dirname(params.path);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }
          writeFileSync(params.path, params.content, "utf-8");
          return {
            content: [{ type: "text" as const, text: `Written to ${params.path}` }],
            details: {},
          };
        } catch (e: any) {
          return {
            content: [{ type: "text" as const, text: `Error writing file: ${e.message}` }],
            details: {},
          };
        }
      },
    };

    return [shellRun, fileRead, fileWrite];
  }

  private scanArtifacts(): string[] {
    try {
      if (!existsSync(this.config.artifactDir)) return [];
      const output = execSync(
        `find "${this.config.artifactDir}" -type f -not -name ".*"`,
        { encoding: "utf-8" }
      );
      return output.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run tests/providers/pi.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/providers/ tests/providers/
git commit -m "feat: Pi agent provider wrapping pi-agent-core"
```

---

### Task 7: Engine

**Files:**
- Create: `src/engine/engine.ts`
- Create: `tests/engine/engine.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/engine/engine.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Engine } from "../../src/engine/engine.js";
import type { AgentProvider, PetriAgent, AgentConfig, AgentResult, PetriConfig, PipelineConfig, LoadedRole } from "../../src/types.js";

// Stub provider: agent writes a gate artifact on each run
function createStubProvider(
  artifactWriter: (config: AgentConfig) => void
): AgentProvider {
  return {
    createAgent(config: AgentConfig): PetriAgent {
      return {
        async run(): Promise<AgentResult> {
          artifactWriter(config);
          return { artifacts: [], usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 } };
        },
      };
    },
  };
}

describe("Engine", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "petri-engine-"));
    mkdirSync(join(dir, ".petri", "artifacts"), { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs a simple 2-stage pipeline to completion", async () => {
    const provider = createStubProvider((config) => {
      mkdirSync(config.artifactDir, { recursive: true });
      writeFileSync(
        join(config.artifactDir, "result.json"),
        JSON.stringify({ passed: true })
      );
    });

    const roles: Record<string, LoadedRole> = {
      designer: {
        name: "designer",
        persona: "You design.",
        model: "sonnet",
        skills: ["Design things."],
        gate: {
          requires: { done: true },
          evidence: { type: "artifact", path: "{stage}/{role}/result.json", check: { field: "passed", equals: true } },
        },
      },
      developer: {
        name: "developer",
        persona: "You develop.",
        model: "sonnet",
        skills: ["Write code."],
        gate: {
          requires: { done: true },
          evidence: { type: "artifact", path: "{stage}/{role}/result.json", check: { field: "passed", equals: true } },
        },
      },
    };

    const pipeline: PipelineConfig = {
      name: "test",
      stages: [
        { name: "design", roles: ["designer"], max_retries: 3 },
        { name: "develop", roles: ["developer"], max_retries: 3 },
      ],
    };

    const engine = new Engine({ provider, roles, artifactBaseDir: join(dir, ".petri", "artifacts") });
    const result = await engine.run(pipeline, "Build something");
    expect(result.status).toBe("done");
  });

  it("retries on gate failure then succeeds", async () => {
    let callCount = 0;
    const provider = createStubProvider((config) => {
      callCount++;
      mkdirSync(config.artifactDir, { recursive: true });
      writeFileSync(
        join(config.artifactDir, "result.json"),
        JSON.stringify({ passed: callCount >= 2 })
      );
    });

    const roles: Record<string, LoadedRole> = {
      worker: {
        name: "worker",
        persona: "You work.",
        model: "sonnet",
        skills: ["Do stuff."],
        gate: {
          requires: { done: true },
          evidence: { type: "artifact", path: "{stage}/{role}/result.json", check: { field: "passed", equals: true } },
        },
      },
    };

    const pipeline: PipelineConfig = {
      name: "test",
      stages: [{ name: "work", roles: ["worker"], max_retries: 3 }],
    };

    const engine = new Engine({ provider, roles, artifactBaseDir: join(dir, ".petri", "artifacts") });
    const result = await engine.run(pipeline, "Do it");
    expect(result.status).toBe("done");
    expect(callCount).toBe(2);
  });

  it("blocks after max_retries exhausted", async () => {
    const provider = createStubProvider((config) => {
      mkdirSync(config.artifactDir, { recursive: true });
      writeFileSync(
        join(config.artifactDir, "result.json"),
        JSON.stringify({ passed: false })
      );
    });

    const roles: Record<string, LoadedRole> = {
      worker: {
        name: "worker",
        persona: "You work.",
        model: "sonnet",
        skills: ["Do stuff."],
        gate: {
          requires: { done: true },
          evidence: { type: "artifact", path: "{stage}/{role}/result.json", check: { field: "passed", equals: true } },
        },
      },
    };

    const pipeline: PipelineConfig = {
      name: "test",
      stages: [{ name: "work", roles: ["worker"], max_retries: 2 }],
    };

    const engine = new Engine({ provider, roles, artifactBaseDir: join(dir, ".petri", "artifacts") });
    const result = await engine.run(pipeline, "Do it");
    expect(result.status).toBe("blocked");
    expect(result.stage).toBe("work");
  });

  it("detects stagnation and blocks early", async () => {
    let callCount = 0;
    const provider = createStubProvider((config) => {
      callCount++;
      mkdirSync(config.artifactDir, { recursive: true });
      // Always write the exact same failure
      writeFileSync(
        join(config.artifactDir, "result.json"),
        JSON.stringify({ passed: false, error: "same error every time" })
      );
    });

    const roles: Record<string, LoadedRole> = {
      worker: {
        name: "worker",
        persona: "You work.",
        model: "sonnet",
        skills: ["Do stuff."],
        gate: {
          requires: { done: true },
          evidence: { type: "artifact", path: "{stage}/{role}/result.json", check: { field: "passed", equals: true } },
        },
      },
    };

    const pipeline: PipelineConfig = {
      name: "test",
      stages: [{ name: "work", roles: ["worker"], max_retries: 5 }],
    };

    const engine = new Engine({ provider, roles, artifactBaseDir: join(dir, ".petri", "artifacts") });
    const result = await engine.run(pipeline, "Do it");
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("stagnant");
    // Should block after 2 attempts (consecutive same failure), not 5
    expect(callCount).toBe(2);
  });

  it("injects attempt history into agent context on retry", async () => {
    let lastContext = "";
    let callCount = 0;
    const provider = createStubProvider((config) => {
      callCount++;
      lastContext = config.context;
      mkdirSync(config.artifactDir, { recursive: true });
      writeFileSync(
        join(config.artifactDir, "result.json"),
        JSON.stringify({ passed: callCount >= 3 })
      );
    });

    const roles: Record<string, LoadedRole> = {
      worker: {
        name: "worker",
        persona: "You work.",
        model: "sonnet",
        skills: ["Do stuff."],
        gate: {
          requires: { done: true },
          evidence: { type: "artifact", path: "{stage}/{role}/result.json", check: { field: "passed", equals: true } },
        },
      },
    };

    const pipeline: PipelineConfig = {
      name: "test",
      stages: [{ name: "work", roles: ["worker"], max_retries: 5 }],
    };

    const engine = new Engine({ provider, roles, artifactBaseDir: join(dir, ".petri", "artifacts") });
    await engine.run(pipeline, "Do it");
    // On the third call (which succeeds), context should contain previous attempts
    expect(lastContext).toContain("Attempt 1: FAIL");
    expect(lastContext).toContain("Attempt 2: FAIL");
  });

  it("runs a repeat block", async () => {
    let iteration = 0;
    const provider = createStubProvider((config) => {
      if (config.artifactDir.includes("train")) {
        iteration++;
      }
      mkdirSync(config.artifactDir, { recursive: true });
      writeFileSync(
        join(config.artifactDir, "result.json"),
        JSON.stringify({ passed: true, target_met: iteration >= 2 })
      );
    });

    const roles: Record<string, LoadedRole> = {
      trainer: {
        name: "trainer",
        persona: "You train.",
        model: "sonnet",
        skills: ["Train."],
        gate: {
          requires: { done: true },
          evidence: { type: "artifact", path: "{stage}/{role}/result.json", check: { field: "passed", equals: true } },
        },
      },
      evaluator: {
        name: "evaluator",
        persona: "You evaluate.",
        model: "sonnet",
        skills: ["Evaluate."],
        gate: {
          requires: { done: true },
          evidence: { type: "artifact", path: "{stage}/{role}/result.json", check: { field: "passed", equals: true } },
        },
      },
    };

    const pipeline: PipelineConfig = {
      name: "test",
      stages: [
        {
          repeat: {
            name: "train_loop",
            max_iterations: 5,
            until: {
              artifact: "eval/evaluator/result.json",
              field: "target_met",
              equals: true,
            },
            stages: [
              { name: "train", roles: ["trainer"], max_retries: 2 },
              { name: "eval", roles: ["evaluator"], max_retries: 2 },
            ],
          },
        },
      ],
    };

    const engine = new Engine({ provider, roles, artifactBaseDir: join(dir, ".petri", "artifacts") });
    const result = await engine.run(pipeline, "Train model");
    expect(result.status).toBe("done");
    expect(iteration).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/engine/engine.test.ts
```

- [ ] **Step 3: Implement engine**

```typescript
// src/engine/engine.ts
import { createHash } from "crypto";
import { existsSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { ArtifactManifest } from "./manifest.js";
import { checkGates, type GateInput } from "./gate.js";
import { buildContext } from "./context.js";
import type {
  AgentProvider,
  PipelineConfig,
  StageConfig,
  RepeatBlock,
  LoadedRole,
  RunResult,
  AttemptRecord,
  GateStrategy,
} from "../types.js";
import { isRepeatBlock } from "../types.js";

export interface EngineOptions {
  provider: AgentProvider;
  roles: Record<string, LoadedRole>;
  artifactBaseDir: string;
  defaultGateStrategy?: GateStrategy;
  defaultMaxRetries?: number;
}

export class Engine {
  private provider: AgentProvider;
  private roles: Record<string, LoadedRole>;
  private artifactBaseDir: string;
  private defaultGateStrategy: GateStrategy;
  private defaultMaxRetries: number;

  constructor(opts: EngineOptions) {
    this.provider = opts.provider;
    this.roles = opts.roles;
    this.artifactBaseDir = opts.artifactBaseDir;
    this.defaultGateStrategy = opts.defaultGateStrategy ?? "all";
    this.defaultMaxRetries = opts.defaultMaxRetries ?? 3;
  }

  async run(pipeline: PipelineConfig, input: string): Promise<RunResult> {
    const manifest = new ArtifactManifest(this.artifactBaseDir);

    for (const entry of pipeline.stages) {
      if (isRepeatBlock(entry)) {
        const result = await this.executeRepeat(entry, input, manifest);
        if (result.status === "blocked") return result;
      } else {
        const result = await this.executeStage(entry, input, manifest);
        if (result.status === "blocked") return result;
      }
    }

    manifest.save();
    return { status: "done" };
  }

  private async executeStage(
    stage: StageConfig,
    input: string,
    manifest: ArtifactManifest
  ): Promise<RunResult> {
    const maxRetries = stage.max_retries ?? this.defaultMaxRetries;
    const gateStrategy = stage.gate_strategy ?? this.defaultGateStrategy;
    let attempt = 0;
    let stagePassed = false;
    let failureContext = "";
    const attempts: AttemptRecord[] = [];
    let lastFailureHash = "";

    while (!stagePassed && attempt < maxRetries) {
      attempt++;

      // Execute all roles in parallel
      const results = await Promise.all(
        stage.roles.map((roleName) =>
          this.executeRole(roleName, stage, input, manifest, failureContext, attempts)
        )
      );

      // Collect artifacts
      for (const { roleName, artifactPaths } of results) {
        manifest.collect(stage.name, roleName, artifactPaths);
      }

      // Check gates
      const gateInputs = this.collectGateInputs(stage.roles);
      const gateResult = checkGates(gateInputs, stage.name, this.artifactBaseDir, gateStrategy);

      if (gateResult.passed) {
        stagePassed = true;
      } else {
        failureContext = gateResult.reason;
        const currentHash = this.hash(gateResult.reason);

        attempts.push({
          attempt,
          failureReason: gateResult.reason,
          failureHash: currentHash,
        });

        // Stagnation detection
        if (currentHash === lastFailureHash) {
          return {
            status: "blocked",
            stage: stage.name,
            reason: `stagnant: same failure in attempts ${attempt - 1} and ${attempt}`,
          };
        }
        lastFailureHash = currentHash;
      }
    }

    if (!stagePassed) {
      return { status: "blocked", stage: stage.name, reason: `max retries (${maxRetries}) exhausted` };
    }

    return { status: "done" };
  }

  private async executeRepeat(
    block: RepeatBlock,
    input: string,
    manifest: ArtifactManifest
  ): Promise<RunResult> {
    const { repeat } = block;

    for (let iteration = 1; iteration <= repeat.max_iterations; iteration++) {
      // Run each stage in the repeat block sequentially
      for (const stage of repeat.stages) {
        const result = await this.executeStage(stage, input, manifest);
        if (result.status === "blocked") return result;
      }

      // Check the until condition
      const artifactPath = join(this.artifactBaseDir, repeat.until.artifact);
      if (existsSync(artifactPath)) {
        try {
          const content = JSON.parse(readFileSync(artifactPath, "utf-8"));
          if (content[repeat.until.field] === repeat.until.equals) {
            return { status: "done" };
          }
        } catch {
          // Parse error — continue iterating
        }
      }
    }

    return {
      status: "blocked",
      stage: repeat.name,
      reason: `repeat max_iterations (${repeat.max_iterations}) exhausted`,
    };
  }

  private async executeRole(
    roleName: string,
    stage: StageConfig,
    input: string,
    manifest: ArtifactManifest,
    failureContext: string,
    attemptHistory: AttemptRecord[]
  ): Promise<{ roleName: string; artifactPaths: string[] }> {
    const role = this.roles[roleName];
    if (!role) {
      throw new Error(`Role not found: ${roleName}`);
    }

    const model = stage.overrides?.[roleName]?.model ?? role.model;
    const artifactDir = join(this.artifactBaseDir, stage.name, roleName);
    mkdirSync(artifactDir, { recursive: true });

    const context = buildContext({
      input,
      artifactDir,
      manifestText: manifest.formatForContext(),
      failureContext,
      attemptHistory,
    });

    const agent = this.provider.createAgent({
      persona: role.persona,
      skills: role.skills,
      context,
      artifactDir,
      model,
    });

    const result = await agent.run();
    return { roleName, artifactPaths: result.artifacts };
  }

  private collectGateInputs(roleNames: string[]): GateInput[] {
    const inputs: GateInput[] = [];
    for (const name of roleNames) {
      const role = this.roles[name];
      if (role?.gate) {
        inputs.push({ gate: role.gate, roleName: name });
      }
    }
    return inputs;
  }

  private hash(value: string): string {
    return createHash("sha256").update(value.trim()).digest("hex").slice(0, 16);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/engine/engine.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/engine/engine.ts tests/engine/engine.test.ts
git commit -m "feat: engine with stage execution, retry, stagnation detection, repeat blocks"
```

---

### Task 8: CLI — petri run & petri validate

**Files:**
- Create: `src/cli/index.ts`
- Create: `src/cli/run.ts`
- Create: `src/cli/validate.ts`

- [ ] **Step 1: Create CLI entry point**

```typescript
// src/cli/index.ts
import { Command } from "commander";
import { runCommand } from "./run.js";
import { validateCommand } from "./validate.js";

const program = new Command();

program
  .name("petri")
  .description("Multi-agent stage runner")
  .version("0.1.0");

program
  .command("run")
  .description("Run a pipeline")
  .option("-p, --pipeline <file>", "Pipeline file", "pipeline.yaml")
  .option("-i, --input <text>", "Input text")
  .option("--from <file>", "Read input from file")
  .action(runCommand);

program
  .command("validate")
  .description("Validate project configuration")
  .action(validateCommand);

program.parse();
```

- [ ] **Step 2: Implement petri run**

```typescript
// src/cli/run.ts
import { resolve } from "path";
import { readFileSync, existsSync, mkdirSync } from "fs";
import chalk from "chalk";
import { loadPetriConfig, loadPipelineConfig, loadRole } from "../config/loader.js";
import { Engine } from "../engine/engine.js";
import { PiProvider, type PiModelMapping } from "../providers/pi.js";
import type { LoadedRole } from "../types.js";
import { isRepeatBlock } from "../types.js";

interface RunOptions {
  pipeline: string;
  input?: string;
  from?: string;
}

export async function runCommand(opts: RunOptions) {
  const projectDir = process.cwd();

  // Load config
  console.log(chalk.blue("Loading configuration..."));
  const petriConfig = loadPetriConfig(projectDir);
  const pipelineConfig = loadPipelineConfig(projectDir, opts.pipeline);

  // Resolve input
  let input: string;
  if (opts.input) {
    input = opts.input;
  } else if (opts.from) {
    input = readFileSync(resolve(projectDir, opts.from), "utf-8");
  } else {
    console.error(chalk.red("Error: provide --input or --from"));
    process.exit(1);
  }

  // Collect all role names from pipeline
  const roleNames = new Set<string>();
  for (const entry of pipelineConfig.stages) {
    if (isRepeatBlock(entry)) {
      for (const s of entry.repeat.stages) {
        s.roles.forEach((r) => roleNames.add(r));
      }
    } else {
      entry.roles.forEach((r) => roleNames.add(r));
    }
  }

  // Load roles
  const roles: Record<string, LoadedRole> = {};
  for (const name of roleNames) {
    roles[name] = loadRole(projectDir, name, petriConfig.defaults.model);
  }

  // Build model mappings for Pi provider
  const modelMappings: Record<string, PiModelMapping> = {};
  for (const [alias, mc] of Object.entries(petriConfig.models)) {
    // Map petri model alias → pi provider + model
    modelMappings[alias] = {
      piProvider: "anthropic", // simplified: derive from provider config
      piModel: mc.model,
    };
  }

  const provider = new PiProvider(modelMappings);
  const artifactBaseDir = resolve(projectDir, ".petri", "artifacts");
  mkdirSync(artifactBaseDir, { recursive: true });

  const engine = new Engine({
    provider,
    roles,
    artifactBaseDir,
    defaultGateStrategy: petriConfig.defaults.gate_strategy,
    defaultMaxRetries: petriConfig.defaults.max_retries,
  });

  // Run
  console.log(chalk.blue(`Running pipeline: ${pipelineConfig.name}`));
  console.log(chalk.gray(`Input: ${input.slice(0, 100)}${input.length > 100 ? "..." : ""}`));
  console.log();

  const result = await engine.run(pipelineConfig, input);

  if (result.status === "done") {
    console.log(chalk.green("\nPipeline completed successfully."));
  } else {
    console.log(chalk.red(`\nPipeline blocked at stage: ${result.stage}`));
    if (result.reason) {
      console.log(chalk.yellow(`Reason: ${result.reason}`));
    }
    process.exit(1);
  }
}
```

- [ ] **Step 3: Implement petri validate**

```typescript
// src/cli/validate.ts
import chalk from "chalk";
import { loadPetriConfig, loadPipelineConfig, loadRole } from "../config/loader.js";
import { isRepeatBlock } from "../types.js";

export function validateCommand() {
  const projectDir = process.cwd();
  let errors = 0;

  // Check petri.yaml
  try {
    const config = loadPetriConfig(projectDir);
    console.log(chalk.green("✓ petri.yaml"));

    if (!config.defaults?.model) {
      console.log(chalk.red("  ✗ defaults.model is required"));
      errors++;
    }
  } catch (e: any) {
    console.log(chalk.red(`✗ petri.yaml: ${e.message}`));
    errors++;
    return;
  }

  // Check pipeline.yaml
  let roleNames: string[] = [];
  try {
    const pipeline = loadPipelineConfig(projectDir);
    console.log(chalk.green(`✓ pipeline.yaml (${pipeline.name})`));

    const names = new Set<string>();
    for (const entry of pipeline.stages) {
      if (isRepeatBlock(entry)) {
        for (const s of entry.repeat.stages) {
          s.roles.forEach((r) => names.add(r));
        }
      } else {
        entry.roles.forEach((r) => names.add(r));
      }
    }
    roleNames = [...names];
    console.log(chalk.gray(`  Stages: ${pipeline.stages.length}, Roles: ${roleNames.length}`));
  } catch (e: any) {
    console.log(chalk.red(`✗ pipeline.yaml: ${e.message}`));
    errors++;
    return;
  }

  // Check roles
  const config = loadPetriConfig(projectDir);
  for (const name of roleNames) {
    try {
      const role = loadRole(projectDir, name, config.defaults.model);
      const gateLabel = role.gate ? "with gate" : "no gate";
      console.log(chalk.green(`✓ role: ${name} (${gateLabel}, ${role.skills.length} skills)`));
    } catch (e: any) {
      console.log(chalk.red(`✗ role ${name}: ${e.message}`));
      errors++;
    }
  }

  if (errors > 0) {
    console.log(chalk.red(`\n${errors} error(s) found.`));
    process.exit(1);
  } else {
    console.log(chalk.green("\nAll checks passed."));
  }
}
```

- [ ] **Step 4: Build and verify CLI works**

```bash
cd /Users/xupeng/dev/github/petri
npm run build
node dist/cli/index.js --help
node dist/cli/index.js validate --help
```

- [ ] **Step 5: Commit**

```bash
git add src/cli/
git commit -m "feat: CLI with petri run and petri validate commands"
```

---

### Task 9: code-dev Template

**Files:**
- Create: `src/templates/code-dev/petri.yaml`
- Create: `src/templates/code-dev/pipeline.yaml`
- Create: `src/templates/code-dev/roles/designer/role.yaml`
- Create: `src/templates/code-dev/roles/designer/soul.md`
- Create: `src/templates/code-dev/roles/designer/gate.yaml`
- Create: `src/templates/code-dev/roles/designer/skills/design.md`
- Create: `src/templates/code-dev/roles/developer/role.yaml`
- Create: `src/templates/code-dev/roles/developer/soul.md`
- Create: `src/templates/code-dev/roles/developer/gate.yaml`
- Create: `src/templates/code-dev/roles/developer/skills/implement.md`
- Create: `src/templates/code-dev/roles/code_reviewer/role.yaml`
- Create: `src/templates/code-dev/roles/code_reviewer/soul.md`
- Create: `src/templates/code-dev/roles/code_reviewer/gate.yaml`
- Create: `src/templates/code-dev/roles/code_reviewer/skills/review.md`

- [ ] **Step 1: Create pipeline and config**

```yaml
# src/templates/code-dev/petri.yaml
providers:
  default:
    type: pi

models:
  sonnet:
    provider: default
    model: claude-sonnet-4-6

defaults:
  model: sonnet
  gate_strategy: all
  max_retries: 3
```

```yaml
# src/templates/code-dev/pipeline.yaml
name: code-dev
description: Software development pipeline — design, develop, review

stages:
  - name: design
    roles: [designer]
    max_retries: 2

  - name: develop
    roles: [developer]
    max_retries: 5

  - name: review
    roles: [code_reviewer]
    max_retries: 2
```

- [ ] **Step 2: Create designer role**

```yaml
# src/templates/code-dev/roles/designer/role.yaml
persona: soul.md
skills:
  - design.md
```

```markdown
<!-- src/templates/code-dev/roles/designer/soul.md -->
You are a senior software architect. You create clear, practical design documents that developers can implement directly.

You focus on:
- Clear component boundaries and interfaces
- Data flow between components
- Key technical decisions and their rationale
- Test strategy

You avoid over-engineering. You design for what's needed now, not hypothetical future requirements.
```

```yaml
# src/templates/code-dev/roles/designer/gate.yaml
requires:
  design_completed: true
evidence:
  type: artifact
  path: "{stage}/{role}/design.json"
  check:
    field: completed
    equals: true
```

```markdown
<!-- src/templates/code-dev/roles/designer/skills/design.md -->
# Design Skill

Create a design document for the given requirements:

1. Read the user input carefully to understand what needs to be built
2. Write a design document covering:
   - Architecture overview
   - Key components and their responsibilities
   - Data structures
   - Test plan (what to test and how)
3. Write the design to your artifact directory as `design.md`
4. Write a gate artifact `design.json` with: {"completed": true, "summary": "one line summary"}
```

- [ ] **Step 3: Create developer role**

```yaml
# src/templates/code-dev/roles/developer/role.yaml
persona: soul.md
skills:
  - petri:file_operations
  - petri:shell_tools
  - implement.md
```

```markdown
<!-- src/templates/code-dev/roles/developer/soul.md -->
You are a pragmatic senior engineer. Your primary goal is working code that passes tests.

You follow existing code style and conventions. You value readability and correctness over cleverness. You write tests because untested code is untrustworthy.

You don't explain your reasoning — you write code and let it speak.
```

```yaml
# src/templates/code-dev/roles/developer/gate.yaml
requires:
  tests_pass: true
evidence:
  type: artifact
  path: "{stage}/{role}/result.json"
  check:
    field: tests_passed
    equals: true
```

```markdown
<!-- src/templates/code-dev/roles/developer/skills/implement.md -->
# Implementation Skill

Implement the code based on the design document:

1. Read the design artifact from the design stage (use file_read)
2. Create the project structure and source files
3. Write tests
4. Run tests using shell_run and make sure they pass
5. Write result artifact `result.json` with:
   {"tests_passed": true/false, "summary": "what was implemented", "files": ["list of files"]}

If previous attempts failed, read the attempt history and take a different approach.
When retrying after gate failure:
- State your hypothesis: "I believe the failure is caused by X"
- Make the minimum change that addresses the root cause
- Do not refactor unrelated code
```

- [ ] **Step 4: Create code_reviewer role**

```yaml
# src/templates/code-dev/roles/code_reviewer/role.yaml
persona: soul.md
skills:
  - petri:file_operations
  - review.md
```

```markdown
<!-- src/templates/code-dev/roles/code_reviewer/soul.md -->
You are a thorough code reviewer. You check for correctness, readability, and potential issues.

You categorize findings by severity:
- CRITICAL: bugs, security issues, data loss risks
- HIGH: logic errors, missing error handling
- MEDIUM: code style, naming, minor improvements
- LOW: suggestions, nice-to-haves

You approve code that has no CRITICAL or HIGH issues.
```

```yaml
# src/templates/code-dev/roles/code_reviewer/gate.yaml
requires:
  review_approved: true
evidence:
  type: artifact
  path: "{stage}/{role}/review.json"
  check:
    field: approved
    equals: true
```

```markdown
<!-- src/templates/code-dev/roles/code_reviewer/skills/review.md -->
# Code Review Skill

Review the code produced by the developer:

1. Read the developer's result artifact and implementation files
2. Check against the design document
3. Categorize findings by severity (CRITICAL, HIGH, MEDIUM, LOW)
4. Write review artifact `review.json` with:
   {"approved": true/false, "findings": [{"severity": "...", "description": "..."}], "summary": "..."}

Approve if there are no CRITICAL or HIGH findings.
```

- [ ] **Step 5: Commit**

```bash
git add src/templates/
git commit -m "feat: code-dev template with designer, developer, code_reviewer roles"
```

---

### Task 10: CLI — petri init

**Files:**
- Create: `src/cli/init.ts`
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Implement petri init**

```typescript
// src/cli/init.ts
import { existsSync, mkdirSync, cpSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import chalk from "chalk";

const TEMPLATES = ["code-dev", "research", "werewolf", "debate", "model-training"];

interface InitOptions {
  template?: string;
}

export function initCommand(opts: InitOptions) {
  const projectDir = process.cwd();

  if (existsSync(join(projectDir, "petri.yaml"))) {
    console.log(chalk.yellow("petri.yaml already exists in this directory."));
    process.exit(1);
  }

  const template = opts.template ?? "code-dev";
  const templatesDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "templates"
  );
  const templateDir = join(templatesDir, template);

  if (!existsSync(templateDir)) {
    console.log(chalk.red(`Template not found: ${template}`));
    console.log(chalk.gray(`Available: ${TEMPLATES.join(", ")}`));
    process.exit(1);
  }

  // Copy template to current directory
  cpSync(templateDir, projectDir, { recursive: true });

  console.log(chalk.green(`Initialized Petri project with "${template}" template.`));
  console.log();
  console.log(`  ${chalk.blue("petri validate")}  Check configuration`);
  console.log(`  ${chalk.blue("petri run --input \"...\"  ")}  Run your pipeline`);
}
```

- [ ] **Step 2: Register init command in CLI**

Add to `src/cli/index.ts` after the existing commands:

```typescript
import { initCommand } from "./init.js";

program
  .command("init")
  .description("Initialize a new Petri project")
  .option("-t, --template <name>", "Template to use", "code-dev")
  .action(initCommand);
```

- [ ] **Step 3: Build and test init manually**

```bash
cd /Users/xupeng/dev/github/petri
npm run build
mkdir /tmp/petri-test && cd /tmp/petri-test
node /Users/xupeng/dev/github/petri/dist/cli/index.js init --template code-dev
ls -la
cat petri.yaml
cat pipeline.yaml
ls roles/
cd /Users/xupeng/dev/github/petri
rm -rf /tmp/petri-test
```

- [ ] **Step 4: Commit**

```bash
git add src/cli/init.ts src/cli/index.ts
git commit -m "feat: petri init command with template scaffolding"
```

---

### Task 11: Integration Test

**Files:**
- Create: `tests/integration.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
// tests/integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, cpSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { loadPetriConfig, loadPipelineConfig, loadRole } from "../src/config/loader.js";
import { Engine } from "../src/engine/engine.js";
import type { AgentProvider, PetriAgent, AgentConfig, AgentResult, LoadedRole } from "../src/types.js";
import { isRepeatBlock } from "../src/types.js";

/**
 * Stub provider that simulates a real agent:
 * - designer: writes design.md + design.json
 * - developer: writes code files + result.json with tests_passed=true
 * - code_reviewer: reads developer output, writes review.json with approved=true
 */
function createCodeDevStubProvider(): AgentProvider {
  return {
    createAgent(config: AgentConfig): PetriAgent {
      return {
        async run(): Promise<AgentResult> {
          mkdirSync(config.artifactDir, { recursive: true });

          if (config.persona.includes("architect")) {
            // Designer
            writeFileSync(
              join(config.artifactDir, "design.md"),
              "# Design\n\nSimple todo app with CRUD operations."
            );
            writeFileSync(
              join(config.artifactDir, "design.json"),
              JSON.stringify({ completed: true, summary: "Todo app design" })
            );
          } else if (config.persona.includes("pragmatic")) {
            // Developer
            writeFileSync(
              join(config.artifactDir, "result.json"),
              JSON.stringify({ tests_passed: true, summary: "Implemented todo CRUD", files: ["todo.ts"] })
            );
          } else if (config.persona.includes("reviewer")) {
            // Code reviewer
            writeFileSync(
              join(config.artifactDir, "review.json"),
              JSON.stringify({ approved: true, findings: [], summary: "Code looks good" })
            );
          }

          return {
            artifacts: [],
            usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.001 },
          };
        },
      };
    },
  };
}

describe("Integration: code-dev pipeline", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "petri-integration-"));
    // Copy code-dev template
    const templateDir = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "src",
      "templates",
      "code-dev"
    );
    cpSync(templateDir, dir, { recursive: true });
    mkdirSync(join(dir, ".petri", "artifacts"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs the full code-dev pipeline end-to-end", async () => {
    const petriConfig = loadPetriConfig(dir);
    const pipelineConfig = loadPipelineConfig(dir);

    // Load all roles
    const roleNames = new Set<string>();
    for (const entry of pipelineConfig.stages) {
      if (!isRepeatBlock(entry)) {
        entry.roles.forEach((r) => roleNames.add(r));
      }
    }
    const roles: Record<string, LoadedRole> = {};
    for (const name of roleNames) {
      roles[name] = loadRole(dir, name, petriConfig.defaults.model);
    }

    // Verify roles loaded correctly
    expect(Object.keys(roles)).toEqual(
      expect.arrayContaining(["designer", "developer", "code_reviewer"])
    );
    expect(roles.designer.gate).not.toBeNull();
    expect(roles.developer.skills.length).toBeGreaterThan(0);

    // Run with stub provider
    const provider = createCodeDevStubProvider();
    const engine = new Engine({
      provider,
      roles,
      artifactBaseDir: join(dir, ".petri", "artifacts"),
      defaultGateStrategy: petriConfig.defaults.gate_strategy,
      defaultMaxRetries: petriConfig.defaults.max_retries,
    });

    const result = await engine.run(pipelineConfig, "Build a simple todo app");
    expect(result.status).toBe("done");

    // Verify artifacts were created
    const artifactBase = join(dir, ".petri", "artifacts");
    expect(existsSync(join(artifactBase, "design", "designer", "design.json"))).toBe(true);
    expect(existsSync(join(artifactBase, "develop", "developer", "result.json"))).toBe(true);
    expect(existsSync(join(artifactBase, "review", "code_reviewer", "review.json"))).toBe(true);

    // Verify manifest
    expect(existsSync(join(artifactBase, "manifest.json"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run integration test**

```bash
npx vitest run tests/integration.test.ts
```

Expected: PASS

- [ ] **Step 3: Run all tests**

```bash
npx vitest run
```

Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add tests/integration.test.ts
git commit -m "test: integration test for code-dev pipeline end-to-end"
```

---

### Task 12: Final Build & Smoke Test

- [ ] **Step 1: Build the project**

```bash
cd /Users/xupeng/dev/github/petri
npm run build
```

- [ ] **Step 2: Smoke test petri init**

```bash
mkdir /tmp/petri-smoke && cd /tmp/petri-smoke
node /Users/xupeng/dev/github/petri/dist/cli/index.js init
node /Users/xupeng/dev/github/petri/dist/cli/index.js validate
cd /Users/xupeng/dev/github/petri
rm -rf /tmp/petri-smoke
```

- [ ] **Step 3: Run full test suite**

```bash
npx vitest run
```

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore: final build verification"
```
