# Breakout AutoML — Design Spec

**Date:** 2026-04-06
**Goal:** Achieve peak_reward >= 30 on BreakoutNoFrameskip-v4 via automated multi-agent training loop
**Project path:** `~/lab/petri/breakout/`

---

## 1. Overview

An automated RL training system orchestrated by petri. Five agents collaborate in a nested loop: an outer loop evolves algorithm choices (DQN → Double DQN → Dueling → Rainbow), an inner loop optimizes hyperparameters within each algorithm. Training runs on local MPS (M2 Max, 32GB).

Training code is written from scratch by the Coder agent. Historical experiment data (~24 prior DQN runs, best peak_reward ~7.86) is provided as seed data.

## 2. Roles

### 2.1 Director (Strategic Layer)

**Responsibility:** Decide algorithm direction across the outer loop.

- First iteration: outputs `action: start, algorithm: DQN` (cold start)
- Subsequent iterations: reads `history.json`, compares last 2 rounds of peak_reward
  - improvement < 10% → `action: pivot`, selects next algorithm from roadmap
  - peak_reward >= 30 → `action: done`
  - otherwise → `action: tune`
- Algorithm roadmap: DQN → Double DQN → Dueling DQN → Rainbow
- Output: `direction.yaml`

### 2.2 Scientist (Tactical Layer)

**Responsibility:** Design hyperparameter experiments within the current algorithm.

- Reads `direction.yaml` for current algorithm
- Reads `history.json` to analyze explored parameter space
- Designs 1-3 experiment configs per round, avoiding redundant configs
- Prioritizes parameters with high feature importance from historical data
- Output: `experiment_plan.yaml`

### 2.3 Coder (Execution Layer)

**Responsibility:** Write and maintain training code.

- **bootstrap stage:** Write complete training framework
  - DQN network, training loop, environment wrappers, config system
  - Must support MPS device
  - Must be config-driven and algorithm-pluggable
  - Verified by: `python train.py --config global.yaml --device mps --steps 1000`
- **implement stage:** When Director says `pivot`, implement new algorithm. When `tune`, output "no changes needed".
- Output: runnable training scripts

### 2.4 Trainer (Execution Layer)

**Responsibility:** Execute training runs and monitor progress.

- Reads `experiment_plan.yaml`, generates `global.yaml` for each experiment
- Launches training, monitors log output
- Early stop: if reward < 0.5 after 500K steps
- Output: training logs + `metrics_summary.json` per experiment

### 2.5 Analyst (Execution Layer)

**Responsibility:** Analyze results and maintain experiment history.

- Parses training logs, computes: peak_reward, final_reward, convergence_speed, loss stats
- Merges with `history.json` (cumulative across all rounds)
- Computes `improvement_pct` (this round's best vs historical best)
- Output: `metrics.json`, `report.md`, updated `history.json`

## 3. Pipeline Structure

```yaml
name: breakout-automl
goal: "Achieve peak_reward >= 30 on BreakoutNoFrameskip-v4"

stages:
  - name: bootstrap
    roles: [coder]
    max_retries: 3

  - repeat:
      name: evolve
      max_iterations: 5
      until: target-reached
      stages:
        - name: direct
          roles: [director]
          max_retries: 1

        - name: implement
          roles: [coder]
          max_retries: 3

        - repeat:
            name: optimize
            max_iterations: 5
            until: algo-saturated
            stages:
              - name: design
                roles: [scientist]
                max_retries: 2

              - name: train
                roles: [trainer]
                max_retries: 2
                timeout: 21600000

              - name: analyze
                roles: [analyst]
                max_retries: 1
```

## 4. Gates

### 4.1 code-runnable (bootstrap)

```yaml
id: code-runnable
description: "Training script passes mini training (1000 steps)"
evidence:
  path: "bootstrap/coder/test_run.json"
  check:
    field: success
    equals: true
```

### 4.2 direction-valid (direct)

```yaml
id: direction-valid
description: "Director outputs valid direction.yaml"
evidence:
  path: "direct/director/direction.yaml"
  check:
    field: action
    in: [start, tune, pivot, done]
```

### 4.3 algo-saturated (optimize exit)

```yaml
id: algo-saturated
description: "Current algorithm saturated or target reached"
evidence:
  path: "analyze/analyst/metrics.json"
  check:
    - field: peak_reward
      gte: 30
    - field: improvement_pct
      lt: 10
```

Note: algo-saturated uses OR logic — either condition triggers exit.

### 4.4 target-reached (evolve exit)

```yaml
id: target-reached
description: "peak_reward >= 30"
evidence:
  path: "analyze/analyst/metrics.json"
  check:
    field: peak_reward
    gte: 30
```

## 5. Artifact Data Flow

```
.petri/artifacts/
  bootstrap/coder/
    train.py                    # Main training script
    models/dqn.py               # Network definitions
    utils/wrappers.py           # Environment wrappers
    config_template.yaml        # Config template
    test_run.json               # Mini training verification

  direct/director/
    direction.yaml              # {action, algorithm, reason}

  implement/coder/
    # Only populated when Director says pivot

  design/scientist/
    experiment_plan.yaml        # {experiments: [{name, params}]}

  train/trainer/
    results/<exp_name>/
      global.yaml               # Actual config used
      log/atari.log             # Training log
      metrics_summary.json      # Key metrics after training

  analyze/analyst/
    metrics.json                # {peak_reward, improvement_pct, best_config}
    report.md                   # Human-readable analysis
    history.json                # Cumulative experiment history
```

Key: `history.json` is the central knowledge store. Analyst appends each round. Scientist and Director read it for decision-making.

## 6. Petri Engine Changes

Two modifications to petri core, no backward compatibility needed:

### 6.1 Nested Repeat Blocks

`RepeatBlock.stages` changes from `StageConfig[]` to `StageEntry[]`. Engine's `runRepeatBlock` recurses when encountering nested RepeatBlocks.

```typescript
// types.ts
export interface RepeatBlock {
  repeat: {
    name: string;
    max_iterations: number;
    until: string;
    stages: StageEntry[];  // was StageConfig[]
  };
}
```

### 6.2 Gate Comparison Operators

Extend `GateCheck` with numeric comparison and set membership:

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
```

Gate evaluation: all specified operators must pass for the check to pass.

## 7. Project Directory

```
~/lab/petri/breakout/
  petri.yaml
  pipeline.yaml
  roles/
    director/   (role.yaml, soul.md, gate.yaml, skills/decide.md)
    scientist/  (role.yaml, soul.md, gate.yaml, skills/design_experiment.md)
    coder/      (role.yaml, soul.md, gate.yaml, skills/write_training_code.md)
    trainer/    (role.yaml, soul.md, gate.yaml, skills/run_training.md)
    analyst/    (role.yaml, soul.md, gate.yaml, skills/analyze_results.md)
  seeds/
    historical_results.csv
    baseline_config.yaml
```

## 8. Environment

- Hardware: MacBook Pro M2 Max, 32GB
- Device: MPS (PyTorch 2.4, MPS backend)
- Provider: Claude Code
- Estimated time per training run (2M steps): 3-5 hours on MPS
- Resource budget: unlimited, user will observe and may interrupt
