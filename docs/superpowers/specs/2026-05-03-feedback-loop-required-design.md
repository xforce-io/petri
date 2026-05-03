# Feedback-Loop-Required Pipeline — Design Spec

Petri's identity is a multi-role *training* framework, not a workflow runner. A pipeline without any feedback loop has no optimization signal — each role's artifact ships as-is, downstream evaluation never feeds back. That degenerates into a linear DAG which adds stage-orchestration overhead without using petri's core mechanic. This spec makes feedback loops a structural requirement: every pipeline must contain at least one `repeat:` block, enforced by validation. No linear mode, no opt-out flag.

## Decisions

- **Hard rule, no escape hatch.** A pipeline with zero `repeat:` blocks is rejected by `validateProject` as a pipeline-level error. No `--one-shot`, no `mode: linear`, no per-config override. Reduces framework surface area; keeps petri's identity sharp.
- **Existing linear fixtures and templates are migrated, not grandfathered.** The `code-dev` template is rewritten to include a `repeat:` block. Test fixtures that don't already wrap stages in `repeat:` are updated to comply.
- **Topology visibility ships alongside.** `petri create`'s summary block is extended to show gate strength (per role) and loop structure (the `repeat:` blocks and their `until` gates). This is the user-facing signal that the rule is being honored.
- **Generator prompt mandates a `repeat:` block.** The few-shot example shows one. The rule is stated explicitly. Generated pipelines without one fail validation and trigger the existing retry loop.
- **Out of scope:** `petri revise` (incremental refinement command) is its own spec — not blocked by this one but addressed separately.

## What "feedback loop" means in petri

A `repeat:` block (already a first-class type in `src/types.ts:25-32`):

```yaml
- repeat:
    name: <block-name>
    max_iterations: <int>
    until: <gate-id>     # exit when this gate passes
    stages: [<StageEntry>...]
```

The block re-runs its inner stages until the `until` gate passes (success exit) or `max_iterations` is hit (failure exit). The `until` gate must be a strong gate — i.e. `evidence.check` with a real comparator (`gt`/`lt`/`equals` against a meaningful field), not `completed: true`. A loop with `completed: true` as the exit condition has no signal: the moment the role writes a file, the gate passes — the loop never iterates. **Validation enforces this as a hard error**: the `until` gate's check field must not be the literal string `completed`. A loop that exits on a self-report boolean isn't a loop.

A pipeline can mix non-loop stages with `repeat:` blocks freely. Common shape:

```
setup-stage  →  repeat(work, evaluate)  →  publish-stage
```

The rule is "≥1 `repeat:` block somewhere in the pipeline tree", not "everything wrapped". Nested `repeat:` blocks count — a single inner block satisfies the requirement, no matter how deeply nested.

## Scope of changes

### 1. `src/engine/validate.ts` — add `requireFeedbackLoop` check

After the existing pipeline.yaml load (`validateProject`, line 22-39), traverse the parsed `pipeline.stages` recursively. If no `RepeatBlock` is found anywhere in the tree, push:

```
pipeline.yaml: pipeline must contain at least one repeat: block (no feedback loop = workflow, not training pipeline)
```

into `errors`. Same severity as missing-role and yaml-parse errors.

A second hard check, same severity as the first: each `repeat:` block's `until` gate must resolve to a gate whose `evidence.check.field` is not literally `completed`. Otherwise the loop has no real exit signal — the gate fires the moment the artifact is written. Error message:

```
pipeline.yaml: repeat block <name> exits on completed=true (gate <gate-id>) — loop has no real signal, exits after first iteration
```

Both checks live in `validateProject` and surface as `errors`, not `concerns`. The corresponding lint concern (`loop-trivial`) is therefore not added — `lint.ts` is unchanged.

### 2. `src/templates/code-dev/pipeline.yaml` — rewrite with loop

New shape:

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

The `code_reviewer` role's gate already checks `approved: true` (template `roles/code_reviewer/gate.yaml`), so the `until: review-approved` clause uses an existing strong-gate id — no new gates needed. The developer's existing `tests-pass` gate continues to apply per-attempt within develop stage.

This change makes `petri init`'s output a working example of petri's intended use, not a workflow placeholder.

### 3. `src/engine/generator.ts` — prompt + retry coverage

Append to the rules block in `buildGenerationPrompt`:

> 11. The pipeline MUST contain at least one `repeat:` block. Petri is a feedback-loop-driven framework — a pipeline without iteration is a workflow and not accepted. The `repeat:` block's `until:` field must reference a strong gate (numeric or non-trivial check, not `completed: true`). Wrap whichever stages constitute the iterative work (typically implementation + validation) in the block.

Add the loop construct to the few-shot pipeline.yaml example so the LLM has a concrete pattern to copy. Use the same shape as the new `code-dev` template above.

The existing retry mechanism already handles "validation failed" by injecting errors and re-prompting, so generated pipelines without a loop will fail validation, trigger retry, and the LLM gets the explicit error message ("must contain at least one repeat: block") to fix on the next attempt. No new retry plumbing.

### 4. `src/engine/summary.ts` + `src/cli/create.ts` — topology view

Extend `PipelineSummary` (`summary.ts:16-22`) to expose:

```typescript
interface PipelineSummary {
  name: string;
  goal?: string;
  description?: string;
  stages: StageSummary[];   // hierarchical: includes repeat blocks
  roles: PipelineSummaryRole[];
}

interface StageSummary {
  kind: "stage" | "repeat";
  // For "stage":
  name?: string;
  roles?: string[];
  gateStrength?: "strong" | "weak" | "none";
  gateCheck?: string;       // human-readable: "annual_return > 0.09" or "completed = true (weak)"
  // For "repeat":
  repeatName?: string;
  maxIterations?: number;
  until?: string;
  innerStages?: StageSummary[];
}
```

Gate strength derivation:

| Condition | Strength |
|---|---|
| No `gate.yaml` | `none` |
| `gate.yaml` has `evidence.path` but no `evidence.check` | `weak` (file-existence only) |
| `evidence.check.field == "completed"` and `equals == true` | `weak` (boolean self-report) |
| Any other `evidence.check` (`gt`/`lt`/`in`/numeric `equals`/non-`completed` field) | `strong` |

Heuristic limitation worth flagging: `equals: true` on any boolean field (e.g. `approved`, `passed`) is classified `strong` because the field name carries semantic intent — it's not for the topology view to second-guess. This means the `code-dev` template's `review-approved` gate (`approved == true`) is rendered as `strong`, even though structurally it's the same shape as `completed == true`. Trade-off: simpler heuristic, fewer false-strong labels in practice. If overclassification becomes a problem in dogfooding, tighten by maintaining an explicit "weak boolean" allowlist.

`create.ts` rendering:

```
Pipeline: <name>
Goal:     <goal-or-desc>

Flow:
  ① design                    →  designer        ⚪ approved = true (weak)
  ↻ develop-review-cycle (max 3, until review-approved):
    ② develop                 →  developer       🟢 tests_passed = true (strong)
    ③ review                  →  code_reviewer   🟢 approved = true (strong)
```

Loop blocks render with `↻` and indented inner stages. Outside-loop stages keep the `①②③` numbering across the whole tree.

### 5. `src/engine/lint.ts` — no changes

Both "no loop" and "loop-trivial" are validation hard-errors (in `validate.ts`), not lint concerns. Existing concerns (`coverage` skip-for-CN, `gate` path-only advisory) stay as-is.

### 6. Test fixture migration

Audit (already done — no `repeat:` in any of these):

- `tests/fixtures/valid-project/pipeline.yaml` — single linear stage. Rewrite to wrap `work` in a `repeat:` block with a meaningful `until`. The fixture's `worker` role's gate id needs to be a strong gate; if it doesn't have one, add it.
- `tests/fixtures/missing-role/pipeline.yaml` — likely needs equivalent treatment.
- Any test in `tests/cli/create.test.ts`, `tests/engine/{engine,summary,validate,generator,lint}.test.ts`, `tests/web/api.test.ts`, `tests/config/loader.test.ts` that constructs a linear pipeline inline must add a `repeat:` block — even when the test is unrelated to validation, because the same `validateProject` runs throughout.

Test cases that specifically need the migration:
- `create.test.ts` — `VALID_PIPELINE_JSON` (line 57-83) is linear; rewrite to nest `work` in repeat.
- `engine.test.ts` — most tests already use repeat blocks (per `git log` they were written that way); audit for any linear holdouts.

### 7. Generator's stub provider in tests

`makeStubProvider` in `create.test.ts` returns a hardcoded JSON. Update its `VALID_PIPELINE_JSON` to include a `repeat:` block. This will surface any cascading test breakage.

## Validation flow after this spec

1. User runs `petri create --from goal.md`.
2. Generator builds prompt with mandatory-loop rule + few-shot example with `repeat:`.
3. LLM produces JSON file map.
4. Files written to `.petri/generated/`.
5. `validateProject` runs: gate-schema check (existing) + loop-required check (new).
6. If no loop → `errors` includes "pipeline must contain at least one repeat: block" → retry triggered.
7. After ≤3 retries, success or final failure with the error in output.
8. Lint runs: existing concerns only (no new concerns added by this spec).
9. `create.ts` prints topology view: stages + loop blocks + per-gate strength tags.

## Failure modes

- **LLM emits a `repeat:` block whose `until` gate doesn't exist**: existing pipeline-level requirements check catches it (each `requirements:` entry must match a gate id). No new logic needed; the validation error message is already informative.
- **LLM emits a `repeat:` block whose `until` gate is `completed: true`**: hard fails validation with the `loop-trivial` error, retry triggered. Test fixtures that previously relied on `completed`-based exit gates must be rewritten to use a real signal (e.g. `approved: true`, numeric comparator, or a non-`completed` boolean).
- **All-stage `max_retries` is 0 inside a repeat block**: each iteration's stages can only succeed first try. Not a new failure mode; existing engine behavior preserves correctness.
- **Migration: existing user pipelines without `repeat:`**: hard fail with a clear error message pointing to this spec / docs. The framework is 0.x and on a feature branch — this is acceptable. Document in CHANGELOG when version is cut.

## Out of scope

- `petri revise` (incremental refinement). Will be its own spec; depends on this one to define what "valid pipeline" means but doesn't block it.
- Generator inferring loop boundaries from description semantics ("which stages should be inside the loop"). Spec only requires that *some* loop exists; the LLM uses few-shot to pick a sensible boundary.
- Retroactive enforcement on already-running engine sessions (manifest replay). The engine doesn't validate at runtime; only `petri validate` and `petri create`'s post-generation step run validation.

## Migration impact summary

| Surface | Change | Breaking? |
|---|---|---|
| `code-dev` template | rewritten with repeat | Yes — but template is only consumed at `petri init` |
| Existing user pipelines without repeat | now fail validation | Yes — by design, no compat path |
| Test fixtures | rewritten | Internal |
| API surface (`PipelineSummary`) | extended fields | Backward-compatible additions only |
| CLI output | new topology format | Visual change only |
