# Breakout AutoML Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an automated RL training system for Atari Breakout, orchestrated by petri with nested repeat loops and extended gate operators. Five agents (Director, Scientist, Coder, Trainer, Analyst) collaborate to reach peak_reward >= 30.

**Architecture:** Two petri engine changes (nested repeat blocks, gate comparison operators) followed by a new petri project at `~/lab/petri/breakout/` with 5 roles in a nested pipeline. Training code is written by the Coder agent at runtime.

**Tech Stack:** TypeScript (petri engine), vitest (tests), YAML (configs), Python (training code written by agents at runtime)

**Spec:** `docs/superpowers/specs/2026-04-06-breakout-automl-design.md`

---

## File Structure

### Petri Engine Changes

- **Modify:** `src/types.ts` — Change `RepeatBlock.stages` from `StageConfig[]` to `StageEntry[]`, extend `GateCheck` with comparison operators
- **Modify:** `src/engine/gate.ts` — Add `gte`, `lte`, `gt`, `lt`, `in` evaluation logic
- **Modify:** `src/engine/engine.ts` — Make `runRepeatBlock` handle nested `RepeatBlock` entries
- **Modify:** `src/cli/validate.ts` — Recurse into nested repeat blocks when collecting role names
- **Modify:** `tests/engine/gate.test.ts` — Tests for new comparison operators
- **Modify:** `tests/engine/engine.test.ts` — Test for nested repeat blocks

### Breakout Project

- **Create:** `~/lab/petri/breakout/petri.yaml`
- **Create:** `~/lab/petri/breakout/pipeline.yaml`
- **Create:** `~/lab/petri/breakout/roles/director/` (role.yaml, soul.md, gate.yaml, skills/decide.md)
- **Create:** `~/lab/petri/breakout/roles/scientist/` (role.yaml, soul.md, gate.yaml, skills/design_experiment.md)
- **Create:** `~/lab/petri/breakout/roles/coder/` (role.yaml, soul.md, gate.yaml, skills/write_training_code.md)
- **Create:** `~/lab/petri/breakout/roles/trainer/` (role.yaml, soul.md, gate.yaml, skills/run_training.md)
- **Create:** `~/lab/petri/breakout/roles/analyst/` (role.yaml, soul.md, gate.yaml, skills/analyze_results.md)
- **Create:** `~/lab/petri/breakout/seeds/historical_results.csv`
- **Create:** `~/lab/petri/breakout/seeds/baseline_config.yaml`

---

## Task 1: Extend Gate Comparison Operators

**Files:**
- Modify: `src/types.ts:50-60`
- Modify: `src/engine/gate.ts:61-74`
- Test: `tests/engine/gate.test.ts`

- [ ] **Step 1: Write failing tests for new gate operators**

Add these tests to `tests/engine/gate.test.ts` inside the `checkGates` describe block:

```typescript
it("passes when field value >= gte threshold", async () => {
  const artifactPath = path.join(tmpDir, "analyze", "analyst", "metrics.json");
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, JSON.stringify({ peak_reward: 35 }));

  const gate: GateConfig = {
    id: "target-reached",
    evidence: {
      path: "{stage}/{role}/metrics.json",
      check: { field: "peak_reward", gte: 30 },
    },
  };
  const gates: GateInput[] = [{ gate, roleName: "analyst" }];
  const result = await checkGates(gates, "analyze", tmpDir, "all");
  expect(result.passed).toBe(true);
});

it("fails when field value < gte threshold", async () => {
  const artifactPath = path.join(tmpDir, "analyze", "analyst", "metrics.json");
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, JSON.stringify({ peak_reward: 25 }));

  const gate: GateConfig = {
    id: "target-reached",
    evidence: {
      path: "{stage}/{role}/metrics.json",
      check: { field: "peak_reward", gte: 30 },
    },
  };
  const gates: GateInput[] = [{ gate, roleName: "analyst" }];
  const result = await checkGates(gates, "analyze", tmpDir, "all");
  expect(result.passed).toBe(false);
  expect(result.details[0].reason).toContain("peak_reward");
});

it("passes when field value < lt threshold", async () => {
  const artifactPath = path.join(tmpDir, "analyze", "analyst", "metrics.json");
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, JSON.stringify({ improvement_pct: 5 }));

  const gate: GateConfig = {
    id: "algo-saturated",
    evidence: {
      path: "{stage}/{role}/metrics.json",
      check: { field: "improvement_pct", lt: 10 },
    },
  };
  const gates: GateInput[] = [{ gate, roleName: "analyst" }];
  const result = await checkGates(gates, "analyze", tmpDir, "all");
  expect(result.passed).toBe(true);
});

it("fails when field value >= lt threshold", async () => {
  const artifactPath = path.join(tmpDir, "analyze", "analyst", "metrics.json");
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, JSON.stringify({ improvement_pct: 15 }));

  const gate: GateConfig = {
    id: "algo-saturated",
    evidence: {
      path: "{stage}/{role}/metrics.json",
      check: { field: "improvement_pct", lt: 10 },
    },
  };
  const gates: GateInput[] = [{ gate, roleName: "analyst" }];
  const result = await checkGates(gates, "analyze", tmpDir, "all");
  expect(result.passed).toBe(false);
});

it("passes when field value is in the allowed set", async () => {
  const artifactPath = path.join(tmpDir, "direct", "director", "direction.yaml");
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, JSON.stringify({ action: "pivot" }));

  const gate: GateConfig = {
    id: "direction-valid",
    evidence: {
      path: "{stage}/{role}/direction.yaml",
      check: { field: "action", in: ["start", "tune", "pivot", "done"] },
    },
  };
  const gates: GateInput[] = [{ gate, roleName: "director" }];
  const result = await checkGates(gates, "direct", tmpDir, "all");
  expect(result.passed).toBe(true);
});

it("fails when field value is not in the allowed set", async () => {
  const artifactPath = path.join(tmpDir, "direct", "director", "direction.yaml");
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, JSON.stringify({ action: "invalid" }));

  const gate: GateConfig = {
    id: "direction-valid",
    evidence: {
      path: "{stage}/{role}/direction.yaml",
      check: { field: "action", in: ["start", "tune", "pivot", "done"] },
    },
  };
  const gates: GateInput[] = [{ gate, roleName: "director" }];
  const result = await checkGates(gates, "direct", tmpDir, "all");
  expect(result.passed).toBe(false);
});

it("passes when gt threshold is met", async () => {
  const artifactPath = path.join(tmpDir, "review", "critic", "output.json");
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, JSON.stringify({ score: 10 }));

  const gate: GateConfig = {
    id: "score-check",
    evidence: {
      path: "{stage}/{role}/output.json",
      check: { field: "score", gt: 5 },
    },
  };
  const gates: GateInput[] = [{ gate, roleName: "critic" }];
  const result = await checkGates(gates, "review", tmpDir, "all");
  expect(result.passed).toBe(true);
});

it("passes when lte threshold is met", async () => {
  const artifactPath = path.join(tmpDir, "review", "critic", "output.json");
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, JSON.stringify({ error_rate: 0.05 }));

  const gate: GateConfig = {
    id: "error-check",
    evidence: {
      path: "{stage}/{role}/output.json",
      check: { field: "error_rate", lte: 0.1 },
    },
  };
  const gates: GateInput[] = [{ gate, roleName: "critic" }];
  const result = await checkGates(gates, "review", tmpDir, "all");
  expect(result.passed).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/xupeng/dev/github/petri && npx vitest run tests/engine/gate.test.ts`
Expected: 8 new tests FAIL (properties `gte`, `lt`, `in`, `gt`, `lte` don't exist on `GateCheck`)

- [ ] **Step 3: Update GateConfig type in types.ts**

In `src/types.ts`, replace the `GateConfig` interface (lines 50-60):

```typescript
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
  id: string;
  description?: string;
  evidence: {
    path: string;
    check?: GateCheck;
  };
}
```

- [ ] **Step 4: Implement comparison operators in gate.ts**

In `src/engine/gate.ts`, replace the check evaluation block (lines 61-74) with:

```typescript
    if (gate.evidence.check) {
      const content = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
      const check = gate.evidence.check;
      const actual = content[check.field];
      let failed = false;
      let failReason = "";

      if (check.equals !== undefined && actual !== check.equals) {
        failed = true;
        failReason = `Field "${check.field}" is ${JSON.stringify(actual)}, expected ${JSON.stringify(check.equals)}`;
      }
      if (!failed && check.gte !== undefined && !(actual >= check.gte)) {
        failed = true;
        failReason = `Field "${check.field}" is ${actual}, expected >= ${check.gte}`;
      }
      if (!failed && check.lte !== undefined && !(actual <= check.lte)) {
        failed = true;
        failReason = `Field "${check.field}" is ${actual}, expected <= ${check.lte}`;
      }
      if (!failed && check.gt !== undefined && !(actual > check.gt)) {
        failed = true;
        failReason = `Field "${check.field}" is ${actual}, expected > ${check.gt}`;
      }
      if (!failed && check.lt !== undefined && !(actual < check.lt)) {
        failed = true;
        failReason = `Field "${check.field}" is ${actual}, expected < ${check.lt}`;
      }
      if (!failed && check.in !== undefined && !check.in.includes(actual)) {
        failed = true;
        failReason = `Field "${check.field}" is ${JSON.stringify(actual)}, expected one of ${JSON.stringify(check.in)}`;
      }

      if (failed) {
        details.push({
          gateId: gate.id,
          roleName,
          passed: false,
          reason: failReason,
        });
        continue;
      }
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/xupeng/dev/github/petri && npx vitest run tests/engine/gate.test.ts`
Expected: ALL tests PASS

- [ ] **Step 6: Commit**

```bash
cd /Users/xupeng/dev/github/petri
git add src/types.ts src/engine/gate.ts tests/engine/gate.test.ts
git commit -m "feat: add gte/lte/gt/lt/in comparison operators to gate checks"
```

---

## Task 2: Support Nested Repeat Blocks

**Files:**
- Modify: `src/types.ts:25-32`
- Modify: `src/engine/engine.ts:301-343`
- Test: `tests/engine/engine.test.ts`

- [ ] **Step 1: Write failing test for nested repeat**

Add this test to `tests/engine/engine.test.ts` inside the `Engine` describe block:

```typescript
it("runs nested repeat blocks", async () => {
  // Outer repeat: runs until "outer-done" gate passes
  // Inner repeat: runs until "inner-done" gate passes
  // Inner gate passes on 2nd inner iteration
  // Outer gate passes on 2nd outer iteration (after inner completes)
  const innerGate: GateConfig = {
    id: "inner-done",
    evidence: {
      path: "{stage}/{role}/output.json",
      check: { field: "inner_done", equals: true },
    },
  };
  const outerGate: GateConfig = {
    id: "outer-done",
    evidence: {
      path: "{stage}/{role}/output.json",
      check: { field: "outer_done", equals: true },
    },
  };
  const roles: Record<string, LoadedRole> = {
    inner_worker: makeRole("inner_worker", innerGate),
    outer_worker: makeRole("outer_worker", outerGate),
  };

  let innerCallCount = 0;
  let outerCallCount = 0;
  const provider = createStubProvider((config) => {
    if (config.persona === "inner_worker persona") {
      innerCallCount++;
      const dir = path.join(tmpDir, "inner_step", "inner_worker");
      fs.mkdirSync(dir, { recursive: true });
      // Inner gate passes every 2nd call within each outer iteration
      fs.writeFileSync(
        path.join(dir, "output.json"),
        JSON.stringify({ inner_done: innerCallCount % 2 === 0 }),
      );
    } else {
      outerCallCount++;
      const dir = path.join(tmpDir, "outer_step", "outer_worker");
      fs.mkdirSync(dir, { recursive: true });
      // Outer gate passes on 2nd outer iteration
      fs.writeFileSync(
        path.join(dir, "output.json"),
        JSON.stringify({ outer_done: outerCallCount >= 2 }),
      );
    }
  });

  const pipeline: PipelineConfig = {
    name: "test-nested",
    stages: [
      {
        repeat: {
          name: "outer",
          max_iterations: 5,
          until: "outer-done",
          stages: [
            { name: "outer_step", roles: ["outer_worker"], max_retries: 1 },
            {
              repeat: {
                name: "inner",
                max_iterations: 5,
                until: "inner-done",
                stages: [
                  { name: "inner_step", roles: ["inner_worker"], max_retries: 1 },
                ],
              },
            },
          ],
        },
      },
    ],
  };

  const engine = new Engine({
    provider,
    roles,
    artifactBaseDir: tmpDir,
  });

  const result = await engine.run(pipeline, "Nested iterate");
  expect(result.status).toBe("done");
  // Outer: iteration 1 (outer_worker fails, inner runs 2x) + iteration 2 (outer_worker passes)
  expect(outerCallCount).toBe(2);
  // Inner: 2 calls per outer iteration × 2 outer iterations = 4
  expect(innerCallCount).toBe(4);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/xupeng/dev/github/petri && npx vitest run tests/engine/engine.test.ts -t "runs nested repeat blocks"`
Expected: FAIL — TypeScript type error or runtime error because `RepeatBlock.stages` is `StageConfig[]` and doesn't accept nested `RepeatBlock`

- [ ] **Step 3: Update RepeatBlock type to accept StageEntry[]**

In `src/types.ts`, change the `RepeatBlock` interface (lines 25-32):

```typescript
export interface RepeatBlock {
  repeat: {
    name: string;
    max_iterations: number;
    until: string;  // gate id to check
    stages: StageEntry[];
  };
}
```

- [ ] **Step 4: Update runRepeatBlock to handle nested repeats**

In `src/engine/engine.ts`, replace the `runRepeatBlock` method (lines 301-343) with:

```typescript
  private async runRepeatBlock(
    block: { name: string; max_iterations: number; until: string; stages: import("../types.js").StageEntry[] },
    input: string,
    manifest: ArtifactManifest,
  ): Promise<RunResult> {
    for (let iteration = 0; iteration < block.max_iterations; iteration++) {
      console.log(`  Repeat "${block.name}" iteration ${iteration + 1}/${block.max_iterations}...`);

      let untilGateNotMet = false;

      // Run inner entries sequentially — may be stages or nested repeat blocks
      for (const entry of block.stages) {
        let result: RunResult;
        if (isRepeatBlock(entry)) {
          result = await this.runRepeatBlock(entry.repeat, input, manifest);
        } else {
          result = await this.runStage(entry, input, manifest);
        }
        if (result.status === "blocked") {
          const untilGate = this.gateResults.get(block.until);
          if (untilGate && !untilGate.passed) {
            untilGateNotMet = true;
            break;
          }
          return result;
        }
      }

      if (untilGateNotMet) {
        continue;
      }

      // Check until condition: look up gate id from registry
      const gateDetail = this.gateResults.get(block.until);
      if (gateDetail?.passed) {
        return { status: "done" };
      }
    }

    return {
      status: "blocked",
      stage: block.name,
      reason: `Max iterations (${block.max_iterations}) exhausted`,
    };
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/xupeng/dev/github/petri && npx vitest run tests/engine/engine.test.ts -t "runs nested repeat blocks"`
Expected: PASS

- [ ] **Step 6: Run all engine tests to check nothing is broken**

Run: `cd /Users/xupeng/dev/github/petri && npx vitest run tests/engine/engine.test.ts`
Expected: ALL tests PASS

- [ ] **Step 7: Commit**

```bash
cd /Users/xupeng/dev/github/petri
git add src/types.ts src/engine/engine.ts tests/engine/engine.test.ts
git commit -m "feat: support nested repeat blocks in pipeline engine"
```

---

## Task 3: Update Validate Command for Nested Repeats

**Files:**
- Modify: `src/cli/validate.ts:30-43`

- [ ] **Step 1: Replace the role collection logic in validate.ts**

In `src/cli/validate.ts`, replace the stage iteration block (lines 30-43) with a recursive helper:

```typescript
    function collectRoles(stages: import("../types.js").StageEntry[]): number {
      let count = 0;
      for (const entry of stages) {
        if (isRepeatBlock(entry)) {
          count += collectRoles(entry.repeat.stages);
        } else {
          count++;
          for (const role of entry.roles) {
            roleNames.add(role);
          }
        }
      }
      return count;
    }
    const stageCount = collectRoles(pipelineConfig.stages);
```

- [ ] **Step 2: Run all tests to verify nothing is broken**

Run: `cd /Users/xupeng/dev/github/petri && npx vitest run`
Expected: ALL tests PASS

- [ ] **Step 3: Commit**

```bash
cd /Users/xupeng/dev/github/petri
git add src/cli/validate.ts
git commit -m "fix: validate command recurses into nested repeat blocks"
```

---

## Task 4: Create Breakout Project — Config Files

**Files:**
- Create: `~/lab/petri/breakout/petri.yaml`
- Create: `~/lab/petri/breakout/pipeline.yaml`

- [ ] **Step 1: Create petri.yaml**

```yaml
providers:
  default:
    type: claude_code

models:
  opus:
    provider: default
    model: claude-opus-4-6

defaults:
  model: opus
  gate_strategy: all
  max_retries: 2
```

- [ ] **Step 2: Create pipeline.yaml**

```yaml
name: breakout-automl
description: Automated RL training for Atari Breakout — multi-agent hyperparameter optimization and algorithm evolution
goal: "Achieve peak_reward >= 30 on BreakoutNoFrameskip-v4 using automated training loops on MPS device"
requirements:
  - target-reached

stages:
  - name: bootstrap
    roles: [coder]
    max_retries: 3
    timeout: 600000

  - repeat:
      name: evolve
      max_iterations: 5
      until: target-reached
      stages:
        - name: direct
          roles: [director]
          max_retries: 1
          timeout: 300000

        - name: implement
          roles: [coder]
          max_retries: 3
          timeout: 600000

        - repeat:
            name: optimize
            max_iterations: 5
            until: algo-saturated
            stages:
              - name: design
                roles: [scientist]
                max_retries: 2
                timeout: 300000

              - name: train
                roles: [trainer]
                max_retries: 2
                timeout: 21600000

              - name: analyze
                roles: [analyst]
                max_retries: 1
                timeout: 300000
```

- [ ] **Step 3: Commit**

```bash
cd ~/lab/petri/breakout
git init
git add petri.yaml pipeline.yaml
git commit -m "init: breakout automl project with nested pipeline config"
```

---

## Task 5: Create Director Role

**Files:**
- Create: `~/lab/petri/breakout/roles/director/role.yaml`
- Create: `~/lab/petri/breakout/roles/director/soul.md`
- Create: `~/lab/petri/breakout/roles/director/gate.yaml`
- Create: `~/lab/petri/breakout/roles/director/skills/decide.md`

- [ ] **Step 1: Create role.yaml**

```yaml
persona: soul.md
skills:
  - petri:file_operations
  - petri:shell_tools
  - decide
```

- [ ] **Step 2: Create soul.md**

```markdown
# Director — Algorithm Strategy Lead

You are the Director of an automated reinforcement learning experiment targeting Atari Breakout (BreakoutNoFrameskip-v4). Your job is to decide the **algorithm direction** for the team.

## Your Responsibilities

1. Review experiment history and analyst reports
2. Decide whether to continue tuning the current algorithm or pivot to a new one
3. Output a `direction.yaml` file with your decision

## Decision Logic

- **First run (no history):** Output `action: start`, `algorithm: DQN`
- **If peak_reward >= 30:** Output `action: done`
- **If last 2 optimization rounds improved peak_reward by < 10%:** Output `action: pivot`, select next algorithm from the roadmap
- **Otherwise:** Output `action: tune`

## Algorithm Roadmap

Progress through these in order when pivoting:
1. DQN (starting point)
2. Double DQN
3. Dueling DQN
4. Rainbow (Noisy Nets + PER + Dueling + Double + Multi-step + Distributional)

## Output Format

Write `direction.yaml` (JSON format) to your artifact directory:

```json
{
  "action": "start|tune|pivot|done",
  "algorithm": "DQN",
  "reason": "Brief explanation of your decision",
  "roadmap_position": 1,
  "history_summary": "Best peak_reward so far: X, last improvement: Y%"
}
```

## Context

- Read `analyze/analyst/history.json` for cumulative experiment data
- Read `analyze/analyst/metrics.json` for the latest round's metrics
- If these files don't exist yet (first run), use `action: start`
- The target is peak_reward >= 30 (human-level performance on Breakout)
- Training runs on Apple M2 Max with MPS device
```

- [ ] **Step 3: Create gate.yaml**

```yaml
id: direction-valid
description: "Director outputs valid direction.yaml with a recognized action"
evidence:
  path: "{stage}/{role}/direction.yaml"
  check:
    field: action
    in: [start, tune, pivot, done]
```

- [ ] **Step 4: Create skills/decide.md**

```markdown
# Decide Algorithm Direction

## Steps

1. Check if `analyze/analyst/history.json` exists in the available artifacts
   - If not: this is the first run. Output `action: start, algorithm: DQN`
2. Read `analyze/analyst/metrics.json` for the latest round results
3. Read `analyze/analyst/history.json` for full experiment history
4. Calculate improvement: `(current_best - previous_best) / previous_best * 100`
5. Apply decision logic:
   - peak_reward >= 30 → `action: done`
   - improvement < 10% for last 2 rounds → `action: pivot`, advance roadmap
   - otherwise → `action: tune`
6. Write `direction.yaml` to your artifact directory as JSON

## Important

- Always include a clear `reason` explaining your decision
- Track `roadmap_position` (1=DQN, 2=Double DQN, 3=Dueling, 4=Rainbow)
- If you've exhausted the roadmap (position > 4), still output `action: pivot` with the best available algorithm and note that all options have been tried
```

- [ ] **Step 5: Commit**

```bash
cd ~/lab/petri/breakout
git add roles/director/
git commit -m "feat: add director role — algorithm strategy decisions"
```

---

## Task 6: Create Scientist Role

**Files:**
- Create: `~/lab/petri/breakout/roles/scientist/role.yaml`
- Create: `~/lab/petri/breakout/roles/scientist/soul.md`
- Create: `~/lab/petri/breakout/roles/scientist/gate.yaml`
- Create: `~/lab/petri/breakout/roles/scientist/skills/design_experiment.md`

- [ ] **Step 1: Create role.yaml**

```yaml
persona: soul.md
skills:
  - petri:file_operations
  - petri:shell_tools
  - design_experiment
```

- [ ] **Step 2: Create soul.md**

```markdown
# Scientist — Hyperparameter Experiment Designer

You are the Scientist in an automated RL experiment for Atari Breakout. Your job is to design hyperparameter experiments within the algorithm direction set by the Director.

## Your Responsibilities

1. Read the Director's `direction.yaml` to know the current algorithm
2. Analyze experiment history to understand what's been tried and what worked
3. Design 1-3 new hyperparameter configurations that are likely to improve performance
4. Output an `experiment_plan.yaml` file

## Design Principles

- **Never repeat** a configuration that's already been tried (check history.json)
- **Focus on high-impact parameters** first: learning_rate, batch_size, epsilon_decay_steps, target_update_frequency
- **Use historical data** to identify promising regions of the parameter space
- **Be systematic**: vary one parameter at a time from the best known config, or use insights from prior results
- When starting a new algorithm (Director said `pivot`), begin with reasonable defaults based on the literature

## Parameter Ranges (DQN family)

| Parameter | Range | Notes |
|-----------|-------|-------|
| LEARNING_RATE | 1e-5 to 1e-3 | Log scale |
| BATCH_SIZE | 32, 64, 128 | |
| EPSILON_DECAY_STEPS | 500K to 2M | |
| EPSILON_END | 0.01 to 0.1 | |
| GAMMA | 0.95 to 0.999 | |
| TARGET_UPDATE_FREQUENCY | 1000 to 10000 | |
| REPLAY_BUFFER_CAPACITY | 100K to 1M | Memory-constrained on MPS |
| GRAD_CLIP_VALUE | 1.0 to 10.0 | |

## Output Format

Write `experiment_plan.yaml` (JSON format) to your artifact directory:

```json
{
  "algorithm": "DQN",
  "experiments": [
    {
      "name": "exp_lr_high",
      "description": "Test higher learning rate based on positive trend in history",
      "params": {
        "LEARNING_RATE": 0.00025,
        "BATCH_SIZE": 64,
        "EPSILON_DECAY_STEPS": 800000,
        "EPSILON_END": 0.01,
        "GAMMA": 0.99,
        "TARGET_UPDATE_FREQUENCY": 7000,
        "REPLAY_BUFFER_CAPACITY": 200000,
        "GRAD_CLIP_VALUE": 5.0,
        "TOTAL_TRAINING_STEPS": 2000000
      }
    }
  ],
  "rationale": "Explanation of why these configs were chosen"
}
```

## Context

- Read `direct/director/direction.yaml` for current algorithm
- Read `analyze/analyst/history.json` for past experiment data (if available)
- Read `seeds/historical_results.csv` for baseline data from prior DQN experiments
- The best prior result was peak_reward ~7.86 with batch=64, epsilon_decay=800K, target_update=7000
```

- [ ] **Step 3: Create gate.yaml**

```yaml
id: experiment-designed
description: "Scientist outputs valid experiment plan with at least one experiment"
evidence:
  path: "{stage}/{role}/experiment_plan.yaml"
  check:
    field: algorithm
```

- [ ] **Step 4: Create skills/design_experiment.md**

```markdown
# Design Hyperparameter Experiments

## Steps

1. Read `direct/director/direction.yaml` to get the current algorithm and action
2. If action is `start`: design 2-3 initial experiments for DQN covering different batch sizes and learning rates
3. If action is `tune`: read `analyze/analyst/history.json`, identify the best config so far, and design 1-3 variations
4. If action is `pivot`: design 2-3 initial experiments for the new algorithm with literature-recommended defaults
5. Write `experiment_plan.yaml` to your artifact directory as JSON

## Experiment Design Tips

- Start with the best known configuration and make targeted changes
- For DQN on Breakout, key parameters are learning_rate and target_update_frequency
- Keep TOTAL_TRAINING_STEPS at 2000000 (sufficient for convergence assessment)
- REPLAY_BUFFER_CAPACITY should not exceed 500000 on MPS (memory constraint)
- Always set RANDOM_SEED to 42 for reproducibility
```

- [ ] **Step 5: Commit**

```bash
cd ~/lab/petri/breakout
git add roles/scientist/
git commit -m "feat: add scientist role — hyperparameter experiment design"
```

---

## Task 7: Create Coder Role

**Files:**
- Create: `~/lab/petri/breakout/roles/coder/role.yaml`
- Create: `~/lab/petri/breakout/roles/coder/soul.md`
- Create: `~/lab/petri/breakout/roles/coder/gate.yaml`
- Create: `~/lab/petri/breakout/roles/coder/skills/write_training_code.md`

- [ ] **Step 1: Create role.yaml**

```yaml
persona: soul.md
skills:
  - petri:file_operations
  - petri:shell_tools
  - write_training_code
```

- [ ] **Step 2: Create soul.md**

```markdown
# Coder — RL Training Code Engineer

You are the Coder in an automated RL experiment for Atari Breakout. Your job is to write and maintain the training code.

## Your Responsibilities

### Bootstrap Stage (first run)
Write a complete, runnable RL training framework:
- DQN agent with standard Atari CNN architecture (3 conv layers + 2 FC layers)
- Environment wrappers: NoopReset, MaxAndSkip, FireReset, WarpFrame (84x84 grayscale), FrameStack(4), ClipReward
- Replay buffer (standard, with option for prioritized)
- Config-driven training loop reading from a YAML config file
- Logging: output to `atari.log` in the same format as prior experiments
- MPS device support (fall back to CPU if MPS unavailable)
- Early stopping support (configurable reward threshold after N steps)

### Implement Stage (algorithm changes)
When the Director says `pivot` to a new algorithm:
- Read `direct/director/direction.yaml` for the target algorithm
- Modify or extend the training code to support it
- Algorithms to support: DQN, Double DQN, Dueling DQN, Rainbow

When the Director says `tune`, output "no changes needed" — do not modify code.

## Code Structure

```
train.py              # Main entry point
models/
  dqn.py             # DQN / Double DQN network
  dueling.py         # Dueling DQN network
  rainbow.py         # Rainbow network (when needed)
utils/
  wrappers.py        # Atari environment wrappers
  replay_buffer.py   # Standard + Prioritized replay buffer
  config.py          # YAML config loader
```

## Verification

After writing code, verify it works:
```bash
python train.py --config test_config.yaml --device mps --steps 1000
```

Write `test_run.json` to your artifact directory:
```json
{
  "success": true,
  "steps_completed": 1000,
  "device": "mps",
  "error": null
}
```

## Technical Requirements

- Python 3.10+, PyTorch 2.4+, gymnasium, ale-py
- Observation shape: (4, 84, 84) — 4 stacked grayscale frames
- Action space: 4 actions (noop, fire, left, right)
- Log format must include: 步数, 最近 100 Episode 平均奖励, 最近 100 Episode 平均长度, 最近 100 Episode 平均损失
- Use the same log format as prior experiments for compatibility with existing analysis tools
```

- [ ] **Step 3: Create gate.yaml**

```yaml
id: code-runnable
description: "Training script passes mini training verification (1000 steps)"
evidence:
  path: "{stage}/{role}/test_run.json"
  check:
    field: success
    equals: true
```

- [ ] **Step 4: Create skills/write_training_code.md**

```markdown
# Write Training Code

## Bootstrap Steps

1. Create the project structure: train.py, models/, utils/
2. Implement environment wrappers in utils/wrappers.py:
   - NoopResetEnv, MaxAndSkipEnv, FireResetEnv, WarpFrame, FrameStack, ClipRewardEnv
   - `make_atari_env(env_name)` factory function that chains all wrappers
3. Implement replay buffer in utils/replay_buffer.py:
   - ReplayBuffer with sample(), push(), __len__()
   - PrioritizedReplayBuffer with alpha, beta parameters
4. Implement DQN network in models/dqn.py:
   - 3 conv layers: Conv2d(4,32,8,4) → Conv2d(32,64,4,2) → Conv2d(64,64,3,1)
   - 2 FC layers: Linear(3136, 512) → Linear(512, n_actions)
   - ReLU activations
5. Implement config loader in utils/config.py:
   - Load YAML config, provide defaults for all parameters
6. Implement training loop in train.py:
   - Epsilon-greedy exploration with linear decay
   - Experience replay with configurable buffer size
   - Target network with periodic updates
   - Logging every LOG_INTERVAL steps
   - Model saving every SAVE_INTERVAL steps
   - Support --config, --device, --steps CLI arguments
7. Create a minimal test config (test_config.yaml) with 1000 steps
8. Run verification: `python train.py --config test_config.yaml --device mps --steps 1000`
9. Write test_run.json with the result

## Implement Steps (Algorithm Changes)

1. Read `direct/director/direction.yaml`
2. If action is `tune`: write a file saying "no changes needed", exit
3. If action is `pivot`:
   - Read the target algorithm name
   - Implement the new network architecture if needed
   - Update train.py to support the new algorithm via config
   - Re-run verification with 1000 steps
   - Write test_run.json

## Algorithm Implementations

**Double DQN:** Use online network to select action, target network to evaluate. Change only the loss computation in train.py.

**Dueling DQN:** Split final FC layers into value stream and advantage stream. New file models/dueling.py.

**Rainbow:** Combine Double + Dueling + PER + Multi-step returns + Noisy nets + Distributional (C51). New file models/rainbow.py. Significant changes to train.py.
```

- [ ] **Step 5: Commit**

```bash
cd ~/lab/petri/breakout
git add roles/coder/
git commit -m "feat: add coder role — training code implementation"
```

---

## Task 8: Create Trainer Role

**Files:**
- Create: `~/lab/petri/breakout/roles/trainer/role.yaml`
- Create: `~/lab/petri/breakout/roles/trainer/soul.md`
- Create: `~/lab/petri/breakout/roles/trainer/gate.yaml`
- Create: `~/lab/petri/breakout/roles/trainer/skills/run_training.md`

- [ ] **Step 1: Create role.yaml**

```yaml
persona: soul.md
skills:
  - petri:file_operations
  - petri:shell_tools
  - run_training
```

- [ ] **Step 2: Create soul.md**

```markdown
# Trainer — Training Execution & Monitoring

You are the Trainer in an automated RL experiment for Atari Breakout. Your job is to execute training runs and monitor their progress.

## Your Responsibilities

1. Read the Scientist's `experiment_plan.yaml` for experiment configurations
2. For each experiment, generate a `global.yaml` config file and run training
3. Monitor training progress and apply early stopping if needed
4. Output `metrics_summary.json` with results for each experiment

## Execution Process

For each experiment in the plan:

1. Create a results directory: `results/{experiment_name}/`
2. Generate `global.yaml` from the experiment params
3. Run: `python train.py --config results/{experiment_name}/global.yaml --device mps`
4. Monitor the training log (`results/{experiment_name}/log/atari.log`)
5. Apply early stopping: if average reward < 0.5 after 500,000 steps, kill the process
6. After training completes (or is stopped), extract final metrics

## Config Template (global.yaml)

```yaml
dqn:
  BATCH_SIZE: 64
  LEARNING_RATE: 0.0001
  EPSILON_START: 1.0
  EPSILON_END: 0.01
  EPSILON_DECAY_STEPS: 800000
  GAMMA: 0.99
  TARGET_UPDATE_FREQUENCY: 7000
  REPLAY_BUFFER_CAPACITY: 200000
  GRAD_CLIP_VALUE: 5.0
  USE_PRIORITIZED_REPLAY: false
  PER_ALPHA: 0.6
  PER_BETA_START: 0.4
  PER_BETA_INCREMENT: 0.001
  PER_EPSILON: 0.01
general:
  ENV_NAME: BreakoutNoFrameskip-v4
  TOTAL_TRAINING_STEPS: 2000000
  LOG_INTERVAL: 1000
  SAVE_INTERVAL: 50000
  EVAL_EPISODES: 100
  EVAL_EPSILON: 0.01
  VICTORY_THRESHOLD: 30.0
  MODEL_SAVE_DIR: ./saved_models
  RANDOM_SEED: 42
  VIDEO_SAVE_INTERVAL: 50000
```

## Output Format

Write `metrics_summary.json` to your artifact directory:

```json
{
  "experiments": [
    {
      "name": "exp_lr_high",
      "config": { ... },
      "peak_reward": 7.86,
      "final_avg_reward": 6.5,
      "final_avg_loss": 0.003,
      "steps_completed": 2000000,
      "early_stopped": false,
      "training_time_seconds": 14400
    }
  ],
  "best_experiment": "exp_lr_high",
  "best_peak_reward": 7.86
}
```

## Important

- The training code is located in the bootstrap/coder artifact directory
- Always use `--device mps` for Apple Silicon GPU acceleration
- Training a full 2M steps takes 3-5 hours on MPS — be patient
- Log monitoring: parse the atari.log periodically to check progress
- If all experiments in a round are early-stopped, still output metrics_summary.json with what was collected
```

- [ ] **Step 3: Create gate.yaml**

```yaml
id: training-complete
description: "Trainer outputs metrics summary with at least one completed experiment"
evidence:
  path: "{stage}/{role}/metrics_summary.json"
  check:
    field: best_peak_reward
    gte: 0
```

- [ ] **Step 4: Create skills/run_training.md**

```markdown
# Run Training Experiments

## Steps

1. Read `design/scientist/experiment_plan.yaml` for experiment configurations
2. Locate the training code in `bootstrap/coder/` artifacts (train.py and supporting files)
3. For each experiment in the plan:
   a. Create directory: `results/{experiment_name}/`
   b. Write `global.yaml` with the experiment's params merged into the config template
   c. Copy training code to a working directory if needed
   d. Run: `python train.py --config results/{experiment_name}/global.yaml --device mps`
   e. Monitor `atari.log` output — check every 100K steps for early stop condition
   f. If avg_reward < 0.5 after 500K steps → kill process, mark as early_stopped
4. After all experiments complete, collect metrics from each log file
5. Write `metrics_summary.json` to your artifact directory

## Monitoring Commands

Check training progress:
```bash
tail -20 results/{experiment_name}/log/atari.log
```

Check if training is still running:
```bash
ps aux | grep train.py
```

Kill a stuck training:
```bash
kill $(ps aux | grep "train.py.*{experiment_name}" | grep -v grep | awk '{print $2}')
```

## Log Parsing

Extract metrics from atari.log lines like:
- `步数: 500000/2000000 (25.0%)`
- `最近 100 Episode 平均奖励: 3.45`
- `最近 100 Episode 平均长度: 156.2`
- `最近 100 Episode 平均损失: 0.0045`
```

- [ ] **Step 5: Commit**

```bash
cd ~/lab/petri/breakout
git add roles/trainer/
git commit -m "feat: add trainer role — training execution and monitoring"
```

---

## Task 9: Create Analyst Role

**Files:**
- Create: `~/lab/petri/breakout/roles/analyst/role.yaml`
- Create: `~/lab/petri/breakout/roles/analyst/soul.md`
- Create: `~/lab/petri/breakout/roles/analyst/gate.yaml`
- Create: `~/lab/petri/breakout/roles/analyst/skills/analyze_results.md`

- [ ] **Step 1: Create role.yaml**

```yaml
persona: soul.md
skills:
  - petri:file_operations
  - petri:shell_tools
  - analyze_results
```

- [ ] **Step 2: Create soul.md**

```markdown
# Analyst — Experiment Analysis & Reporting

You are the Analyst in an automated RL experiment for Atari Breakout. Your job is to analyze training results and maintain the experiment history.

## Your Responsibilities

1. Parse training results from the Trainer's output
2. Compute performance metrics and compare against history
3. Maintain `history.json` — the cumulative record of all experiments across all rounds
4. Output `metrics.json` for gate evaluation and `report.md` for human review

## Analysis Process

1. Read `train/trainer/metrics_summary.json` for current round results
2. Read existing `history.json` from previous rounds (if available in your own prior artifacts)
3. Compute:
   - `peak_reward`: best peak_reward across all experiments this round
   - `historical_best`: best peak_reward across all experiments ever
   - `improvement_pct`: `(peak_reward - previous_round_best) / previous_round_best * 100`
   - `best_config`: the configuration that achieved the best result this round
4. Append current round data to history
5. Write output files

## Output Files

### metrics.json (for gates)
```json
{
  "peak_reward": 7.86,
  "historical_best": 7.86,
  "improvement_pct": 15.2,
  "best_config": { ... },
  "round_number": 1,
  "algorithm": "DQN",
  "total_experiments_run": 3,
  "target_reached": false
}
```

### history.json (cumulative)
```json
{
  "rounds": [
    {
      "round": 1,
      "algorithm": "DQN",
      "experiments": [
        {
          "name": "exp_lr_high",
          "params": { ... },
          "peak_reward": 7.86,
          "final_avg_reward": 6.5,
          "early_stopped": false
        }
      ],
      "best_peak_reward": 7.86,
      "improvement_pct": null
    }
  ],
  "global_best": {
    "peak_reward": 7.86,
    "algorithm": "DQN",
    "config": { ... },
    "round": 1
  }
}
```

### report.md (human-readable)
A markdown report summarizing the round: what was tried, what worked, what didn't, and recommendation for next steps.

## Important

- `improvement_pct` must be calculated correctly — it drives the Director's pivot decision
- If this is the first round, set `improvement_pct` to 100 (baseline establishment)
- `history.json` must be append-only — never lose data from prior rounds
- Read your own prior artifacts to find the previous `history.json`
```

- [ ] **Step 3: Create gate.yaml**

The analyst has two gate IDs. Petri supports one gate per role, so we use the primary gate for the outer loop exit condition. The inner loop (`algo-saturated`) checks the same file but with different criteria — this is handled by the pipeline's `until` reference looking up the gate registry.

For the `algo-saturated` gate to work, we need the analyst's gate to evaluate both IDs. Since petri gates are per-role (one gate.yaml per role), we'll use `target-reached` as the analyst's gate and rely on the Director's iteration logic for the saturation signal.

Actually, looking at the engine code more carefully: the `until` field in a repeat block looks up gate IDs from the registry (`this.gateResults`). A gate is registered when its role's stage is executed. So we need the analyst to register both `target-reached` and `algo-saturated`.

The simplest approach: use `target-reached` as the analyst gate. For `algo-saturated`, have the analyst write a separate artifact that the Scientist can check, and let the Director handle the saturation logic. The inner repeat loop's `until: algo-saturated` needs a gate with that ID — so we need a second role or a different approach.

**Revised approach:** Create a lightweight gate file where the analyst produces `metrics.json` with both `peak_reward` and `improvement_pct`. Since one role can only have one gate, make the analyst's gate `algo-saturated` (for the inner loop exit), and add `target-reached` as a separate check. We can handle this by having the analyst gate be `algo-saturated` and adding `target-reached` as a pipeline requirement that gets checked via the gate registry.

Wait — the engine registers gates by their `id`. The `until` field looks up this ID. So we need:
- Inner repeat `until: algo-saturated` → needs a gate with id `algo-saturated` to be registered after the analyze stage
- Outer repeat `until: target-reached` → needs a gate with id `target-reached` to be registered

Since one role = one gate ID, we need two roles or we need to extend petri to support multiple gates per role.

**Simplest solution:** Give the analyst the `algo-saturated` gate (checked after every analyze stage in the inner loop). For `target-reached`, add a second gate on the same role — but petri doesn't support that. Instead, we can make `algo-saturated` the ONLY until condition for both loops, and have the analyst set the gate to pass when EITHER the algorithm is saturated OR the target is reached. The outer loop's `until` can also be `algo-saturated` since it will pass in both cases.

No — the outer loop should only exit when the target is reached, not when the algorithm is saturated (saturation should trigger a pivot, not an exit).

**Final approach:** We extend the analyst gate to use `target-reached` and accept that the inner loop needs a different mechanism. For the inner loop, instead of `until: algo-saturated`, we use `until: target-reached` as well — but this means the inner loop exits on target reached (good) but not on saturation. The Director handles saturation by looking at improvement_pct and deciding `pivot` in the next outer iteration.

This simplifies the design: both loops use `until: target-reached`. The inner loop just runs its max_iterations (5 rounds of tuning). If the Director sees saturation, it pivots on the next outer iteration.

```yaml
id: target-reached
description: "Peak reward >= 30 — target achieved"
evidence:
  path: "{stage}/{role}/metrics.json"
  check:
    field: peak_reward
    gte: 30
```

Update `pipeline.yaml` in Task 4 accordingly: both repeat blocks use `until: target-reached`.

- [ ] **Step 4: Create skills/analyze_results.md**

```markdown
# Analyze Experiment Results

## Steps

1. Read `train/trainer/metrics_summary.json` for current round results
2. Check if `history.json` exists from a previous round (look in your own prior artifacts or the artifact manifest)
3. If history exists, load it. If not, initialize an empty history structure
4. Compute metrics:
   - `peak_reward`: max peak_reward from this round's experiments
   - `historical_best`: max peak_reward across ALL rounds
   - `improvement_pct`: improvement over previous round's best (100 if first round)
   - Identify the best configuration
5. Append this round's data to history.json
6. Write three files to your artifact directory:
   - `metrics.json` — structured metrics for gate evaluation
   - `history.json` — cumulative experiment data
   - `report.md` — human-readable summary

## Metrics Calculation

```
peak_reward = max(exp.peak_reward for exp in current_round)
previous_best = history.rounds[-1].best_peak_reward if history.rounds else 0
improvement_pct = (peak_reward - previous_best) / max(previous_best, 0.01) * 100
```

## Report Template

```markdown
# Round {N} Analysis Report

## Algorithm: {algorithm}

### Experiments Run
| Name | Peak Reward | Final Avg Reward | Early Stopped |
|------|-------------|------------------|---------------|
| ...  | ...         | ...              | ...           |

### Key Findings
- Best result: {best_experiment} with peak_reward {peak_reward}
- Improvement over previous round: {improvement_pct}%
- Historical best: {historical_best} (Round {round_number}, {algorithm})

### Recommendation
{Based on the data, suggest what the Director/Scientist should focus on next}
```
```

- [ ] **Step 5: Commit**

```bash
cd ~/lab/petri/breakout
git add roles/analyst/
git commit -m "feat: add analyst role — experiment analysis and reporting"
```

---

## Task 10: Update Pipeline — Unified Until Condition

Based on the gate design decision in Task 9 (both loops use `target-reached`), update the pipeline.

**Files:**
- Modify: `~/lab/petri/breakout/pipeline.yaml`

- [ ] **Step 1: Update pipeline.yaml**

Replace the file content with:

```yaml
name: breakout-automl
description: Automated RL training for Atari Breakout — multi-agent hyperparameter optimization and algorithm evolution
goal: "Achieve peak_reward >= 30 on BreakoutNoFrameskip-v4 using automated training loops on MPS device"
requirements:
  - target-reached

stages:
  - name: bootstrap
    roles: [coder]
    max_retries: 3
    timeout: 600000

  - repeat:
      name: evolve
      max_iterations: 5
      until: target-reached
      stages:
        - name: direct
          roles: [director]
          max_retries: 1
          timeout: 300000

        - name: implement
          roles: [coder]
          max_retries: 3
          timeout: 600000

        - repeat:
            name: optimize
            max_iterations: 5
            until: target-reached
            stages:
              - name: design
                roles: [scientist]
                max_retries: 2
                timeout: 300000

              - name: train
                roles: [trainer]
                max_retries: 2
                timeout: 21600000

              - name: analyze
                roles: [analyst]
                max_retries: 1
                timeout: 300000
```

- [ ] **Step 2: Commit**

```bash
cd ~/lab/petri/breakout
git add pipeline.yaml
git commit -m "fix: both repeat loops use target-reached as exit condition"
```

---

## Task 11: Add Seed Data

**Files:**
- Create: `~/lab/petri/breakout/seeds/historical_results.csv`
- Create: `~/lab/petri/breakout/seeds/baseline_config.yaml`

- [ ] **Step 1: Copy historical results**

```bash
cp ~/lab/breakout/results/combined_analysis.csv ~/lab/petri/breakout/seeds/historical_results.csv
```

- [ ] **Step 2: Create baseline_config.yaml**

Extract the best configuration from prior experiments (batch=64, epsilon_decay=800K, target_update=7000):

```yaml
# Best configuration from prior DQN experiments
# Peak reward: 7.86
dqn:
  BATCH_SIZE: 64
  EPSILON_DECAY_STEPS: 800000
  EPSILON_END: 0.01
  EPSILON_START: 1.0
  GAMMA: 0.99
  GRAD_CLIP_VALUE: 5.0
  LEARNING_RATE: 0.0001
  LEARNING_STARTS: 10000
  PER_ALPHA: 0.6
  PER_BETA_INCREMENT: 0.001
  PER_BETA_START: 0.4
  PER_EPSILON: 0.01
  REPLAY_BUFFER_CAPACITY: 200000
  TARGET_UPDATE_FREQUENCY: 7000
  USE_PRIORITIZED_REPLAY: false
general:
  ENV_NAME: BreakoutNoFrameskip-v4
  EVAL_EPISODES: 100
  EVAL_EPSILON: 0.01
  LOG_INTERVAL: 1000
  MODEL_SAVE_DIR: ./saved_models
  RANDOM_SEED: 42
  SAVE_INTERVAL: 50000
  TOTAL_TRAINING_STEPS: 2000000
  VICTORY_THRESHOLD: 10.0
  VIDEO_SAVE_INTERVAL: 50000
```

- [ ] **Step 3: Commit**

```bash
cd ~/lab/petri/breakout
git add seeds/
git commit -m "feat: add seed data — historical results and baseline config"
```

---

## Task 12: Validate and Smoke Test

- [ ] **Step 1: Run petri validate on the breakout project**

```bash
cd ~/lab/petri/breakout && petri validate
```

Expected: All roles load successfully, pipeline validates.

- [ ] **Step 2: Run all petri tests to verify engine changes don't break anything**

```bash
cd /Users/xupeng/dev/github/petri && npx vitest run
```

Expected: ALL tests PASS

- [ ] **Step 3: Fix any issues found**

If validate or tests fail, fix the issues and recommit.

- [ ] **Step 4: Final commit in petri repo for engine changes**

```bash
cd /Users/xupeng/dev/github/petri
git add docs/superpowers/plans/2026-04-06-breakout-automl.md
git commit -m "docs: add breakout automl implementation plan"
```
