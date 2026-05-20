# Command Stage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `command` stage type to petri — a non-agent pipeline stage that runs a deterministic shell command, so deterministic work (e.g. a backtest) is a first-class stage instead of being wrapped in an LLM agent.

**Architecture:** A `command` stage is a third `StageEntry` variant alongside `StageConfig` (agent) and `RepeatBlock`. The engine runs it once with `execSync` — no retry, no feedback injection. Non-zero exit → run `blocked` (infrastructure failure). Zero exit → run continues. Command stages carry no `roles` and no gates (gating command output is a later plan).

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node.js `child_process`, vitest, `yaml`.

**Source spec:** `docs/superpowers/specs/2026-05-20-petri-evolution-model-design.md` (decision D3; this plan covers the `command` stage only).

**Convention:** Commit messages end with the repo's standard `Co-Authored-By:` trailer.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/types.ts` | modify | Add `CommandStage` interface, extend `StageEntry`, add `isCommandStage` guard |
| `src/engine/engine.ts` | modify | Add `runCommandStage`; dispatch command stages in `run()` and `runRepeatBlock()`; skip them in `collectRepeatProgressEvidence()` |
| `src/engine/validate.ts` | modify | Validate command stages in `walk()`; accept a pipeline whose only non-trivial stage is a command stage |
| `src/config/loader.ts` | modify | Add exported `collectRoleNames()` — command-stage-aware role collection |
| `src/cli/run.ts` | modify | Use `collectRoleNames()` instead of the inline `collectRoles` (which crashes on roleless stages) |
| `src/engine/summary.ts` | modify | Add `"command"` to `StageSummary.kind`; render command stages |
| `tests/types.test.ts` | create | Tests for `isCommandStage` |
| `tests/engine/engine.test.ts` | modify | Tests for command stage execution (linear + inside repeat) |
| `tests/engine/validate.test.ts` | modify | Tests for command stage validation |
| `tests/config/loader.test.ts` | modify | Tests for `collectRoleNames` |
| `tests/engine/summary.test.ts` | modify | Test for command stage rendering |

---

## Task 1: `CommandStage` type and `isCommandStage` guard

**Files:**
- Modify: `src/types.ts`
- Test: `tests/types.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/types.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { isCommandStage, isRepeatBlock } from "../src/types.js";
import type { CommandStage, RepeatBlock, StageConfig } from "../src/types.js";

describe("isCommandStage", () => {
  it("returns true for a command stage", () => {
    const entry: CommandStage = { name: "measure", command: "python run.py" };
    expect(isCommandStage(entry)).toBe(true);
  });

  it("returns false for an agent stage", () => {
    const entry: StageConfig = { name: "design", roles: ["designer"] };
    expect(isCommandStage(entry)).toBe(false);
  });

  it("returns false for a repeat block", () => {
    const entry: RepeatBlock = {
      repeat: { name: "loop", max_iterations: 3, until: "done", stages: [] },
    };
    expect(isCommandStage(entry)).toBe(false);
    expect(isRepeatBlock(entry)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/types.test.ts`
Expected: FAIL — `isCommandStage` is not exported / `CommandStage` type missing.

- [ ] **Step 3: Add the type and guard**

In `src/types.ts`, replace this line:

```typescript
export type StageEntry = StageConfig | RepeatBlock;
```

with:

```typescript
export type StageEntry = StageConfig | RepeatBlock | CommandStage;
```

Then, immediately after the `RepeatBlock` interface (the block ending `}` after `until: string;  // gate id to check` ... `stages: StageEntry[]; } }`), add:

```typescript
/**
 * A deterministic, non-agent stage. Runs a shell command once.
 * No roles, no gates, no retry/feedback — re-running yields the same result.
 */
export interface CommandStage {
  name: string;
  command: string;       // shell command; "{artifact_dir}" is substituted at run time
  timeout?: number;      // max wall-clock ms (default: engine defaultTimeout)
}
```

Then, immediately after the existing `isRepeatBlock` function, add:

```typescript
export function isCommandStage(entry: StageEntry): entry is CommandStage {
  return "command" in entry;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/types.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts tests/types.test.ts
git commit -m "feat(types): add CommandStage stage entry type"
```

---

## Task 2: Engine runs a linear command stage

**Files:**
- Modify: `src/engine/engine.ts`
- Test: `tests/engine/engine.test.ts`

- [ ] **Step 1: Write the failing tests**

Append these tests inside the `describe("Engine", ...)` block in `tests/engine/engine.test.ts` (before its closing `});`):

```typescript
  it("runs a command stage to completion (exit 0)", async () => {
    const pipeline: PipelineConfig = {
      name: "cmd-pipeline",
      stages: [{ name: "measure", command: "exit 0" }],
    };
    const engine = new Engine({
      provider: createStubProvider(() => {}),
      roles: {},
      artifactBaseDir: tmpDir,
    });
    const result = await engine.run(pipeline, "go");
    expect(result.status).toBe("done");
  });

  it("blocks the run when a command stage exits non-zero", async () => {
    const pipeline: PipelineConfig = {
      name: "cmd-pipeline",
      stages: [{ name: "measure", command: "exit 1" }],
    };
    const engine = new Engine({
      provider: createStubProvider(() => {}),
      roles: {},
      artifactBaseDir: tmpDir,
    });
    const result = await engine.run(pipeline, "go");
    expect(result.status).toBe("blocked");
    expect(result.stage).toBe("measure");
    expect(result.reason).toMatch(/command failed/i);
  });

  it("substitutes {artifact_dir} and creates the command stage artifact dir", async () => {
    const pipeline: PipelineConfig = {
      name: "cmd-pipeline",
      stages: [{ name: "measure", command: "echo hi > {artifact_dir}/out.txt" }],
    };
    const engine = new Engine({
      provider: createStubProvider(() => {}),
      roles: {},
      artifactBaseDir: tmpDir,
    });
    const result = await engine.run(pipeline, "go");
    expect(result.status).toBe("done");
    expect(fs.existsSync(path.join(tmpDir, "measure", "out.txt"))).toBe(true);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/engine/engine.test.ts -t "command stage"`
Expected: FAIL — command stages are dispatched to `runStage`, which reads `stage.roles` (undefined) and throws / does not behave as expected.

- [ ] **Step 3: Add the `execSync` import**

In `src/engine/engine.ts`, the first imports are `node:crypto` and `node:fs`. Add after the `node:crypto` import line:

```typescript
import { execSync } from "node:child_process";
```

- [ ] **Step 4: Import the new type and guard**

In `src/engine/engine.ts`, change:

```typescript
import { isRepeatBlock } from "../types.js";
```

to:

```typescript
import { isRepeatBlock, isCommandStage } from "../types.js";
```

And in the `import type { ... } from "../types.js";` block, add `CommandStage` to the list (alongside `StageConfig`).

- [ ] **Step 5: Add the `runCommandStage` method**

In `src/engine/engine.ts`, add this method to the `Engine` class, immediately before `private async runRepeatBlock(`:

```typescript
  private async runCommandStage(stage: CommandStage): Promise<RunResult> {
    const artifactDir = join(this.artifactBaseDir, stage.name);
    mkdirSync(artifactDir, { recursive: true });
    const command = stage.command.replaceAll("{artifact_dir}", artifactDir);
    const timeout = stage.timeout ?? this.defaultTimeout;

    console.log(`  Command stage "${stage.name}": ${command}`);
    this.logger?.logStageAttempt(stage.name, 1, 1);

    try {
      execSync(command, { stdio: "inherit", timeout });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`  Command stage "${stage.name}" FAILED: ${message}`);
      return { status: "blocked", stage: stage.name, reason: `Command failed: ${message}` };
    }

    console.log(`  Command stage "${stage.name}" completed`);
    return { status: "done" };
  }
```

- [ ] **Step 6: Dispatch command stages in `run()`**

In `src/engine/engine.ts`, inside the `for (const entry of pipeline.stages)` loop in `run()`, replace this block:

```typescript
      if (isRepeatBlock(entry)) {
        const result = await this.runRepeatBlock(entry.repeat, input, manifest);
        if (result.status === "blocked") {
          manifest.save();
          return result;
        }
      } else {
        const result = await this.runStage(entry, input, manifest);
        if (result.status === "blocked") {
          manifest.save();
          return result;
        }
      }
```

with:

```typescript
      if (isRepeatBlock(entry)) {
        const result = await this.runRepeatBlock(entry.repeat, input, manifest);
        if (result.status === "blocked") {
          manifest.save();
          return result;
        }
      } else if (isCommandStage(entry)) {
        const result = await this.runCommandStage(entry);
        if (result.status === "blocked") {
          manifest.save();
          return result;
        }
      } else {
        const result = await this.runStage(entry, input, manifest);
        if (result.status === "blocked") {
          manifest.save();
          return result;
        }
      }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/engine/engine.test.ts`
Expected: PASS — all existing Engine tests plus the 3 new ones.

- [ ] **Step 8: Commit**

```bash
git add src/engine/engine.ts tests/engine/engine.test.ts
git commit -m "feat(engine): run command stages in linear pipelines"
```

---

## Task 3: Command stages inside repeat blocks

**Files:**
- Modify: `src/engine/engine.ts`
- Test: `tests/engine/engine.test.ts`

- [ ] **Step 1: Write the failing test**

Append this test inside the `describe("Engine", ...)` block in `tests/engine/engine.test.ts`:

```typescript
  it("runs a command stage on every iteration of a repeat block", async () => {
    // A repeat block with only a command stage has no until-gate evidence,
    // so it runs to max_iterations and then blocks. We assert the command
    // executed once per iteration.
    const pipeline: PipelineConfig = {
      name: "cmd-repeat",
      stages: [
        {
          repeat: {
            name: "loop",
            max_iterations: 3,
            until: "never-set",
            stages: [
              { name: "tick", command: "echo x >> {artifact_dir}/runs.txt" },
            ],
          },
        },
      ],
    };
    const engine = new Engine({
      provider: createStubProvider(() => {}),
      roles: {},
      artifactBaseDir: tmpDir,
    });
    const result = await engine.run(pipeline, "go");
    expect(result.status).toBe("blocked");
    const runs = fs.readFileSync(path.join(tmpDir, "tick", "runs.txt"), "utf-8");
    expect(runs.trim().split("\n")).toHaveLength(3);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/engine.test.ts -t "every iteration"`
Expected: FAIL — `runRepeatBlock` dispatches the command stage to `runStage`, and/or `collectRepeatProgressEvidence` throws reading `entry.roles` on the roleless command stage.

- [ ] **Step 3: Dispatch command stages in `runRepeatBlock()`**

In `src/engine/engine.ts`, inside `runRepeatBlock()`, replace this block:

```typescript
        let result: RunResult;
        if (isRepeatBlock(entry)) {
          result = await this.runRepeatBlock(entry.repeat, input, manifest);
        } else {
          result = await this.runStage(entry, input, manifest);
        }
```

with:

```typescript
        let result: RunResult;
        if (isRepeatBlock(entry)) {
          result = await this.runRepeatBlock(entry.repeat, input, manifest);
        } else if (isCommandStage(entry)) {
          result = await this.runCommandStage(entry);
        } else {
          result = await this.runStage(entry, input, manifest);
        }
```

- [ ] **Step 4: Skip command stages in `collectRepeatProgressEvidence()`**

In `src/engine/engine.ts`, inside `collectRepeatProgressEvidence()`, the loop body starts:

```typescript
    for (const entry of entries) {
      if (isRepeatBlock(entry)) {
        files.push(...this.collectRepeatProgressEvidence(entry.repeat.stages, untilGateId));
        continue;
      }

      for (const roleName of entry.roles) {
```

Insert a command-stage skip between the `isRepeatBlock` block and the `for (const roleName of entry.roles)` line:

```typescript
    for (const entry of entries) {
      if (isRepeatBlock(entry)) {
        files.push(...this.collectRepeatProgressEvidence(entry.repeat.stages, untilGateId));
        continue;
      }

      if (isCommandStage(entry)) continue;  // command stages have no role gates

      for (const roleName of entry.roles) {
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/engine/engine.test.ts`
Expected: PASS — all Engine tests including the new repeat test.

- [ ] **Step 6: Commit**

```bash
git add src/engine/engine.ts tests/engine/engine.test.ts
git commit -m "feat(engine): run command stages inside repeat blocks"
```

---

## Task 4: Validate command stages

**Files:**
- Modify: `src/engine/validate.ts`
- Test: `tests/engine/validate.test.ts`

- [ ] **Step 1: Write the failing tests**

First inspect the top of `tests/engine/validate.test.ts` to reuse its existing temp-project helper (it writes `petri.yaml`, `pipeline.yaml`, and `roles/`). Append these tests, matching that file's existing setup helper (referred to below as the helper that writes a project and returns its dir — use the same helper the other tests in this file use):

```typescript
  it("accepts a pipeline whose only stage is a command stage", () => {
    const dir = makeProject({
      "petri.yaml": "providers:\n  default:\n    type: claude_code\nmodels:\n  sonnet:\n    provider: default\n    model: sonnet\ndefaults:\n  model: sonnet\n  gate_strategy: all\n  max_retries: 3\n",
      "pipeline.yaml": "name: cmd-only\nstages:\n  - name: measure\n    command: python run.py\n",
    });
    const result = validateProject(dir);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects a command stage missing its command field", () => {
    const dir = makeProject({
      "petri.yaml": "providers:\n  default:\n    type: claude_code\nmodels:\n  sonnet:\n    provider: default\n    model: sonnet\ndefaults:\n  model: sonnet\n  gate_strategy: all\n  max_retries: 3\n",
      "pipeline.yaml": "name: bad\nstages:\n  - name: measure\n",
    });
    const result = validateProject(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/command stage "measure" missing required "command"/);
  });
```

Note: if `tests/engine/validate.test.ts` has no reusable project-writing helper, add this helper near the top of the file:

```typescript
function makeProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "petri-validate-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}
```

with imports at the top of the file: `import * as fs from "node:fs";`, `import * as path from "node:path";`, `import * as os from "node:os";` (add any that are missing).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/engine/validate.test.ts -t "command stage"`
Expected: FAIL — the command-only pipeline currently errors with `missing required "roles"` and `must contain at least one repeat: block`.

- [ ] **Step 3: Import the guard**

In `src/engine/validate.ts`, change:

```typescript
import { isRepeatBlock, type GateCheck, type GateCheckClause, type LoadedRole, type StageEntry } from "../types.js";
```

to:

```typescript
import { isRepeatBlock, isCommandStage, type GateCheck, type GateCheckClause, type LoadedRole, type StageEntry } from "../types.js";
```

- [ ] **Step 4: Track command stages and validate them**

In `src/engine/validate.ts`, change:

```typescript
  const roleNames = new Set<string>();
  const repeatBlocks: { name: string; until: string }[] = [];
```

to:

```typescript
  const roleNames = new Set<string>();
  const repeatBlocks: { name: string; until: string }[] = [];
  let commandStageCount = 0;
```

Then, inside `walk()`, the structure is `if (isRepeatBlock(entry)) { ... } else { ...stage handling... }`. Change the `else` to insert a command-stage branch. Replace:

```typescript
        } else {
          const stageName = typeof entry.name === "string" && entry.name.length > 0 ? entry.name : "(unnamed)";
          if (typeof entry.name !== "string" || entry.name.length === 0) {
            errors.push(`pipeline.yaml: stage missing required "name" field (string)`);
          }
          if (!Array.isArray(entry.roles) || entry.roles.length === 0) {
```

with:

```typescript
        } else if (isCommandStage(entry)) {
          const cmdName = typeof entry.name === "string" && entry.name.length > 0 ? entry.name : "(unnamed)";
          if (typeof entry.name !== "string" || entry.name.length === 0) {
            errors.push(`pipeline.yaml: command stage missing required "name" field (string)`);
          }
          if (typeof entry.command !== "string" || entry.command.length === 0) {
            errors.push(`pipeline.yaml: command stage "${cmdName}" missing required "command" field (non-empty string)`);
          }
          commandStageCount++;
        } else {
          const stageName = typeof entry.name === "string" && entry.name.length > 0 ? entry.name : "(unnamed)";
          if (typeof entry.name !== "string" || entry.name.length === 0) {
            errors.push(`pipeline.yaml: stage missing required "name" field (string)`);
          }
          if (!Array.isArray(entry.roles) || entry.roles.length === 0) {
```

- [ ] **Step 5: Let a command stage satisfy the "non-trivial pipeline" check**

In `src/engine/validate.ts`, change:

```typescript
      if (repeatBlocks.length === 0) {
        errors.push(
          "pipeline.yaml: pipeline must contain at least one repeat: block (no feedback loop = workflow, not training pipeline)",
        );
      }
```

to:

```typescript
      if (repeatBlocks.length === 0 && commandStageCount === 0) {
        errors.push(
          "pipeline.yaml: pipeline must contain at least one repeat: block or command stage (no feedback loop and no deterministic step = empty workflow)",
        );
      }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/engine/validate.test.ts`
Expected: PASS — all validate tests including the 2 new ones.

- [ ] **Step 7: Commit**

```bash
git add src/engine/validate.ts tests/engine/validate.test.ts
git commit -m "feat(validate): validate command stages in pipeline.yaml"
```

---

## Task 5: Role collection and pipeline summary handle command stages

**Files:**
- Modify: `src/config/loader.ts`
- Modify: `src/cli/run.ts`
- Modify: `src/engine/summary.ts`
- Test: `tests/config/loader.test.ts`
- Test: `tests/engine/summary.test.ts`

- [ ] **Step 1: Write the failing test for `collectRoleNames`**

Append to `tests/config/loader.test.ts` (inside the file's top-level scope; add `import { collectRoleNames } from "../../src/config/loader.js";` to its imports):

```typescript
describe("collectRoleNames", () => {
  it("collects role names across nested repeat blocks and skips command stages", () => {
    const names = collectRoleNames([
      { name: "design", roles: ["designer"] },
      { name: "measure", command: "python run.py" },
      {
        repeat: {
          name: "loop",
          max_iterations: 3,
          until: "done",
          stages: [
            { name: "develop", roles: ["developer", "reviewer"] },
            { name: "backtest", command: "python bt.py" },
          ],
        },
      },
    ]);
    expect([...names].sort()).toEqual(["designer", "developer", "reviewer"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config/loader.test.ts -t collectRoleNames`
Expected: FAIL — `collectRoleNames` is not exported.

- [ ] **Step 3: Add `collectRoleNames` to the loader**

In `src/config/loader.ts`, add `StageEntry`, `isRepeatBlock`, `isCommandStage` to the imports from `../types.js` (it currently imports types from there; add these three — `isRepeatBlock`/`isCommandStage` are values, not types, so import them outside the `import type` block):

```typescript
import { isRepeatBlock, isCommandStage } from "../types.js";
import type {
  PetriConfig,
  PipelineConfig,
  RoleConfig,
  GateConfig,
  GateCheck,
  GateCheckClause,
  LoadedRole,
  StageEntry,
} from "../types.js";
```

Then append this function to the end of `src/config/loader.ts`:

```typescript
/**
 * Collect every role name referenced by a pipeline's stages, recursing into
 * repeat blocks. Command stages have no roles and are skipped.
 */
export function collectRoleNames(stages: StageEntry[]): string[] {
  const names = new Set<string>();
  const walk = (entries: StageEntry[]): void => {
    for (const entry of entries) {
      if (isRepeatBlock(entry)) {
        walk(entry.repeat.stages);
      } else if (isCommandStage(entry)) {
        continue;
      } else {
        for (const role of entry.roles) names.add(role);
      }
    }
  };
  walk(stages);
  return [...names];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config/loader.test.ts -t collectRoleNames`
Expected: PASS.

- [ ] **Step 5: Use `collectRoleNames` in `run.ts`**

In `src/cli/run.ts`, the inline `collectRoles` function crashes on a roleless command stage (`for (const role of entry.roles)` with `entry.roles` undefined). Replace this block:

```typescript
  // 3. Collect all role names from pipeline stages (recursing into nested repeats)
  const roleNames = new Set<string>();
  function collectRoles(stages: import("../types.js").StageEntry[]): void {
    for (const entry of stages) {
      if (isRepeatBlock(entry)) {
        collectRoles(entry.repeat.stages);
      } else {
        for (const role of entry.roles) {
          roleNames.add(role);
        }
      }
    }
  }
  collectRoles(pipelineConfig.stages);
```

with:

```typescript
  // 3. Collect all role names from pipeline stages (recursing into nested
  //    repeats; command stages have no roles and are skipped)
  const roleNames = new Set<string>(collectRoleNames(pipelineConfig.stages));
```

Then update the loader import in `src/cli/run.ts` to include `collectRoleNames`:

```typescript
import {
  loadPetriConfig,
  loadPipelineConfig,
  loadRole,
  collectRoleNames,
} from "../config/loader.js";
```

And remove the now-unused `isRepeatBlock` import. Change:

```typescript
import { isRepeatBlock } from "../types.js";
import type { AgentProvider, LoadedRole } from "../types.js";
```

to:

```typescript
import type { AgentProvider, LoadedRole } from "../types.js";
```

- [ ] **Step 6: Write the failing test for summary rendering**

Ensure `tests/engine/summary.test.ts` has these imports at the top (add any that are missing):

```typescript
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { buildPipelineSummary } from "../../src/engine/summary.js";
```

If the file has no temp-project helper, add this one near the top:

```typescript
function makeProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "petri-summary-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}
```

Then append this test (inside the file's main `describe` block, or at top level in its own `describe`):

```typescript
  it("marks a command stage with kind 'command'", () => {
    const dir = makeProject({
      "pipeline.yaml": "name: p\nstages:\n  - name: measure\n    command: python run.py\n",
    });
    const summary = buildPipelineSummary(dir);
    expect(summary).not.toBeNull();
    const measure = summary!.stages.find((s) => s.name === "measure");
    expect(measure?.kind).toBe("command");
    expect(measure?.command).toBe("python run.py");
  });
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run tests/engine/summary.test.ts -t "kind 'command'"`
Expected: FAIL — `kind` is `"stage"` (command stages currently fall through to the generic stage branch) and `command` is undefined.

- [ ] **Step 8: Handle command stages in `summary.ts`**

In `src/engine/summary.ts`, change the `StageSummary` interface's `kind` field and add a `command` field:

```typescript
export interface StageSummary {
  kind: "stage" | "repeat" | "command";
  // For "stage":
  name?: string;
  roles?: string[];
  gateStrength?: GateStrength;
  gateCheck?: string;
  // For "command":
  command?: string;
  // For "repeat":
  repeatName?: string;
  maxIterations?: number;
  until?: string;
  innerStages?: StageSummary[];
}
```

Then, in `summarizeStages()`, after the `if (entry.repeat && typeof entry.repeat === "object") { ... continue; }` block and before the `if (typeof entry.name !== "string") continue;` line, insert:

```typescript
    if (typeof entry.command === "string") {
      out.push({
        kind: "command",
        name: typeof entry.name === "string" ? entry.name : undefined,
        command: entry.command,
      });
      continue;
    }
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `npx vitest run tests/engine/summary.test.ts tests/config/loader.test.ts`
Expected: PASS.

- [ ] **Step 10: Full build and test suite**

Run: `npm run build && npm test`
Expected: build succeeds (no TypeScript errors — confirms the removed `isRepeatBlock` import in `run.ts` and all type changes are consistent); all tests pass.

- [ ] **Step 11: Commit**

```bash
git add src/config/loader.ts src/cli/run.ts src/engine/summary.ts tests/config/loader.test.ts tests/engine/summary.test.ts
git commit -m "feat: handle command stages in role collection and pipeline summary"
```

---

## Manual verification

After all tasks, verify end-to-end with a real command-stage pipeline:

```bash
# In a scratch petri project (petri.yaml + the pipeline below):
#   pipeline.yaml:
#     name: smoke
#     stages:
#       - name: measure
#         command: "echo '{\"ok\": true}' > {artifact_dir}/metrics.json"
petri validate          # expect: valid
petri run               # expect: "Command stage \"measure\" completed", pipeline done
```

Confirm `.petri/.../artifacts/measure/metrics.json` exists.

---

## Out of scope (later plans)

- Gating a command stage's output (`CommandStage.gate`) — plan 2 (evaluation model).
- Rich `RunLogger` integration for command stages (structured stage records in `run.json`) — command stages currently log via `console.log` + a single `logStageAttempt` marker.
- Guardrails, `branch.yaml` v2 — plan 2.
