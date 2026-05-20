# Command Stage Output Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a `command` stage declare an optional gate on its output, so a deterministic measurement (e.g. a backtest) produces a pass/fail verdict and can drive a `repeat` loop's `until:` condition.

**Architecture:** `CommandStage` gains an optional inline `gate: GateConfig`. After the command exits 0, `runCommandStage` evaluates that gate with the existing `checkGates` function, records the result in the engine's `gateResults` registry (so it can satisfy a `repeat` block's `until:`), and returns `blocked` if the gate fails. Command stages never retry — re-running a deterministic command yields the same result.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), vitest.

**Source spec:** `docs/superpowers/specs/2026-05-20-petri-evolution-model-design.md` — this plan covers the "`command` stage output可被 gate 检查" item only. `branch.yaml` v2 and the guardrail subsystem are separate later plans.

**Prerequisite:** The "Command Stage" plan (`2026-05-20-command-stage.md`) is already merged — `CommandStage`, `isCommandStage`, `runCommandStage`, and the validator's command-stage branch all exist.

**Convention:** Commit messages end with the repo's standard `Co-Authored-By:` trailer.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/types.ts` | modify | Add optional `gate?: GateConfig` to `CommandStage` |
| `src/engine/engine.ts` | modify | `runCommandStage` evaluates the gate after the command succeeds; records it in `gateResults`; returns `blocked` on gate failure |
| `src/engine/validate.ts` | modify | Validate a command stage's inline `gate` (structural: `id`, `evidence.path`) |
| `tests/types.test.ts` | modify | Test `CommandStage` accepts a `gate` |
| `tests/engine/engine.test.ts` | modify | Tests for gated command stages — linear pass/fail and as a repeat `until:` gate |
| `tests/engine/validate.test.ts` | modify | Test validation of a malformed command-stage gate |

---

## Task 1: `CommandStage.gate` field

**Files:**
- Modify: `src/types.ts`
- Test: `tests/types.test.ts`

- [ ] **Step 1: Write the failing test**

Append this test inside the `describe("isCommandStage", ...)` block in `tests/types.test.ts`:

```typescript
  it("accepts a command stage carrying an optional gate", () => {
    const entry: CommandStage = {
      name: "measure",
      command: "python run.py",
      gate: {
        id: "measured",
        evidence: { path: "{stage}/result.json", check: { field: "ok", equals: true } },
      },
    };
    expect(isCommandStage(entry)).toBe(true);
    expect(entry.gate?.id).toBe("measured");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/types.test.ts`
Expected: FAIL — TypeScript error: `gate` does not exist on type `CommandStage`.

- [ ] **Step 3: Add the field**

In `src/types.ts`, the `CommandStage` interface currently is:

```typescript
export interface CommandStage {
  name: string;
  command: string;       // shell command; "{artifact_dir}" is substituted at run time
  timeout?: number;      // max wall-clock ms (default: engine defaultTimeout)
}
```

Add a `gate` field so it becomes:

```typescript
export interface CommandStage {
  name: string;
  command: string;       // shell command; "{artifact_dir}" is substituted at run time
  timeout?: number;      // max wall-clock ms (default: engine defaultTimeout)
  gate?: GateConfig;     // optional pass/fail check on the command's output artifacts
}
```

(`GateConfig` is already defined later in the same file — interface field order does not matter to TypeScript.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/types.test.ts`
Expected: PASS (all `isCommandStage` tests).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts tests/types.test.ts
git commit -m "feat(types): add optional gate to CommandStage"
```

---

## Task 2: Engine evaluates the command-stage gate

**Files:**
- Modify: `src/engine/engine.ts`
- Test: `tests/engine/engine.test.ts`

- [ ] **Step 1: Write the failing tests**

Append these tests inside the `describe("Engine", ...)` block in `tests/engine/engine.test.ts`:

```typescript
  it("a command stage with a passing gate completes the run", async () => {
    const pipeline: PipelineConfig = {
      name: "gated-cmd",
      stages: [
        {
          name: "measure",
          command: "echo '{\"ok\": true}' > {artifact_dir}/result.json",
          gate: {
            id: "measured",
            evidence: { path: "{stage}/result.json", check: { field: "ok", equals: true } },
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
    expect(result.status).toBe("done");
  });

  it("a command stage with a failing gate blocks the run", async () => {
    const pipeline: PipelineConfig = {
      name: "gated-cmd",
      stages: [
        {
          name: "measure",
          command: "echo '{\"ok\": false}' > {artifact_dir}/result.json",
          gate: {
            id: "measured",
            evidence: { path: "{stage}/result.json", check: { field: "ok", equals: true } },
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
    expect(result.stage).toBe("measure");
    expect(result.reason).toMatch(/ok/);
  });

  it("a command stage gate satisfies a repeat block's until condition", async () => {
    const pipeline: PipelineConfig = {
      name: "gated-cmd-repeat",
      stages: [
        {
          repeat: {
            name: "loop",
            max_iterations: 3,
            until: "measured",
            stages: [
              {
                name: "measure",
                command: "echo '{\"ok\": true}' > {artifact_dir}/result.json",
                gate: {
                  id: "measured",
                  evidence: { path: "{stage}/result.json", check: { field: "ok", equals: true } },
                },
              },
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
    expect(result.status).toBe("done");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/engine/engine.test.ts -t "gate"`
Expected: FAIL — `runCommandStage` ignores `stage.gate`; the gated-cmd tests do not get the expected `done`/`blocked` outcomes (e.g. the failing-gate test sees `done`).

- [ ] **Step 3: Evaluate the gate in `runCommandStage`**

In `src/engine/engine.ts`, the `runCommandStage` method currently ends like this:

```typescript
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

Replace everything from the `console.log(`  Command stage "${stage.name}" completed`);` line through the closing `}` of the method with:

```typescript
    // The command ran. If it declares a gate, evaluate it against the output.
    if (stage.gate) {
      const gateResult = await checkGates(
        [{ gate: stage.gate, roleName: stage.name }],
        stage.name,
        this.artifactBaseDir,
        "all",
      );
      for (const detail of gateResult.details) {
        this.gateResults.set(detail.gateId, detail);
      }
      this.logger?.logGateResult(stage.name, gateResult.passed, gateResult.reason);
      if (!gateResult.passed) {
        const detail = gateResult.details
          .filter((d) => !d.passed)
          .map((d) => d.reason)
          .join("; ");
        const reason = detail || gateResult.reason;
        console.log(`  Command stage "${stage.name}" gate FAILED: ${reason}`);
        return { status: "blocked", stage: stage.name, reason };
      }
    }

    console.log(`  Command stage "${stage.name}" completed`);
    return { status: "done" };
  }
```

`checkGates`, `resolveGatePath`, and the `GateInput` type are already imported at the top of `engine.ts` (`import { checkGates, resolveGatePath, type GateInput, type GateDetail } from "./gate.js";`) — no new imports are needed. `this.gateResults` and `this.logger` are existing `Engine` fields.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/engine/engine.test.ts`
Expected: PASS — all Engine tests, including the 3 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/engine/engine.ts tests/engine/engine.test.ts
git commit -m "feat(engine): evaluate the gate on a command stage's output"
```

---

## Task 3: Validate the inline command-stage gate

**Files:**
- Modify: `src/engine/validate.ts`
- Test: `tests/engine/validate.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/engine/validate.test.ts` already has a `writeFixture(files: Record<string, string>): string` helper and a `MIN_PETRI` constant (a minimal valid `petri.yaml`) — its existing command-stage tests use them. Append these two tests following that same pattern:

```typescript
  it("accepts a command stage with a well-formed gate", () => {
    const dir = writeFixture({
      "petri.yaml": MIN_PETRI,
      "pipeline.yaml": "name: gated\nstages:\n  - name: measure\n    command: python run.py\n    gate:\n      id: measured\n      evidence:\n        path: \"{stage}/result.json\"\n",
    });
    const result = validateProject(dir);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects a command stage gate missing evidence.path", () => {
    const dir = writeFixture({
      "petri.yaml": MIN_PETRI,
      "pipeline.yaml": "name: bad-gate\nstages:\n  - name: measure\n    command: python run.py\n    gate:\n      id: measured\n",
    });
    const result = validateProject(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/command stage "measure" gate must have "evidence.path"/);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/engine/validate.test.ts -t "gate"`
Expected: FAIL — the malformed-gate pipeline is currently accepted (the validator does not inspect a command stage's `gate`).

- [ ] **Step 3: Import `GateConfig`**

In `src/engine/validate.ts`, the types import currently is:

```typescript
import { isRepeatBlock, isCommandStage, type GateCheck, type GateCheckClause, type LoadedRole, type StageEntry } from "../types.js";
```

Add `GateConfig`:

```typescript
import { isRepeatBlock, isCommandStage, type GateCheck, type GateCheckClause, type GateConfig, type LoadedRole, type StageEntry } from "../types.js";
```

- [ ] **Step 4: Validate the gate in the command-stage branch**

In `src/engine/validate.ts`, the `walk()` function has an `else if (isCommandStage(entry))` branch. It currently is:

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
```

Add gate validation before `commandStageCount++;`, so the branch becomes:

```typescript
        } else if (isCommandStage(entry)) {
          const cmdName = typeof entry.name === "string" && entry.name.length > 0 ? entry.name : "(unnamed)";
          if (typeof entry.name !== "string" || entry.name.length === 0) {
            errors.push(`pipeline.yaml: command stage missing required "name" field (string)`);
          }
          if (typeof entry.command !== "string" || entry.command.length === 0) {
            errors.push(`pipeline.yaml: command stage "${cmdName}" missing required "command" field (non-empty string)`);
          }
          if (entry.gate !== undefined) {
            const g = entry.gate as Partial<GateConfig>;
            if (!g || typeof g !== "object" || typeof g.id !== "string" || g.id.length === 0) {
              errors.push(`pipeline.yaml: command stage "${cmdName}" gate must have a non-empty string "id"`);
            }
            if (!g || typeof g !== "object" || !g.evidence || typeof g.evidence !== "object" || typeof g.evidence.path !== "string" || g.evidence.path.length === 0) {
              errors.push(`pipeline.yaml: command stage "${cmdName}" gate must have "evidence.path" (string)`);
            }
          }
          commandStageCount++;
        } else {
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/engine/validate.test.ts`
Expected: PASS — all validate tests, including the 2 new ones.

- [ ] **Step 6: Full verification**

Run: `npx tsc --noEmit`
Expected: the ONLY error is the pre-existing `src/web/routes/sse.ts(37,7): 'logger' is possibly 'undefined'`. Any other error is a regression — fix it.

Run: `npm test`
Expected: the full vitest suite passes with no failures.

- [ ] **Step 7: Commit**

```bash
git add src/engine/validate.ts tests/engine/validate.test.ts
git commit -m "feat(validate): validate a command stage's inline gate"
```

---

## Manual verification

A gated command stage, end to end, in a scratch petri project:

```yaml
# pipeline.yaml
name: smoke
stages:
  - name: measure
    command: "echo '{\"ok\": true}' > {artifact_dir}/result.json"
    gate:
      id: measured
      evidence:
        path: "{stage}/result.json"
        check: { field: ok, equals: true }
```

`petri validate` → valid. `petri run` → run `done` (flip `true`→`false` in the command → run `blocked` at stage `measure`).

---

## Out of scope (later plans)

- `branch.yaml` v2 (a branch carrying `baseline` / `gates` / `guardrails`).
- The guardrail subsystem (feedback layer).
- Deep validation of the inline gate's `check` clause (the role-gate path validates `check` via the loader; the command-stage gate currently gets only structural `id` / `evidence.path` validation — `checkGates` tolerates an absent or simple `check` at runtime).
- Rich `RunLogger` stage records for command stages.
