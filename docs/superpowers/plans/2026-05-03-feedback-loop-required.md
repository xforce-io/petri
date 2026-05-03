# Feedback-Loop-Required Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `repeat:` blocks a structural requirement for every petri pipeline — pipelines without a feedback loop are rejected by `validateProject`. Topology view (loop blocks + per-gate strength) ships alongside.

**Architecture:** Two new hard-error checks added to `src/engine/validate.ts`: (1) at least one `repeat:` block must exist anywhere in the stage tree, (2) the `until` gate of each `repeat:` block must not have `evidence.check.field == "completed"`. The `code-dev` template, generator prompt few-shot, and all test fixtures with linear pipelines are migrated. `PipelineSummary` becomes hierarchical to expose loop structure; `petri create`'s output adds gate-strength tags and `↻` markers for loops.

**Tech Stack:** TypeScript, Node.js, vitest, yaml. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-03-feedback-loop-required-design.md`

---

## File Structure

**New files:**
- None.

**Modified files:**
- `src/engine/validate.ts` — add `requireFeedbackLoop` + `requireNonTrivialUntil` checks.
- `src/engine/summary.ts` — hierarchical `StageSummary`, gate-strength loader.
- `src/cli/create.ts` — render hierarchical flow with `↻` for repeat blocks + gate strength tags.
- `src/engine/generator.ts` — append rule 11 + few-shot example uses repeat block.
- `src/templates/code-dev/pipeline.yaml` — wrap develop+review in repeat block.
- `tests/fixtures/valid-project/pipeline.yaml` — add repeat block.
- `tests/fixtures/valid-project/roles/worker/gate.yaml` — new file (strong gate, used as `until`).
- `tests/fixtures/missing-role/pipeline.yaml` — add repeat block (so loop check passes; `ghost_role` remains the surfaced error).
- `tests/cli/create.test.ts` — `VALID_PIPELINE_JSON` + `PLACEHOLDER_JSON` updated to comply with new validation.
- `tests/engine/validate.test.ts` — new tests for two new checks.
- `tests/engine/summary.test.ts` — update for hierarchical shape + gate strength.
- `tests/engine/lint.test.ts` — no changes needed (lint untouched).
- `tests/engine/generator.test.ts` — verify prompt includes new rule.

**Unchanged:**
- `src/engine/lint.ts` — both new errors are validation-level, not lint concerns.
- `src/types.ts` — `RepeatBlock` already exists.

---

## Task 1: Test fixture prep — `valid-project` migrates to comply with new validation

The `valid-project` fixture is the gold-standard valid input. Once we add the loop-required check it must contain a `repeat:` block with a strong (non-`completed`) `until` gate. Do this first so subsequent tasks have a working baseline.

**Files:**
- Create: `tests/fixtures/valid-project/roles/worker/gate.yaml`
- Modify: `tests/fixtures/valid-project/pipeline.yaml`

- [ ] **Step 1: Add `gate.yaml` for the worker role**

Write `tests/fixtures/valid-project/roles/worker/gate.yaml`:

```yaml
id: work-approved
description: Worker output must be approved
evidence:
  path: "{stage}/{role}/output.json"
  check:
    field: approved
    equals: true
```

- [ ] **Step 2: Update `pipeline.yaml` to wrap `work` in a repeat block**

Replace `tests/fixtures/valid-project/pipeline.yaml` with:

```yaml
name: test
description: Test pipeline
goal: Test
stages:
  - repeat:
      name: work-loop
      max_iterations: 3
      until: work-approved
      stages:
        - name: work
          roles: [worker]
```

- [ ] **Step 3: Run existing validate test to confirm fixture still validates**

Run: `npx vitest run tests/engine/validate.test.ts -t "returns valid for a correct project"`
Expected: PASS (fixture loads, role + gate parse, no validation errors yet because we haven't added the new checks).

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures/valid-project/pipeline.yaml tests/fixtures/valid-project/roles/worker/gate.yaml
git commit -m "test: add repeat block + gate to valid-project fixture"
```

---

## Task 2: Test fixture prep — `missing-role` keeps `ghost_role` as the surfaced error

The `missing-role` fixture exists to test that `validateProject` reports a missing-role error. After Task 3 lands the loop-required check, this fixture would *also* fail the loop check, and `errors[0]` would no longer mention `ghost_role`. Adding a repeat block here keeps the test focused on its actual purpose.

**Files:**
- Modify: `tests/fixtures/missing-role/pipeline.yaml`

- [ ] **Step 1: Update `pipeline.yaml` to wrap stage in a repeat block (still references missing role)**

Replace `tests/fixtures/missing-role/pipeline.yaml` with:

```yaml
name: test
description: Test
goal: Test
stages:
  - repeat:
      name: work-loop
      max_iterations: 3
      until: ghost-gate
      stages:
        - name: work
          roles: [ghost_role]
```

Note: `until: ghost-gate` references a non-existent gate id. Task 4's loop-trivial check skips repeat blocks whose `until` doesn't resolve to a loaded gate (so it can't double-report alongside the missing-role error). The existing test asserts `errors[0]` contains `ghost_role`, which still holds after Tasks 3 and 4 because (a) the loop-required check passes (there *is* a repeat block), and (b) the loop-trivial check skips the unresolved gate, so the role error remains the first error.

- [ ] **Step 2: Run existing missing-role test**

Run: `npx vitest run tests/engine/validate.test.ts -t "returns errors when pipeline references missing role"`
Expected: PASS (fixture still produces the ghost_role error; loop-required check not yet added, so no new errors).

- [ ] **Step 3: Commit**

```bash
git add tests/fixtures/missing-role/pipeline.yaml
git commit -m "test: wrap missing-role fixture stage in repeat block"
```

---

## Task 3: Add `requireFeedbackLoop` validation check

This task adds the first of the two hard errors specified. A pipeline whose stage tree contains zero `repeat:` blocks is rejected by `validateProject`.

**Files:**
- Modify: `src/engine/validate.ts`
- Modify: `tests/engine/validate.test.ts`

- [ ] **Step 1: Write failing test for "no repeat block" rejection**

Add to `tests/engine/validate.test.ts` inside the `describe("validateProject", ...)` block:

```typescript
import * as fs from "node:fs";
import * as os from "node:os";

function writeFixture(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "petri-validate-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf-8");
  }
  return dir;
}

const MIN_PETRI = [
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
].join("\n");

it("rejects a pipeline with no repeat block", () => {
  const dir = writeFixture({
    "petri.yaml": MIN_PETRI,
    "pipeline.yaml": [
      "name: linear",
      "stages:",
      "  - name: work",
      "    roles: [worker]",
      "",
    ].join("\n"),
    "roles/worker/role.yaml": "persona: soul.md\nskills: []\n",
    "roles/worker/soul.md": "You are a worker.\n",
    "roles/worker/gate.yaml": [
      "id: work-approved",
      "evidence:",
      "  path: '{stage}/{role}/output.json'",
      "  check:",
      "    field: approved",
      "    equals: true",
      "",
    ].join("\n"),
  });
  const result = validateProject(dir);
  expect(result.valid).toBe(false);
  expect(result.errors.some((e) => /at least one repeat/i.test(e))).toBe(true);
  fs.rmSync(dir, { recursive: true, force: true });
});
```

(If `os`, `fs` are not imported at the top of the file, add `import * as fs from "node:fs"; import * as os from "node:os";` to the imports.)

- [ ] **Step 2: Run failing test to verify it fails**

Run: `npx vitest run tests/engine/validate.test.ts -t "rejects a pipeline with no repeat block"`
Expected: FAIL — `result.valid` is `true` because the check doesn't exist yet.

- [ ] **Step 3: Implement the check in `validate.ts`**

In `src/engine/validate.ts`, modify the pipeline.yaml block (lines 21-39 currently) to also count repeat blocks, then add an error if none found:

```typescript
  // 2. Load pipeline.yaml
  const roleNames = new Set<string>();
  let repeatBlockCount = 0;
  try {
    const pipelineConfig = loadPipelineConfig(projectDir);
    function walk(stages: StageEntry[]): void {
      for (const entry of stages) {
        if (isRepeatBlock(entry)) {
          repeatBlockCount += 1;
          walk(entry.repeat.stages);
        } else {
          for (const role of entry.roles) {
            roleNames.add(role);
          }
        }
      }
    }
    walk(pipelineConfig.stages);
    if (repeatBlockCount === 0) {
      errors.push(
        "pipeline.yaml: pipeline must contain at least one repeat: block (no feedback loop = workflow, not training pipeline)",
      );
    }
  } catch (err: unknown) {
    errors.push(`pipeline.yaml: ${err instanceof Error ? err.message : String(err)}`);
  }
```

- [ ] **Step 4: Run new test to confirm it passes**

Run: `npx vitest run tests/engine/validate.test.ts -t "rejects a pipeline with no repeat block"`
Expected: PASS.

- [ ] **Step 5: Run full validate.test.ts suite to confirm fixture-based tests still pass**

Run: `npx vitest run tests/engine/validate.test.ts`
Expected: ALL PASS (including the two existing fixture tests, since Tasks 1 and 2 prepped them).

- [ ] **Step 6: Commit**

```bash
git add src/engine/validate.ts tests/engine/validate.test.ts
git commit -m "feat(validate): require at least one repeat block per pipeline"
```

---

## Task 4: Add loop-trivial validation check

Second hard error: any `repeat:` block whose `until` gate has `evidence.check.field == "completed"` is rejected. This depends on resolving the gate from disk via `loadRole`, so the check needs role-loading to have run successfully first.

**Files:**
- Modify: `src/engine/validate.ts`
- Modify: `tests/engine/validate.test.ts`

- [ ] **Step 1: Write failing test for `completed`-gate rejection**

Add to `tests/engine/validate.test.ts`:

```typescript
it("rejects a repeat block whose until gate exits on completed=true", () => {
  const dir = writeFixture({
    "petri.yaml": MIN_PETRI,
    "pipeline.yaml": [
      "name: trivial-loop",
      "stages:",
      "  - repeat:",
      "      name: bad-loop",
      "      max_iterations: 3",
      "      until: work-done",
      "      stages:",
      "        - name: work",
      "          roles: [worker]",
      "",
    ].join("\n"),
    "roles/worker/role.yaml": "persona: soul.md\nskills: []\n",
    "roles/worker/soul.md": "You are a worker.\n",
    "roles/worker/gate.yaml": [
      "id: work-done",
      "evidence:",
      "  path: '{stage}/{role}/output.json'",
      "  check:",
      "    field: completed",
      "    equals: true",
      "",
    ].join("\n"),
  });
  const result = validateProject(dir);
  expect(result.valid).toBe(false);
  expect(
    result.errors.some((e) => /bad-loop/.test(e) && /completed/.test(e)),
  ).toBe(true);
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run failing test to verify it fails**

Run: `npx vitest run tests/engine/validate.test.ts -t "rejects a repeat block whose until gate exits on completed"`
Expected: FAIL — no such check exists.

- [ ] **Step 3: Implement loop-trivial check in `validate.ts`**

The check needs:
1. The list of `(repeatName, untilGateId)` tuples collected during the walk in Task 3.
2. After roles are loaded, look up each `untilGateId` in the role gates and inspect `evidence.check.field`.

Update `src/engine/validate.ts`. Replace the file body with:

```typescript
import { loadPetriConfig, loadPipelineConfig, loadRole } from "../config/loader.js";
import { isRepeatBlock, type LoadedRole, type StageEntry } from "../types.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateProject(projectDir: string): ValidationResult {
  const errors: string[] = [];

  // 1. Load petri.yaml
  let defaultModel = "default";
  try {
    const petriConfig = loadPetriConfig(projectDir);
    defaultModel = petriConfig.defaults.model;
  } catch (err: unknown) {
    errors.push(`petri.yaml: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Load pipeline.yaml — walk tree, count repeat blocks, collect (repeatName, untilId)
  const roleNames = new Set<string>();
  const repeatBlocks: { name: string; until: string }[] = [];
  try {
    const pipelineConfig = loadPipelineConfig(projectDir);
    function walk(stages: StageEntry[]): void {
      for (const entry of stages) {
        if (isRepeatBlock(entry)) {
          repeatBlocks.push({ name: entry.repeat.name, until: entry.repeat.until });
          walk(entry.repeat.stages);
        } else {
          for (const role of entry.roles) {
            roleNames.add(role);
          }
        }
      }
    }
    walk(pipelineConfig.stages);
    if (repeatBlocks.length === 0) {
      errors.push(
        "pipeline.yaml: pipeline must contain at least one repeat: block (no feedback loop = workflow, not training pipeline)",
      );
    }
  } catch (err: unknown) {
    errors.push(`pipeline.yaml: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Load each role; remember loaded roles for gate lookup in step 4
  const loadedRoles: LoadedRole[] = [];
  for (const name of roleNames) {
    try {
      loadedRoles.push(loadRole(projectDir, name, defaultModel));
    } catch (err: unknown) {
      errors.push(`role "${name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 4. Loop-trivial check: each repeat.until must reference a gate whose
  // evidence.check.field is not literally "completed".
  const gateById = new Map<string, LoadedRole>();
  for (const role of loadedRoles) {
    if (role.gate) gateById.set(role.gate.id, role);
  }
  for (const block of repeatBlocks) {
    const role = gateById.get(block.until);
    if (!role || !role.gate) continue; // missing-gate is a separate concern; don't double-report
    const field = role.gate.evidence.check?.field;
    if (field === "completed") {
      errors.push(
        `pipeline.yaml: repeat block "${block.name}" exits on completed=true (gate "${block.until}") — loop has no real signal, exits after first iteration`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}
```

- [ ] **Step 4: Run new test to confirm it passes**

Run: `npx vitest run tests/engine/validate.test.ts -t "rejects a repeat block whose until gate exits on completed"`
Expected: PASS.

- [ ] **Step 5: Run full validate.test.ts**

Run: `npx vitest run tests/engine/validate.test.ts`
Expected: ALL PASS (including fixture tests and Task 3's new test).

- [ ] **Step 6: Commit**

```bash
git add src/engine/validate.ts tests/engine/validate.test.ts
git commit -m "feat(validate): reject repeat blocks with completed=true exit gate"
```

---

## Task 5: Migrate `tests/cli/create.test.ts` inline pipeline JSON

`VALID_PIPELINE_JSON` and `PLACEHOLDER_JSON` in `tests/cli/create.test.ts` build linear pipelines with `completed: true` gates. Both flows go through `runCreate → generatePipeline → validateProject`, so they will now fail validation (`status: validation_failed`) where the tests expect `status: ok`.

**Files:**
- Modify: `tests/cli/create.test.ts`

- [ ] **Step 1: Update `VALID_PIPELINE_JSON` to use a repeat block + strong gate**

Replace lines 57-83 of `tests/cli/create.test.ts` with:

```typescript
const VALID_PIPELINE_JSON = JSON.stringify({
  "pipeline.yaml": [
    "name: test-pipeline",
    "description: A test pipeline",
    "stages:",
    "  - repeat:",
    "      name: work-loop",
    "      max_iterations: 3",
    "      until: work-approved",
    "      stages:",
    "        - name: work",
    "          roles: [worker]",
    "",
  ].join("\n"),
  "roles/worker/role.yaml": [
    "persona: soul.md",
    "skills: []",
    "",
  ].join("\n"),
  "roles/worker/soul.md": "You are a worker.\n",
  "roles/worker/gate.yaml": [
    "id: work-approved",
    "evidence:",
    "  type: artifact",
    "  path: '{stage}/{role}/output.json'",
    "  check:",
    "    field: approved",
    "    equals: true",
    "",
  ].join("\n"),
});
```

Key changes: `requires: [work-done]` removed (no longer needed; the loop's `until` references the gate); gate id renamed `work-done` → `work-approved`; `field: completed` → `field: approved`; stage wrapped in `repeat:`.

- [ ] **Step 2: Update `PLACEHOLDER_JSON` (line 210-231) the same way**

Replace the `PLACEHOLDER_JSON` definition with:

```typescript
    const PLACEHOLDER_JSON = JSON.stringify({
      "pipeline.yaml": [
        "name: t",
        "stages:",
        "  - repeat:",
        "      name: work-loop",
        "      max_iterations: 3",
        "      until: work-approved",
        "      stages:",
        "        - name: work",
        "          roles: [worker]",
        "",
      ].join("\n"),
      "roles/worker/role.yaml": "persona: soul.md\nskills: []\n",
      "roles/worker/soul.md": "Helper.\n",
      "roles/worker/gate.yaml": [
        "id: work-approved",
        "evidence:",
        "  type: artifact",
        "  path: '{stage}/{role}/output.json'",
        "  check:",
        "    field: approved",
        "    equals: true",
        "",
      ].join("\n"),
    });
```

- [ ] **Step 3: Run create.test.ts to confirm tests pass**

Run: `npx vitest run tests/cli/create.test.ts`
Expected: ALL PASS. The "reports validation errors" test stays green (it's an inline `BROKEN_JSON` that omits the role file — it will fail validation for *both* missing-role and no-repeat reasons, but the test only asserts `output.toContain("validation_failed")` which is still true).

- [ ] **Step 4: Commit**

```bash
git add tests/cli/create.test.ts
git commit -m "test(create): migrate inline pipeline JSON to use repeat block"
```

---

## Task 6: Audit and migrate other tests that flow through `validateProject`

The web API (`src/web/routes/api.ts:271`) calls `validateProject`. The web tests use `stages: []` for some scenarios. The generator tests stub `_result.md` with `name: test\nstages: []`.

**Files:**
- Modify: `tests/engine/generator.test.ts` (audit, possibly update)
- Modify: `tests/web/api.test.ts` (audit, possibly update)

- [ ] **Step 1: Run the full test suite to see exactly what breaks now**

Run: `npx vitest run`
Expected: Failures concentrated in tests that pipe linear pipelines through `validateProject`. **Capture the failing test names for Step 2.**

- [ ] **Step 2: Inspect each failing test and update minimally**

For each failing test:

- If the test's purpose is to exercise validation/lint and a linear pipeline is incidental, replace the inline yaml with a repeat-wrapped equivalent (as in Task 5).
- If the test's purpose is to test web endpoints that *don't* validate (e.g. file CRUD), and the failure is from a different code path, leave alone.

Likely candidates:
- `tests/engine/generator.test.ts:29` — the stub returns `name: test\nstages: []`. Inspect the test to see whether it expects validation success or failure. If success, update to a valid repeat-wrapped pipeline; if failure, keep as-is (it'll now fail for an additional reason but still fail).
- `tests/web/api.test.ts:248` — `stages: []` used as a "do-nothing pipeline" for engine-finishes-immediately tests. Check whether the API path actually invokes `validateProject` here. If yes (e.g. POST /api/runs validates), replace with a minimal valid repeat-wrapped pipeline that still terminates fast (e.g. `max_iterations: 1` and a gate the stub satisfies). If no, leave alone.
- `tests/web/api.test.ts:48,164` — similar audit.

For each test that needs a fix, use this minimal valid pipeline as the template (adjust per-test gate id/field):

```yaml
name: <test-name>
stages:
  - repeat:
      name: only-loop
      max_iterations: 1
      until: <gate-id>
      stages:
        - name: <stage-name>
          roles: [<role>]
```

paired with a role gate like:

```yaml
id: <gate-id>
evidence:
  path: '<stage>/<role>/out.json'
  check:
    field: passed
    equals: true
```

- [ ] **Step 3: Re-run full suite**

Run: `npx vitest run`
Expected: ALL PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/
git commit -m "test: migrate remaining inline pipelines to repeat-wrapped form"
```

---

## Task 7: Rewrite `code-dev` template's `pipeline.yaml`

The template ships with `petri init`. It's the canonical example of a petri pipeline and is also the few-shot in the generator prompt. Both responsibilities require it to use a repeat block.

**Files:**
- Modify: `src/templates/code-dev/pipeline.yaml`

- [ ] **Step 1: Replace pipeline.yaml**

Replace `src/templates/code-dev/pipeline.yaml` with:

```yaml
name: code-dev
description: Software development pipeline — design, then iterate develop+review until approved

stages:
  - name: design
    roles: [designer]
    max_retries: 2

  - repeat:
      name: develop-review-cycle
      max_iterations: 3
      until: review-approved
      stages:
        - name: develop
          roles: [developer]
          max_retries: 5
        - name: review
          roles: [code_reviewer]
          max_retries: 2
```

The `code_reviewer` role's existing `gate.yaml` already has `id: review-approved` with `field: approved, equals: true` (verified at `src/templates/code-dev/roles/code_reviewer/gate.yaml`) — no role-side change needed.

Note: the `designer` role's gate uses `field: completed`, but the `designer` is not used as a `repeat.until` gate (it gates the design stage independently). The loop-trivial check only inspects gates referenced by `repeat.until`, so the designer's `completed` gate is not flagged. **Do not change designer's gate** — its `completed` field is appropriate for a one-shot design stage.

- [ ] **Step 2: Confirm template validates**

A quick sanity check via the existing code-dev fixture used by `petri init` tests, if any. Run:

```bash
npx vitest run tests/cli/init.test.ts 2>/dev/null || true
```

If `init.test.ts` exists and was using the old template, it might now show a different output. Inspect and update assertions if necessary; if the test merely checks "petri init writes the template files", the rewritten YAML is still copied verbatim and the test should still pass.

- [ ] **Step 3: Run full test suite to ensure no regressions**

Run: `npx vitest run`
Expected: ALL PASS.

- [ ] **Step 4: Commit**

```bash
git add src/templates/code-dev/pipeline.yaml
git commit -m "feat(template): rewrite code-dev pipeline with develop-review repeat block"
```

---

## Task 8: Update generator prompt with mandatory-loop rule

The generator's `buildGenerationPrompt` reads the `code-dev` template's `pipeline.yaml` as its few-shot example. After Task 7, that few-shot already shows a `repeat:` block — good. We still need to state the rule explicitly so the LLM doesn't drop it.

**Files:**
- Modify: `src/engine/generator.ts`
- Modify: `tests/engine/generator.test.ts`

- [ ] **Step 1: Write a failing test that asserts the prompt mentions repeat-block requirement**

Add to `tests/engine/generator.test.ts` inside the existing `describe("buildGenerationPrompt", ...)` block (or wherever prompt-content tests live):

```typescript
it("includes the mandatory repeat-block rule and forbids completed=true exit gates", () => {
  const prompt = buildGenerationPrompt("Build something");
  expect(prompt).toMatch(/at least one `repeat:` block/i);
  expect(prompt).toMatch(/must NOT.*completed.*true/i);
});
```

(If `buildGenerationPrompt` is not imported in this test file, add `import { buildGenerationPrompt } from "../../src/engine/generator.js";`.)

- [ ] **Step 2: Run failing test to verify it fails**

Run: `npx vitest run tests/engine/generator.test.ts -t "includes the mandatory repeat-block rule"`
Expected: FAIL — prompt doesn't mention these requirements yet.

- [ ] **Step 3: Add rule 11 to the prompt**

In `src/engine/generator.ts`, find rule 10 (line 102 currently — about language) and append rule 11 after it. Replace:

```
10. Write personas, skills, descriptions, and any free-text in the SAME primary language as the user description below. If the description is mainly Chinese, keep generated prose Chinese; if English, English. Identifiers, YAML keys, and gate ids stay English.
```

with:

```
10. Write personas, skills, descriptions, and any free-text in the SAME primary language as the user description below. If the description is mainly Chinese, keep generated prose Chinese; if English, English. Identifiers, YAML keys, and gate ids stay English.
11. The pipeline MUST contain at least one \`repeat:\` block. Petri is a feedback-loop-driven framework — a pipeline without iteration is not accepted. The \`repeat:\` block's \`until:\` field must reference a strong gate: the gate's \`evidence.check.field\` must NOT be the literal \`completed\` (with \`equals: true\`), because that gate fires the moment the artifact is written and the loop never iterates. Use a meaningful field like \`approved\`, \`tests_passed\`, or a numeric comparator. Wrap whichever stages constitute the iterative work (typically implementation + validation) in the block.
```

- [ ] **Step 4: Run new test to confirm it passes**

Run: `npx vitest run tests/engine/generator.test.ts -t "includes the mandatory repeat-block rule"`
Expected: PASS.

- [ ] **Step 5: Run full generator.test.ts**

Run: `npx vitest run tests/engine/generator.test.ts`
Expected: ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add src/engine/generator.ts tests/engine/generator.test.ts
git commit -m "feat(generator): require repeat block + non-trivial until gate in prompt"
```

---

## Task 9: Extend `PipelineSummary` with hierarchical structure + gate strength

`PipelineSummary` is currently flat: `stages: { name, roles }[]`. The spec requires it to expose loop blocks (`kind: "repeat"`) and per-stage gate strength so `create.ts` can render a topology view.

**Files:**
- Modify: `src/engine/summary.ts`
- Modify: `tests/engine/summary.test.ts`

- [ ] **Step 1: Write failing test for hierarchical summary + gate strength**

Add to `tests/engine/summary.test.ts`:

```typescript
it("exposes repeat blocks as hierarchical entries with gate strength", () => {
  writeTree(tmp, {
    "pipeline.yaml":
      "name: code-dev\n" +
      "stages:\n" +
      "  - name: design\n" +
      "    roles: [designer]\n" +
      "  - repeat:\n" +
      "      name: dev-review\n" +
      "      max_iterations: 3\n" +
      "      until: review-approved\n" +
      "      stages:\n" +
      "        - name: develop\n" +
      "          roles: [developer]\n" +
      "        - name: review\n" +
      "          roles: [reviewer]\n",
    "roles/designer/role.yaml": "persona: soul.md\nskills: []\n",
    "roles/designer/soul.md": "Designer.\n",
    "roles/designer/gate.yaml":
      "id: design-complete\n" +
      "evidence:\n" +
      "  path: 'design/designer/d.json'\n" +
      "  check:\n" +
      "    field: completed\n" +
      "    equals: true\n",
    "roles/developer/role.yaml": "persona: soul.md\nskills: []\n",
    "roles/developer/soul.md": "Developer.\n",
    "roles/developer/gate.yaml":
      "id: tests-pass\n" +
      "evidence:\n" +
      "  path: 'develop/developer/t.json'\n" +
      "  check:\n" +
      "    field: tests_passed\n" +
      "    equals: true\n",
    "roles/reviewer/role.yaml": "persona: soul.md\nskills: []\n",
    "roles/reviewer/soul.md": "Reviewer.\n",
    "roles/reviewer/gate.yaml":
      "id: review-approved\n" +
      "evidence:\n" +
      "  path: 'review/reviewer/r.json'\n" +
      "  check:\n" +
      "    field: approved\n" +
      "    equals: true\n",
  });

  const summary = buildPipelineSummary(tmp)!;
  expect(summary.stages).toHaveLength(2);

  const design = summary.stages[0];
  expect(design.kind).toBe("stage");
  expect(design.name).toBe("design");
  expect(design.roles).toEqual(["designer"]);
  expect(design.gateStrength).toBe("weak"); // field = "completed"

  const loop = summary.stages[1];
  expect(loop.kind).toBe("repeat");
  expect(loop.repeatName).toBe("dev-review");
  expect(loop.maxIterations).toBe(3);
  expect(loop.until).toBe("review-approved");
  expect(loop.innerStages).toHaveLength(2);
  expect(loop.innerStages![0].name).toBe("develop");
  expect(loop.innerStages![0].gateStrength).toBe("strong"); // tests_passed
  expect(loop.innerStages![1].gateStrength).toBe("strong"); // approved
});
```

Also update the existing first test ("returns name, goal, stages, and roles with persona snippets") to match the new shape. Replace the assertion:

```typescript
expect(summary!.stages).toEqual([
  { name: "design", roles: ["designer"] },
  { name: "develop", roles: ["developer"] },
]);
```

with:

```typescript
expect(summary!.stages).toHaveLength(2);
expect(summary!.stages[0]).toMatchObject({ kind: "stage", name: "design", roles: ["designer"] });
expect(summary!.stages[1]).toMatchObject({ kind: "stage", name: "develop", roles: ["developer"] });
```

(The `roleStrength` etc. are not asserted because that test's fixture has no gate.yaml; `gateStrength` will be `"none"`.)

Update the long-persona test similarly: change

```typescript
"pipeline.yaml": "name: t\nstages:\n  - name: s\n    roles: [r]\n",
```

(no change needed — but the assertion on `summary.roles[0]` doesn't touch `stages`, so it still passes once the underlying type allows the new shape.)

- [ ] **Step 2: Run failing tests to confirm they fail**

Run: `npx vitest run tests/engine/summary.test.ts`
Expected: FAIL — old shape doesn't have `kind`/`gateStrength`/`innerStages`.

- [ ] **Step 3: Rewrite `summary.ts`**

Replace `src/engine/summary.ts` with:

```typescript
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

export interface PipelineSummaryRole {
  name: string;
  personaFirstLine: string;
  skills: string[];
}

export type GateStrength = "strong" | "weak" | "none";

export interface StageSummary {
  kind: "stage" | "repeat";
  // For "stage":
  name?: string;
  roles?: string[];
  gateStrength?: GateStrength;
  gateCheck?: string;
  // For "repeat":
  repeatName?: string;
  maxIterations?: number;
  until?: string;
  innerStages?: StageSummary[];
}

export interface PipelineSummary {
  name: string;
  goal?: string;
  description?: string;
  stages: StageSummary[];
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

interface RoleGateInfo {
  strength: GateStrength;
  check: string; // human-readable: "approved = true (strong)" or "no gate"
}

function loadRoleGateInfo(generatedDir: string, roleName: string): RoleGateInfo {
  const gatePath = path.join(generatedDir, "roles", roleName, "gate.yaml");
  if (!fs.existsSync(gatePath)) return { strength: "none", check: "no gate" };
  let parsed: any;
  try {
    parsed = parseYaml(fs.readFileSync(gatePath, "utf-8"));
  } catch {
    return { strength: "none", check: "gate.yaml unparseable" };
  }
  const ev = parsed?.evidence;
  if (!ev || typeof ev !== "object") return { strength: "none", check: "no evidence" };
  const check = ev.check;
  if (!check || typeof check !== "object") {
    return { strength: "weak", check: "file-existence only" };
  }
  const field = typeof check.field === "string" ? check.field : "?";
  // Strength heuristic per spec: only `field == "completed"` with `equals: true` is weak.
  // Any other comparator/field is strong.
  let strength: GateStrength = "strong";
  let renderedCheck: string;
  if ("equals" in check) {
    renderedCheck = `${field} = ${JSON.stringify(check.equals)}`;
    if (field === "completed" && check.equals === true) strength = "weak";
  } else if ("gt" in check) {
    renderedCheck = `${field} > ${check.gt}`;
  } else if ("lt" in check) {
    renderedCheck = `${field} < ${check.lt}`;
  } else if ("in" in check) {
    renderedCheck = `${field} in ${JSON.stringify(check.in)}`;
  } else {
    renderedCheck = `${field} (no comparator)`;
    strength = "weak";
  }
  return { strength, check: renderedCheck };
}

function summarizeStages(generatedDir: string, raw: any[]): { stages: StageSummary[]; roleNames: Set<string> } {
  const out: StageSummary[] = [];
  const roleNames = new Set<string>();
  for (const entry of raw ?? []) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.repeat && typeof entry.repeat === "object") {
      const r = entry.repeat;
      const inner = summarizeStages(generatedDir, Array.isArray(r.stages) ? r.stages : []);
      for (const n of inner.roleNames) roleNames.add(n);
      out.push({
        kind: "repeat",
        repeatName: typeof r.name === "string" ? r.name : undefined,
        maxIterations: typeof r.max_iterations === "number" ? r.max_iterations : undefined,
        until: typeof r.until === "string" ? r.until : undefined,
        innerStages: inner.stages,
      });
      continue;
    }
    if (typeof entry.name !== "string") continue;
    const roles = Array.isArray(entry.roles)
      ? entry.roles.filter((x: unknown) => typeof x === "string")
      : [];
    for (const r of roles) roleNames.add(r);
    // Gate strength = strongest among the stage's roles.
    let strength: GateStrength = "none";
    let renderedCheck: string | undefined;
    for (const r of roles) {
      const info = loadRoleGateInfo(generatedDir, r);
      if (info.strength === "strong" || (info.strength === "weak" && strength === "none")) {
        strength = info.strength;
        renderedCheck = info.check;
      }
    }
    out.push({
      kind: "stage",
      name: entry.name,
      roles,
      gateStrength: strength,
      gateCheck: renderedCheck,
    });
  }
  return { stages: out, roleNames };
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

  const { stages, roleNames } = summarizeStages(generatedDir, pipeline.stages ?? []);

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
    } catch { /* role.yaml missing or malformed */ }

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
Expected: ALL PASS.

- [ ] **Step 5: Run full suite (other tests may import `PipelineSummary` shape)**

Run: `npx vitest run`
Expected: ALL PASS. The `create.ts` rendering still uses old fields — it'll either compile-error or produce wrong output. Both will be fixed in Task 10.

If TypeScript fails to compile because `create.ts` references the old flat `PipelineSummaryStage` shape (specifically `s.name.padEnd(...)` etc.), proceed to Task 10 immediately — that's the next planned change.

- [ ] **Step 6: Commit**

```bash
git add src/engine/summary.ts tests/engine/summary.test.ts
git commit -m "feat(summary): hierarchical stages with gate strength"
```

---

## Task 10: Update `create.ts` rendering for hierarchical flow + gate strength

`create.ts:100-109` renders the flow as a flat numbered list. Update it to walk `StageSummary[]` recursively, render `repeat:` blocks with `↻ <name> (max N, until <gate>):` and indented inner stages, and append a per-stage strength tag (`🟢` strong, `⚪ ... (weak)`, blank for none).

**Files:**
- Modify: `src/cli/create.ts`
- Modify: `tests/cli/create.test.ts`

- [ ] **Step 1: Write a failing test that asserts the new flow output**

Add to `tests/cli/create.test.ts` inside the main describe block:

```typescript
it("renders repeat blocks with ↻ and gate strength tags", async () => {
  const { runCreate } = await import("../../src/cli/create.js");
  const provider = makeStubProvider(VALID_PIPELINE_JSON);

  await runCreate(
    { description: "Build a worker pipeline" },
    provider,
    tmpDir,
  );

  const output = lines.join("\n");
  // VALID_PIPELINE_JSON wraps the worker stage in a repeat block named "work-loop"
  // exiting on "work-approved" with field "approved" (strong).
  expect(output).toContain("↻");
  expect(output).toContain("work-loop");
  expect(output).toContain("until work-approved");
  // Strong gate tag should render somewhere on the inner stage line.
  expect(output).toMatch(/approved.*=.*true/);
});
```

- [ ] **Step 2: Run failing test**

Run: `npx vitest run tests/cli/create.test.ts -t "renders repeat blocks"`
Expected: FAIL — old renderer doesn't emit `↻`.

- [ ] **Step 3: Add `StageSummary` to the existing summary import**

In `src/cli/create.ts`, change the existing summary import (line 5):

```typescript
import { buildPipelineSummary } from "../engine/summary.js";
```

to:

```typescript
import { buildPipelineSummary, type StageSummary } from "../engine/summary.js";
```

- [ ] **Step 4: Replace the Flow rendering block in `create.ts`**

In `src/cli/create.ts`, replace the Flow block (currently lines 100-109).

Find this:

```typescript
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
```

Replace with:

```typescript
    if (summary.stages.length > 0) {
      console.log();
      console.log(chalk.bold("Flow:"));
      const circles = ["①","②","③","④","⑤","⑥","⑦","⑧","⑨"];
      let counter = 0;
      const strengthTag = (s: StageSummary): string => {
        if (s.gateStrength === "strong") return chalk.green(`🟢 ${s.gateCheck ?? ""} (strong)`);
        if (s.gateStrength === "weak")   return chalk.yellow(`⚪ ${s.gateCheck ?? ""} (weak)`);
        return chalk.gray("(no gate)");
      };
      const renderStage = (s: StageSummary, indent: string): void => {
        if (s.kind === "repeat") {
          const name = s.repeatName ?? "(loop)";
          const max = s.maxIterations ?? "?";
          const until = s.until ?? "?";
          console.log(`${indent}${chalk.cyan("↻")} ${name} (max ${max}, until ${until}):`);
          for (const inner of s.innerStages ?? []) {
            renderStage(inner, indent + "  ");
          }
          return;
        }
        counter += 1;
        const tag = circles[counter - 1] ?? `(${counter})`;
        const stageName = (s.name ?? "?").padEnd(20);
        const roles = (s.roles ?? []).join(", ");
        console.log(`${indent}${tag} ${stageName} →  ${roles.padEnd(16)} ${strengthTag(s)}`);
      };
      for (const s of summary.stages) {
        renderStage(s, "  ");
      }
    }
```

- [ ] **Step 5: Run new test to confirm it passes**

Run: `npx vitest run tests/cli/create.test.ts -t "renders repeat blocks"`
Expected: PASS.

- [ ] **Step 6: Run full create.test.ts**

Run: `npx vitest run tests/cli/create.test.ts`
Expected: ALL PASS. The pre-existing `expect(output).toContain("worker")` test still passes — `worker` appears in the role list in the rendered flow.

- [ ] **Step 7: Run full suite**

Run: `npx vitest run`
Expected: ALL PASS.

- [ ] **Step 8: Commit**

```bash
git add src/cli/create.ts tests/cli/create.test.ts
git commit -m "feat(create): render repeat blocks and gate strength in flow view"
```

---

## Task 11: End-to-end verification + manual smoke

Final cross-check: every spec section is implemented, the full suite is green, and a manual `petri create` shows the new output.

**Files:**
- None modified.

- [ ] **Step 1: Run the entire test suite**

Run: `npx vitest run`
Expected: ALL PASS, no skipped tests outside of pre-existing skips.

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Manual smoke — generate a pipeline and inspect the output**

Build a fresh project in a temp dir, run `petri create`, and inspect the output for the new topology view.

```bash
TMP=$(mktemp -d)
cd "$TMP"
node /Users/xupeng/dev/github/petri/dist/cli/index.js init
# Edit petri.yaml as needed for whichever provider is configured locally,
# or skip create if no provider is wired up — verify init's template files instead:
cat pipeline.yaml
```

Expected: `pipeline.yaml` shows `repeat:` block wrapping develop+review (the new code-dev template).

- [ ] **Step 4: Spec checklist self-review**

Walk through `docs/superpowers/specs/2026-05-03-feedback-loop-required-design.md` section by section. For each numbered scope item, point to the task above that implements it:

- §1 `validate.ts` requireFeedbackLoop — Task 3
- §1 loop-trivial check — Task 4
- §2 `code-dev/pipeline.yaml` rewrite — Task 7
- §3 generator prompt rule + few-shot — Task 8 (rule), Task 7 (few-shot, since the prompt reads the template)
- §4 `PipelineSummary` extension — Task 9
- §4 `create.ts` rendering — Task 10
- §5 lint.ts no-changes — confirmed (no task touches it)
- §6 test fixture migration — Tasks 1, 2, 5, 6
- §7 generator stub provider — Task 5

If any section has no corresponding task: stop and add a remediation task before claiming done.

- [ ] **Step 5: Final commit and branch state check**

```bash
git status
git log --oneline -15
```

Expected: clean tree, recent commits visible matching tasks 1-10.

---

## Self-Review Notes

**Type consistency check:**
- `StageSummary.kind: "stage" | "repeat"` is used consistently in summary.ts (Task 9) and create.ts (Task 10).
- `gateStrength: "strong" | "weak" | "none"` matches between summary.ts and create.ts.
- `LoadedRole` import in validate.ts (Task 4) matches the existing export in `src/types.ts`.

**Placeholder scan:** None — every code block is complete and ready to paste.

**Ordering rationale:**
- Fixtures first (Tasks 1, 2) so the existing fixture-based tests still pass when validation tightens.
- Validation second (Tasks 3, 4) — this is the load-bearing behavior change. Subsequent tasks all depend on the suite being green after this.
- Test migration third (Tasks 5, 6) — fix any tests that linear-pipeline-cascade-broke.
- Template + prompt fourth (Tasks 7, 8) — the user-visible defaults.
- Topology view last (Tasks 9, 10) — pure presentation, not load-bearing for the rule.
- Verification (Task 11) — proof.
