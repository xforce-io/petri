# CLI `petri create` Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose `generatePipeline` as a first-class CLI command (`petri create`) so the "description → pipeline" capability can be iterated and pressure-tested in the terminal, without the Web UI in the loop. Output includes a structured summary and deterministic lint warnings ("Concerns") so users can quickly judge whether the LLM understood their intent.

**Architecture:** Add `src/cli/create.ts` (thin command handler) plus two pure helpers in `src/engine/`: `summary.ts` (parses generated config to produce a `PipelineSummary`) and `lint.ts` (runs static checks, returns `Concern[]`). The command loads the project's provider via the existing `createProviderFromConfig`, calls `generatePipeline`, then prints status → summary → concerns → next-step hints. Generated files land in `.petri/generated/` exactly like the Web flow; promotion is intentionally **not** included.

**Tech Stack:** TypeScript, Node.js, commander.js (CLI), vitest (tests), chalk (console styling), yaml (existing dep, used by summary/lint to parse pipeline.yaml + role configs).

---

## Conceptual Layering

Terminology aligned with mainstream agent-harness practice (OpenAI Agents SDK, Anthropic Claude Code, LLM Readiness Harness):

```
                  generation time              runtime
                  ─────────────────────       ─────────────────
    hard check    │ validation (schema) │ →  │ evaluation gate │  ← gate.yaml
    soft check    │ lint / concerns     │ →  │ guardrail       │  ← future
```

- `validateProject` (existing) — generation-time **hard** schema validation
- `gate.yaml` (existing) — runtime **evaluation gate** with artifact-evidence checks
- `lintPipeline` (this plan) — generation-time **soft** static analysis
- Runtime guardrails (input/output/tool tripwires per OpenAI conventions) — **out of scope here**, the word "guardrail" is reserved for that future layer and must NOT appear in code, comments, or user-facing output for this lint feature. The user-facing label is **"Concerns"**.

---

### Task 1: Add `petri create <description>` core command

**Files:**
- Create: `src/cli/create.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/cli/create.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/cli/create.test.ts` with the full content below. The test creates a temp project with a minimal `petri.yaml`, runs the create logic with a stub provider that writes a fixed JSON pipeline as the LLM result, and asserts the printed output and on-disk state.

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type {
  AgentConfig,
  AgentProvider,
  AgentResult,
  PetriAgent,
} from "../../src/types.js";

function makeTmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "petri-create-test-"));
  // Minimal valid petri.yaml so generatePipeline's validation step has config to load
  fs.writeFileSync(
    path.join(dir, "petri.yaml"),
    [
      "providers:",
      "  pi:",
      "    type: pi",
      "models:",
      "  default:",
      "    model: claude-sonnet-4-5",
      "defaults:",
      "  model: default",
      "  gate_strategy: strict",
      "  max_retries: 1",
      "",
    ].join("\n"),
    "utf-8",
  );
  return dir;
}

function makeStubProvider(jsonOutput: string): AgentProvider {
  return {
    createAgent(config: AgentConfig): PetriAgent {
      return {
        async run(): Promise<AgentResult> {
          // generator.ts reads _result.md from config.artifactDir
          fs.writeFileSync(
            path.join(config.artifactDir, "_result.md"),
            jsonOutput,
            "utf-8",
          );
          return {
            artifacts: [],
            usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
          };
        },
      };
    },
  };
}

// A pipeline JSON the stub provider returns — passes structural validation
const VALID_PIPELINE_JSON = JSON.stringify({
  "pipeline.yaml": [
    "name: test-pipeline",
    "description: A test pipeline",
    "stages:",
    "  - name: work",
    "    roles: [worker]",
    "    requires: [work-done]",
    "",
  ].join("\n"),
  "roles/worker/role.yaml": [
    "persona: soul.md",
    "skills: []",
    "",
  ].join("\n"),
  "roles/worker/soul.md": "You are a worker.\n",
  "roles/worker/gate.yaml": [
    "id: work-done",
    "evidence:",
    "  type: artifact",
    "  path: '{stage}/{role}/done.json'",
    "  check:",
    "    field: completed",
    "    equals: true",
    "",
  ].join("\n"),
});

describe("petri create", () => {
  let tmpDir: string;
  let originalCwd: string;
  let lines: string[];
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = makeTmpProject();
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    lines = [];
    consoleSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      lines.push(args.join(" "));
    });
    consoleErrSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
      lines.push(args.join(" "));
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates a pipeline from a positional description and writes to .petri/generated/", async () => {
    const { runCreate } = await import("../../src/cli/create.js");
    const provider = makeStubProvider(VALID_PIPELINE_JSON);

    await runCreate(
      { description: "Build a worker pipeline" },
      provider,
      tmpDir,
    );

    const output = lines.join("\n");
    expect(output).toContain("ok");
    expect(output).toContain("pipeline.yaml");
    expect(output).toContain("roles/worker/role.yaml");
    expect(output).toContain(".petri/generated");

    // Files actually on disk
    expect(fs.existsSync(path.join(tmpDir, ".petri/generated/pipeline.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".petri/generated/roles/worker/role.yaml"))).toBe(true);
  });

  it("errors out when no description is provided", async () => {
    const { runCreate } = await import("../../src/cli/create.js");
    const provider = makeStubProvider(VALID_PIPELINE_JSON);

    await expect(
      runCreate({ description: undefined }, provider, tmpDir),
    ).rejects.toThrow(/description/i);
  });

  it("reports validation errors when generator fails validation", async () => {
    // Pipeline JSON missing the required role file → validation fails
    const BROKEN_JSON = JSON.stringify({
      "pipeline.yaml": [
        "name: broken",
        "stages:",
        "  - name: work",
        "    roles: [missing]",
        "    requires: [missing-gate]",
        "",
      ].join("\n"),
    });
    const { runCreate } = await import("../../src/cli/create.js");
    const provider = makeStubProvider(BROKEN_JSON);

    await runCreate(
      { description: "Build something broken" },
      provider,
      tmpDir,
    );

    const output = lines.join("\n");
    expect(output).toContain("validation_failed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/create.test.ts`
Expected: FAIL — `Cannot find module '../../src/cli/create.js'`

- [ ] **Step 3: Create `src/cli/create.ts`**

Write the file with this exact content:

```typescript
import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import { generatePipeline } from "../engine/generator.js";
import { loadPetriConfig } from "../config/loader.js";
import { createProviderFromConfig } from "../util/provider.js";
import type { AgentProvider } from "../types.js";

export interface CreateOptions {
  description?: string;
}

/**
 * Testable core: generate a pipeline using the given provider, print summary.
 * `cwd` is the project directory containing petri.yaml.
 */
export async function runCreate(
  opts: CreateOptions,
  provider: AgentProvider,
  cwd: string,
): Promise<void> {
  const description = opts.description?.trim();
  if (!description) {
    throw new Error("Missing description. Pass it as a positional argument.");
  }

  const petriYamlPath = path.join(cwd, "petri.yaml");
  if (!fs.existsSync(petriYamlPath)) {
    throw new Error(
      `petri.yaml not found in ${cwd}. Run 'petri init' first.`,
    );
  }

  const petriConfig = loadPetriConfig(cwd);

  console.log(chalk.blue("Generating pipeline..."));

  const result = await generatePipeline(
    {
      description,
      projectDir: cwd,
      model: petriConfig.defaults.model,
    },
    provider,
  );

  const generatedDir = path.join(cwd, ".petri", "generated");

  console.log();
  if (result.status === "ok") {
    console.log(chalk.green(`✔ status: ok`) + chalk.gray(`  (retries: ${result.retries})`));
  } else {
    console.log(chalk.yellow(`⚠ status: validation_failed`) + chalk.gray(`  (retries: ${result.retries})`));
  }

  if (result.errors && result.errors.length > 0) {
    console.log();
    console.log(chalk.yellow("Errors:"));
    for (const err of result.errors) {
      console.log(chalk.yellow(`  - ${err}`));
    }
  }

  if (result.files.length > 0) {
    console.log();
    console.log(chalk.bold(`Files (${result.files.length}):`));
    for (const f of result.files) {
      console.log(`  ${f}`);
    }
  }

  console.log();
  console.log(chalk.gray(`Output: ${path.relative(cwd, generatedDir) || generatedDir}`));
}

/**
 * CLI entry point: wires up provider from project config, then runs.
 */
export async function createCommand(
  description: string | undefined,
  _opts: Record<string, unknown>,
): Promise<void> {
  const cwd = process.cwd();
  try {
    const provider: AgentProvider = createProviderFromConfig(cwd);
    await runCreate({ description }, provider, cwd);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Error: ${msg}`));
    process.exit(1);
  }
}
```

- [ ] **Step 4: Register the command in `src/cli/index.ts`**

Add the import near the other CLI imports (after the `webCommand` import on line 8):

```typescript
import { createCommand } from "./create.js";
```

Add the command registration before `program.parse()` on line 64:

```typescript
program
  .command("create")
  .description("Generate a pipeline from a natural-language description")
  .argument("[description]", "What you want to build")
  .action(createCommand);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/cli/create.test.ts`
Expected: all 3 tests PASS.

- [ ] **Step 6: Run the full test suite to confirm nothing else broke**

Run: `npx vitest run`
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli/create.ts src/cli/index.ts tests/cli/create.test.ts
git commit -m "feat: add petri create CLI command"
```

---

### Task 2: Add `--from <file>` flag for reading description from a file

**Files:**
- Modify: `src/cli/create.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/cli/create.test.ts`

- [ ] **Step 1: Write the failing test**

Append this test inside the existing `describe("petri create", ...)` block in `tests/cli/create.test.ts`:

```typescript
  it("reads description from a file when --from is passed", async () => {
    const descPath = path.join(tmpDir, "my-desc.md");
    fs.writeFileSync(descPath, "Build a worker pipeline\nwith two stages\n", "utf-8");

    const { runCreate } = await import("../../src/cli/create.js");
    const provider = makeStubProvider(VALID_PIPELINE_JSON);

    await runCreate({ from: descPath }, provider, tmpDir);

    const output = lines.join("\n");
    expect(output).toContain("ok");
    expect(fs.existsSync(path.join(tmpDir, ".petri/generated/pipeline.yaml"))).toBe(true);
  });

  it("errors when --from points at a non-existent file", async () => {
    const { runCreate } = await import("../../src/cli/create.js");
    const provider = makeStubProvider(VALID_PIPELINE_JSON);

    await expect(
      runCreate({ from: path.join(tmpDir, "nope.md") }, provider, tmpDir),
    ).rejects.toThrow(/not found/i);
  });

  it("errors when both description and --from are provided", async () => {
    const descPath = path.join(tmpDir, "my-desc.md");
    fs.writeFileSync(descPath, "From file", "utf-8");

    const { runCreate } = await import("../../src/cli/create.js");
    const provider = makeStubProvider(VALID_PIPELINE_JSON);

    await expect(
      runCreate(
        { description: "Inline", from: descPath },
        provider,
        tmpDir,
      ),
    ).rejects.toThrow(/cannot use both/i);
  });
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npx vitest run tests/cli/create.test.ts`
Expected: the three new tests FAIL — `runCreate` does not yet accept `from`.

- [ ] **Step 3: Update `CreateOptions` and `runCreate` in `src/cli/create.ts`**

Replace the `CreateOptions` interface and the top of `runCreate` with this:

```typescript
export interface CreateOptions {
  description?: string;
  from?: string;
}

export async function runCreate(
  opts: CreateOptions,
  provider: AgentProvider,
  cwd: string,
): Promise<void> {
  if (opts.description && opts.from) {
    throw new Error("Cannot use both a positional description and --from. Pick one.");
  }

  let description: string | undefined;
  if (opts.from) {
    const fromPath = path.isAbsolute(opts.from) ? opts.from : path.resolve(cwd, opts.from);
    if (!fs.existsSync(fromPath)) {
      throw new Error(`Description file not found: ${fromPath}`);
    }
    description = fs.readFileSync(fromPath, "utf-8").trim();
  } else {
    description = opts.description?.trim();
  }

  if (!description) {
    throw new Error("Missing description. Pass it as a positional argument or with --from <file>.");
  }
```

Leave the rest of `runCreate` (everything from `const petriYamlPath = ...` onward) unchanged.

- [ ] **Step 4: Update `createCommand` to forward the flag**

Replace `createCommand` in `src/cli/create.ts` with:

```typescript
export async function createCommand(
  description: string | undefined,
  opts: { from?: string },
): Promise<void> {
  const cwd = process.cwd();
  try {
    const provider: AgentProvider = createProviderFromConfig(cwd);
    await runCreate({ description, from: opts.from }, provider, cwd);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Error: ${msg}`));
    process.exit(1);
  }
}
```

- [ ] **Step 5: Register the flag in `src/cli/index.ts`**

Replace the `program.command("create")` block (added in Task 1) with:

```typescript
program
  .command("create")
  .description("Generate a pipeline from a natural-language description")
  .argument("[description]", "What you want to build")
  .option("--from <file>", "Read description from a file instead of the argument")
  .action(createCommand);
```

- [ ] **Step 6: Run the test suite to verify it passes**

Run: `npx vitest run tests/cli/create.test.ts`
Expected: all tests PASS (including the three new ones).

Then run: `npx vitest run`
Expected: full suite PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli/create.ts src/cli/index.ts tests/cli/create.test.ts
git commit -m "feat: support petri create --from <file>"
```

---

### Task 3: Add structured pipeline summary

**Files:**
- Create: `src/engine/summary.ts`
- Create: `tests/engine/summary.test.ts`
- Modify: `src/cli/create.ts`
- Modify: `tests/cli/create.test.ts`

After this task, successful generation prints a structured summary (name / goal / stage flow / per-role persona snippet) instead of just a flat file list. The file list block is replaced by the summary; the bottom `Inspect:` hints tell users where to look at full files.

- [ ] **Step 1: Write failing tests for `buildPipelineSummary`**

Create `tests/engine/summary.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { buildPipelineSummary } from "../../src/engine/summary.js";

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf-8");
  }
}

describe("buildPipelineSummary", () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "petri-summary-")); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it("returns name, goal, stages, and roles with persona snippets", () => {
    writeTree(tmp, {
      "pipeline.yaml":
        "name: code-review\n" +
        "goal: Review code for quality\n" +
        "stages:\n" +
        "  - name: design\n" +
        "    roles: [designer]\n" +
        "  - name: develop\n" +
        "    roles: [developer]\n",
      "roles/designer/role.yaml": "persona: soul.md\nskills: [design]\n",
      "roles/designer/soul.md": "You are a software architect who designs systems.\nMore detail.\n",
      "roles/developer/role.yaml": "persona: soul.md\nskills: []\n",
      "roles/developer/soul.md": "You are a senior engineer.\n",
    });

    const summary = buildPipelineSummary(tmp);
    expect(summary).not.toBeNull();
    expect(summary!.name).toBe("code-review");
    expect(summary!.goal).toBe("Review code for quality");
    expect(summary!.stages).toEqual([
      { name: "design", roles: ["designer"] },
      { name: "develop", roles: ["developer"] },
    ]);
    expect(summary!.roles).toHaveLength(2);
    const designer = summary!.roles.find((r) => r.name === "designer")!;
    expect(designer.personaFirstLine).toContain("software architect");
    expect(designer.skills).toEqual(["design"]);
  });

  it("returns null when pipeline.yaml is missing", () => {
    expect(buildPipelineSummary(tmp)).toBeNull();
  });

  it("returns null when pipeline.yaml is malformed", () => {
    writeTree(tmp, { "pipeline.yaml": "name: [unterminated\n" });
    expect(buildPipelineSummary(tmp)).toBeNull();
  });

  it("truncates long persona lines to 80 chars with ellipsis", () => {
    const longLine = "X".repeat(200);
    writeTree(tmp, {
      "pipeline.yaml":
        "name: t\nstages:\n  - name: s\n    roles: [r]\n",
      "roles/r/role.yaml": "persona: soul.md\nskills: []\n",
      "roles/r/soul.md": longLine + "\n",
    });
    const summary = buildPipelineSummary(tmp)!;
    expect(summary.roles[0].personaFirstLine.length).toBeLessThanOrEqual(83);
    expect(summary.roles[0].personaFirstLine.endsWith("...")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/engine/summary.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/engine/summary.ts`**

```typescript
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

export interface PipelineSummaryRole {
  name: string;
  personaFirstLine: string;
  skills: string[];
}

export interface PipelineSummaryStage {
  name: string;
  roles: string[];
}

export interface PipelineSummary {
  name: string;
  goal?: string;
  description?: string;
  stages: PipelineSummaryStage[];
  roles: PipelineSummaryRole[];
}

const PERSONA_MAX = 80;

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "...";
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.length > 0) return t;
  }
  return "";
}

export function buildPipelineSummary(generatedDir: string): PipelineSummary | null {
  const pipelinePath = path.join(generatedDir, "pipeline.yaml");
  if (!fs.existsSync(pipelinePath)) return null;

  let pipeline: any;
  try {
    pipeline = parseYaml(fs.readFileSync(pipelinePath, "utf-8"));
  } catch {
    return null;
  }
  if (!pipeline || typeof pipeline !== "object") return null;

  const stages: PipelineSummaryStage[] = [];
  const roleNames = new Set<string>();
  for (const stage of pipeline.stages ?? []) {
    if (!stage || typeof stage !== "object" || !stage.name) continue;
    const roles = Array.isArray(stage.roles) ? stage.roles.filter((r: unknown) => typeof r === "string") : [];
    stages.push({ name: stage.name, roles });
    for (const r of roles) roleNames.add(r);
  }

  const roles: PipelineSummaryRole[] = [];
  for (const name of roleNames) {
    const roleDir = path.join(generatedDir, "roles", name);
    let skills: string[] = [];
    let personaPath = path.join(roleDir, "soul.md");
    try {
      const roleYaml = parseYaml(fs.readFileSync(path.join(roleDir, "role.yaml"), "utf-8")) as any;
      if (Array.isArray(roleYaml?.skills)) {
        skills = roleYaml.skills.filter((s: unknown) => typeof s === "string");
      }
      if (typeof roleYaml?.persona === "string") {
        personaPath = path.join(roleDir, roleYaml.persona);
      }
    } catch { /* role.yaml missing or malformed: leave defaults */ }

    let personaFirstLine = "";
    try {
      personaFirstLine = truncate(firstNonEmptyLine(fs.readFileSync(personaPath, "utf-8")), PERSONA_MAX);
    } catch { /* soul.md missing */ }

    roles.push({ name, personaFirstLine, skills });
  }

  return {
    name: typeof pipeline.name === "string" ? pipeline.name : "(unnamed)",
    goal: typeof pipeline.goal === "string" ? pipeline.goal : undefined,
    description: typeof pipeline.description === "string" ? pipeline.description : undefined,
    stages,
    roles,
  };
}
```

- [ ] **Step 4: Run summary tests to verify they pass**

Run: `npx vitest run tests/engine/summary.test.ts`
Expected: all 4 tests PASS.

- [ ] **Step 5: Wire summary into `runCreate` and update its tests**

Replace the printing tail of `runCreate` in `src/cli/create.ts`. Specifically, replace this block:

```typescript
  if (result.files.length > 0) {
    console.log();
    console.log(chalk.bold(`Files (${result.files.length}):`));
    for (const f of result.files) {
      console.log(`  ${f}`);
    }
  }

  console.log();
  console.log(chalk.gray(`Output: ${path.relative(cwd, generatedDir) || generatedDir}`));
}
```

With:

```typescript
  // Summary block — only if pipeline.yaml exists and parses
  const summary = buildPipelineSummary(generatedDir);
  if (summary) {
    console.log();
    console.log(`${chalk.bold("Pipeline:")} ${summary.name}`);
    if (summary.goal) console.log(`${chalk.bold("Goal:    ")} ${summary.goal}`);
    if (!summary.goal && summary.description) {
      console.log(`${chalk.bold("Desc:    ")} ${summary.description}`);
    }

    if (summary.stages.length > 0) {
      console.log();
      console.log(chalk.bold("Flow:"));
      const circles = ["①","②","③","④","⑤","⑥","⑦","⑧","⑨"];
      summary.stages.forEach((s, i) => {
        const tag = circles[i] ?? `(${i + 1})`;
        const roles = s.roles.join(", ");
        console.log(`  ${tag} ${s.name.padEnd(10)} →  ${roles}`);
      });
    }

    if (summary.roles.length > 0) {
      console.log();
      console.log(chalk.bold("Roles:"));
      const nameWidth = Math.max(...summary.roles.map((r) => r.name.length));
      for (const r of summary.roles) {
        const persona = r.personaFirstLine || chalk.gray("(no soul.md)");
        console.log(`  ${r.name.padEnd(nameWidth)} — ${persona}`);
      }
    }
  }

  console.log();
  const relGen = path.relative(cwd, generatedDir) || generatedDir;
  console.log(chalk.gray(`→ Inspect:  cat ${relGen}/pipeline.yaml`));
  console.log(chalk.gray(`→ Inspect:  cat ${relGen}/roles/<name>/soul.md`));
  console.log(chalk.gray(`Output: ${relGen}`));
}
```

Add the import at the top of `src/cli/create.ts` (next to the other engine imports):

```typescript
import { buildPipelineSummary } from "../engine/summary.js";
```

Now update `tests/cli/create.test.ts`. Find the first test (`"generates a pipeline from a positional description..."`) and replace its console-output assertions:

```typescript
    expect(output).toContain("ok");
    expect(output).toContain("pipeline.yaml");
    expect(output).toContain("roles/worker/role.yaml");
    expect(output).toContain(".petri/generated");
```

With:

```typescript
    expect(output).toContain("ok");
    expect(output).toContain("Pipeline: test-pipeline");
    expect(output).toContain("Flow:");
    expect(output).toContain("worker");
    expect(output).toContain("You are a worker.");
    expect(output).toContain(".petri/generated");
```

Also update the validation_failed test (`"reports validation errors when generator fails validation"`) — it should still find `validation_failed` in the output; no further change required since pipeline.yaml will be present from the broken generation and summary will render with whatever it can parse.

- [ ] **Step 6: Run all tests to verify they pass**

Run: `npx vitest run`
Expected: full suite PASS, including updated CLI tests and new summary tests.

- [ ] **Step 7: Commit**

```bash
git add src/engine/summary.ts tests/engine/summary.test.ts src/cli/create.ts tests/cli/create.test.ts
git commit -m "feat: add structured summary to petri create output"
```

---

### Task 4: Add lint / Concerns block

**Files:**
- Create: `src/engine/lint.ts`
- Create: `tests/engine/lint.test.ts`
- Modify: `src/cli/create.ts`
- Modify: `tests/cli/create.test.ts`

Implements 4 deterministic static checks on generated config:

| Tag | Check |
|---|---|
| `persona` | Any `roles/<name>/soul.md` is < 50 trimmed chars OR contains a generic phrase ("helpful assistant" / "I will help" / "I am an AI") |
| `coverage` | < 30% of description tokens (length ≥ 3, lowercased, stopwords filtered) appear (substring, case-insensitive) in any soul.md / skills/*.md |
| `gate` | Any `roles/<name>/gate.yaml` is missing the `evidence.check` field — gate becomes "passes if file exists", which is too lax |
| `lang` | Description is mostly Chinese (CJK chars > 50% of non-whitespace) but generated content is mostly English (CJK < 20%), or the inverse |

The function is pure — it reads files and returns `Concern[]`. The CLI layer is responsible for printing.

- [ ] **Step 1: Write failing tests for `lintPipeline`**

Create `tests/engine/lint.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { lintPipeline } from "../../src/engine/lint.js";

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf-8");
  }
}

const HEALTHY_PIPELINE = {
  "pipeline.yaml":
    "name: code-review\n" +
    "stages:\n" +
    "  - name: review\n" +
    "    roles: [reviewer]\n",
  "roles/reviewer/role.yaml": "persona: soul.md\nskills: [review]\n",
  "roles/reviewer/soul.md":
    "You are an experienced code reviewer focused on correctness, " +
    "test coverage, and security.\n",
  "roles/reviewer/skills/review.md":
    "# Review\nReview the diff for code quality, tests, and security issues.\n",
  "roles/reviewer/gate.yaml":
    "id: review-done\n" +
    "evidence:\n" +
    "  type: artifact\n" +
    "  path: 'review/reviewer/done.json'\n" +
    "  check:\n" +
    "    field: completed\n" +
    "    equals: true\n",
};

describe("lintPipeline", () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "petri-lint-")); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it("returns no concerns for a healthy pipeline matching the description", () => {
    writeTree(tmp, HEALTHY_PIPELINE);
    const concerns = lintPipeline({
      generatedDir: tmp,
      description: "Build a code reviewer that checks quality, test coverage, and security.",
    });
    expect(concerns).toEqual([]);
  });

  it("flags soul.md that is too short", () => {
    writeTree(tmp, { ...HEALTHY_PIPELINE, "roles/reviewer/soul.md": "Helper.\n" });
    const concerns = lintPipeline({
      generatedDir: tmp,
      description: "Code reviewer for quality and tests",
    });
    expect(concerns.some((c) => c.tag === "persona" && c.message.includes("reviewer"))).toBe(true);
  });

  it("flags soul.md with generic 'helpful assistant' phrasing", () => {
    writeTree(tmp, {
      ...HEALTHY_PIPELINE,
      "roles/reviewer/soul.md":
        "You are a helpful assistant. I will help you with whatever you need.\n",
    });
    const concerns = lintPipeline({
      generatedDir: tmp,
      description: "Code reviewer for quality and tests",
    });
    expect(concerns.some((c) => c.tag === "persona")).toBe(true);
  });

  it("flags description-coverage gap when generated content ignores key terms", () => {
    writeTree(tmp, {
      ...HEALTHY_PIPELINE,
      "roles/reviewer/soul.md": "You write whimsical poetry about clouds and emotions.\n",
      "roles/reviewer/skills/review.md": "# Poetry\nWrite stanzas.\n",
    });
    const concerns = lintPipeline({
      generatedDir: tmp,
      description: "Build a code reviewer that checks quality, security, and test coverage.",
    });
    expect(concerns.some((c) => c.tag === "coverage")).toBe(true);
  });

  it("flags gate.yaml missing evidence.check", () => {
    writeTree(tmp, {
      ...HEALTHY_PIPELINE,
      "roles/reviewer/gate.yaml":
        "id: review-done\n" +
        "evidence:\n" +
        "  type: artifact\n" +
        "  path: 'review/reviewer/done.json'\n",
    });
    const concerns = lintPipeline({
      generatedDir: tmp,
      description: "Code reviewer for quality and tests",
    });
    expect(concerns.some((c) => c.tag === "gate" && c.message.includes("reviewer"))).toBe(true);
  });

  it("flags language mismatch: Chinese description with English generated content", () => {
    writeTree(tmp, HEALTHY_PIPELINE);
    const concerns = lintPipeline({
      generatedDir: tmp,
      description: "构建一个代码评审 pipeline，检查代码质量、测试覆盖率和安全性问题",
    });
    expect(concerns.some((c) => c.tag === "lang")).toBe(true);
  });

  it("returns empty when generatedDir is missing pipeline.yaml", () => {
    expect(lintPipeline({ generatedDir: tmp, description: "x" })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/engine/lint.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/engine/lint.ts`**

```typescript
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { listFilesRecursive } from "../util/fs.js";

export type ConcernTag = "persona" | "coverage" | "gate" | "lang";

export interface Concern {
  tag: ConcernTag;
  message: string;
}

export interface LintInput {
  generatedDir: string;
  description: string;
}

const PERSONA_MIN_CHARS = 50;
const GENERIC_PHRASES = [
  "helpful assistant",
  "i will help",
  "i am an ai",
  "as an ai",
];
const STOPWORDS = new Set([
  "the","and","for","with","that","this","into","from","your","you","are",
  "build","make","create","using","use","want","need","would","like","just",
  "pipeline","stage","stages","role","roles",
]);
const COVERAGE_THRESHOLD = 0.3;
const CHINESE_CHAR = /[一-鿿]/g;

function readSafe(p: string): string | null {
  try { return fs.readFileSync(p, "utf-8"); } catch { return null; }
}

function listRoles(generatedDir: string): string[] {
  const rolesDir = path.join(generatedDir, "roles");
  if (!fs.existsSync(rolesDir)) return [];
  return fs.readdirSync(rolesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function gatherTextContent(generatedDir: string): string {
  if (!fs.existsSync(generatedDir)) return "";
  const files = listFilesRecursive(generatedDir);
  const parts: string[] = [];
  for (const rel of files) {
    if (rel.endsWith(".md") || rel.endsWith(".yaml")) {
      const content = readSafe(path.join(generatedDir, rel));
      if (content) parts.push(content);
    }
  }
  return parts.join("\n");
}

function tokenize(text: string): string[] {
  // Split on whitespace and common punctuation. Keep tokens of length ≥ 3.
  // Lowercase. Drop pure-numeric and stopwords.
  return text
    .toLowerCase()
    .split(/[\s,.;:!?\-_()\[\]{}"'`<>|/\\]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .filter((t) => !/^\d+$/.test(t))
    .filter((t) => !STOPWORDS.has(t));
}

function chineseRatio(s: string): number {
  const nonWs = s.replace(/\s+/g, "");
  if (nonWs.length === 0) return 0;
  const matches = s.match(CHINESE_CHAR);
  return (matches?.length ?? 0) / nonWs.length;
}

function lintPersonas(generatedDir: string, roles: string[]): Concern[] {
  const out: Concern[] = [];
  for (const role of roles) {
    const soul = readSafe(path.join(generatedDir, "roles", role, "soul.md"));
    if (soul === null) continue;
    const trimmed = soul.trim();
    if (trimmed.length < PERSONA_MIN_CHARS) {
      out.push({
        tag: "persona",
        message: `${role}/soul.md is ${trimmed.length} chars (likely placeholder)`,
      });
      continue;
    }
    const lower = trimmed.toLowerCase();
    const hit = GENERIC_PHRASES.find((p) => lower.includes(p));
    if (hit) {
      out.push({
        tag: "persona",
        message: `${role}/soul.md contains generic phrase "${hit}"`,
      });
    }
  }
  return out;
}

function lintCoverage(generatedDir: string, description: string): Concern[] {
  const tokens = Array.from(new Set(tokenize(description)));
  if (tokens.length === 0) return [];
  const corpus = gatherTextContent(generatedDir).toLowerCase();
  if (corpus.length === 0) return [];
  const missed: string[] = [];
  let hits = 0;
  for (const t of tokens) {
    if (corpus.includes(t)) hits += 1;
    else missed.push(t);
  }
  const ratio = hits / tokens.length;
  if (ratio >= COVERAGE_THRESHOLD) return [];
  const sample = missed.slice(0, 5).join(", ");
  return [{
    tag: "coverage",
    message:
      `only ${Math.round(ratio * 100)}% of description terms appear in generated content ` +
      `(missing: ${sample}${missed.length > 5 ? ", ..." : ""})`,
  }];
}

function lintGates(generatedDir: string, roles: string[]): Concern[] {
  const out: Concern[] = [];
  for (const role of roles) {
    const gatePath = path.join(generatedDir, "roles", role, "gate.yaml");
    const raw = readSafe(gatePath);
    if (raw === null) continue;
    let parsed: any;
    try { parsed = parseYaml(raw); } catch { continue; }
    if (!parsed?.evidence?.check) {
      out.push({
        tag: "gate",
        message: `${role}/gate.yaml has no evidence.check (passes whenever the file exists)`,
      });
    }
  }
  return out;
}

function lintLanguage(generatedDir: string, description: string): Concern[] {
  const descCn = chineseRatio(description);
  const corpus = gatherTextContent(generatedDir);
  if (corpus.length === 0) return [];
  const corpusCn = chineseRatio(corpus);

  if (descCn > 0.5 && corpusCn < 0.2) {
    return [{
      tag: "lang",
      message: "description is mostly Chinese but generated content is mostly English",
    }];
  }
  if (descCn < 0.05 && corpusCn > 0.5) {
    return [{
      tag: "lang",
      message: "description is in English but generated content is mostly Chinese",
    }];
  }
  return [];
}

export function lintPipeline(input: LintInput): Concern[] {
  if (!fs.existsSync(path.join(input.generatedDir, "pipeline.yaml"))) {
    return [];
  }
  const roles = listRoles(input.generatedDir);
  return [
    ...lintPersonas(input.generatedDir, roles),
    ...lintCoverage(input.generatedDir, input.description),
    ...lintGates(input.generatedDir, roles),
    ...lintLanguage(input.generatedDir, input.description),
  ];
}
```

- [ ] **Step 4: Run lint tests to verify they pass**

Run: `npx vitest run tests/engine/lint.test.ts`
Expected: all 7 tests PASS.

- [ ] **Step 5: Wire lint into `runCreate` and update its top-line + add Concerns block**

In `src/cli/create.ts`, add the import:

```typescript
import { lintPipeline, type Concern } from "../engine/lint.js";
```

Then replace the existing top-line status block in `runCreate`. Find this:

```typescript
  console.log();
  if (result.status === "ok") {
    console.log(chalk.green(`✔ status: ok`) + chalk.gray(`  (retries: ${result.retries})`));
  } else {
    console.log(chalk.yellow(`⚠ status: validation_failed`) + chalk.gray(`  (retries: ${result.retries})`));
  }

  if (result.errors && result.errors.length > 0) {
    console.log();
    console.log(chalk.yellow("Errors:"));
    for (const err of result.errors) {
      console.log(chalk.yellow(`  - ${err}`));
    }
  }
```

Replace with:

```typescript
  // Run lint before printing so the top-line status can include concern count
  const concerns: Concern[] = lintPipeline({
    generatedDir,
    description,
  });

  console.log();
  const tagPart = result.status === "ok"
    ? chalk.green("✔ generated")
    : chalk.yellow("⚠ validation_failed");
  const concernPart = concerns.length > 0
    ? chalk.yellow(`  ⚠ ${concerns.length} concern${concerns.length === 1 ? "" : "s"}`)
    : "";
  console.log(tagPart + concernPart);
  console.log(chalk.gray(`   retries: ${result.retries}   files: ${result.files.length}`));

  if (result.errors && result.errors.length > 0) {
    console.log();
    console.log(chalk.yellow("Errors:"));
    for (const err of result.errors) {
      console.log(chalk.yellow(`  - ${err}`));
    }
  }
```

Then add a Concerns block after the summary block (the summary block was added in Task 3). Find the very end of the summary block — right before:

```typescript
  console.log();
  const relGen = path.relative(cwd, generatedDir) || generatedDir;
  console.log(chalk.gray(`→ Inspect:  cat ${relGen}/pipeline.yaml`));
```

Insert before that:

```typescript
  // Concerns block
  if (concerns.length > 0) {
    console.log();
    console.log(chalk.yellow.bold(`⚠ Concerns (${concerns.length})`));
    for (const c of concerns) {
      const tag = chalk.yellow(`[${c.tag}]`);
      console.log(`  • ${tag} ${c.message}`);
    }
  }

```

Update `tests/cli/create.test.ts`. Add a new test case at the end of the existing `describe` block:

```typescript
  it("prints a Concerns block when lint flags issues", async () => {
    // Build JSON where soul.md is a placeholder — will trigger persona concern
    const PLACEHOLDER_JSON = JSON.stringify({
      "pipeline.yaml": [
        "name: t",
        "stages:",
        "  - name: work",
        "    roles: [worker]",
        "    requires: [work-done]",
        "",
      ].join("\n"),
      "roles/worker/role.yaml": "persona: soul.md\nskills: []\n",
      "roles/worker/soul.md": "Helper.\n",
      "roles/worker/gate.yaml": [
        "id: work-done",
        "evidence:",
        "  type: artifact",
        "  path: '{stage}/{role}/done.json'",
        "  check:",
        "    field: completed",
        "    equals: true",
        "",
      ].join("\n"),
    });
    const { runCreate } = await import("../../src/cli/create.js");
    const provider = makeStubProvider(PLACEHOLDER_JSON);

    await runCreate(
      { description: "Build a worker that does important things" },
      provider,
      tmpDir,
    );

    const output = lines.join("\n");
    expect(output).toContain("Concerns");
    expect(output).toContain("[persona]");
  });
```

Also update the first test (`"generates a pipeline from a positional description..."`) — replace the line:

```typescript
    expect(output).toContain("ok");
```

With:

```typescript
    expect(output).toContain("generated");
```

(The healthy fixture should produce no concerns; we just check the new top-line wording.)

- [ ] **Step 6: Run all tests to verify they pass**

Run: `npx vitest run`
Expected: full suite PASS.

- [ ] **Step 7: Commit**

```bash
git add src/engine/lint.ts tests/engine/lint.test.ts src/cli/create.ts tests/cli/create.test.ts
git commit -m "feat: add lint Concerns to petri create output"
```

---

### Task 5: Manual smoke test with real provider

**Files:** None (manual verification)

This task verifies the command actually works end-to-end against a real LLM provider, in the dev shell. Skip if a real provider is not configured locally — the unit tests cover correctness against a stub.

- [ ] **Step 1: Build the CLI**

Run: `npm run build`
Expected: build succeeds, `dist/` updated.

- [ ] **Step 2: Set up a throwaway project**

```bash
mkdir -p /tmp/petri-create-smoke && cd /tmp/petri-create-smoke
node /Users/xupeng/dev/github/petri/dist/cli/index.js init
```
Expected: `petri.yaml` created, "Initialized petri project" printed.

- [ ] **Step 3: Run `petri create` with a positional description**

```bash
node /Users/xupeng/dev/github/petri/dist/cli/index.js create "Build a pipeline that summarizes a markdown document and writes the summary to a file"
```
Expected:
- "Generating pipeline..." line
- Top line: `✔ generated` (or `⚠ validation_failed`), optionally followed by `⚠ N concerns`
- `retries: N   files: N` line
- **Summary block** with `Pipeline:`, `Goal:`, `Flow:` (numbered stages with roles), `Roles:` (each role's persona first line)
- **Concerns block** if any heuristics tripped (e.g. `[persona]`, `[coverage]`, `[gate]`, `[lang]`)
- `→ Inspect:` hints
- Files actually present in `.petri/generated/`

Eyeball the summary: does the goal/persona match what you asked for? This is the Layer 3 sanity check the lint can't do for you.

- [ ] **Step 4: Run `petri create --from <file>`**

```bash
cat > desc.md <<'EOF'
Build a two-stage pipeline:
- stage 1: a researcher gathers facts about a topic
- stage 2: a writer turns the facts into a short article
EOF
node /Users/xupeng/dev/github/petri/dist/cli/index.js create --from desc.md
```
Expected: same shape of output as Step 3, files regenerated under `.petri/generated/`.

- [ ] **Step 5: Verify the lint actually fires when generation drifts**

Try a description that's likely to cause a coverage or language miss:

```bash
node /Users/xupeng/dev/github/petri/dist/cli/index.js create "构建一个代码评审 pipeline，检查代码质量、测试覆盖率和安全性"
```

Expected: if the LLM produces English content (likely), `⚠ Concerns` should include a `[lang]` entry. This validates the lint is wired correctly.

- [ ] **Step 6: Verify error paths**

```bash
node /Users/xupeng/dev/github/petri/dist/cli/index.js create
```
Expected: `Error: Missing description...`, exit code 1.

```bash
node /Users/xupeng/dev/github/petri/dist/cli/index.js create --from no-such-file.md
```
Expected: `Error: Description file not found: ...`, exit code 1.

```bash
node /Users/xupeng/dev/github/petri/dist/cli/index.js create "Inline" --from desc.md
```
Expected: `Error: Cannot use both...`, exit code 1.

- [ ] **Step 7: Clean up**

```bash
rm -rf /tmp/petri-create-smoke
```

- [ ] **Step 8: Commit any tweaks made during smoke testing**

If smoke tests revealed issues that needed fixes:

```bash
git add -A
git commit -m "fix: petri create smoke-test adjustments"
```

If no fixes were needed, skip this step.
