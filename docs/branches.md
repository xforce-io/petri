# Petri Branches

Petri branches are named experiment lines. They let related runs share a local history while keeping separate optimization directions isolated.

Branches are not Git branches. They borrow Git's vocabulary for lineage, but they track Petri runs and artifacts under `.petri/branches/`.

## Concepts

| Term | Meaning |
| --- | --- |
| Branch | A named line of investigation with its own run sequence and artifacts. |
| Run | One pipeline execution inside a branch, stored as `run-NNN`. |
| Seed | An external source used to initialize a branch, such as a production strategy file. |
| Fork | A new Petri branch created from an existing Petri branch run. |
| Promotion | Copying a validated Petri result back into the target project as a production artifact. |

## Directory Layout

```text
.petri/
  branches/
    factor-weight-search/
      branch.yaml
      artifacts/
      runs/
        run-001/
          run.json
          run.log
```

Each branch has independent run numbering. `factor-weight-search/run-001` and `risk-off-search/run-001` are different runs.

## Seed vs Fork

Use `seeded_from` when a branch starts from an external fact outside Petri. Common examples:

- A production strategy config in another repository.
- A model checkpoint created by a separate training system.
- A manually selected baseline artifact.

Use `forked_from` only when a branch starts from a Petri branch run.

```text
External project artifact
  -> seeded_from
  -> Petri branch

Petri branch/run
  -> forked_from
  -> Petri branch
```

Do not use `forked_from` for an external strategy file. That would imply the strategy was produced by a Petri run.

## Create a Seeded Branch

```bash
petri branch init factor-weight-search \
  --baseline run_007_production \
  --seed-project quantitative_trading \
  --seed-strategy-id run_007_production \
  --seed-strategy-path config/strategies/rotation/run_007_production.json \
  --seed-reason "Start from the published production SOTA strategy" \
  --objective "Tune live-ready factor weights"
```

This writes:

```yaml
schema_version: 1
branch_id: factor-weight-search
status: active
objective: Tune live-ready factor weights
baseline: run_007_production
seeded_from:
  type: external_strategy
  project: quantitative_trading
  strategy_id: run_007_production
  strategy_path: config/strategies/rotation/run_007_production.json
  reason: Start from the published production SOTA strategy
  seeded_at: "2026-05-20T06:16:41.367Z"
```

## Run Within a Branch

```bash
petri run --branch factor-weight-search
petri status --branch factor-weight-search
petri log --branch factor-weight-search --run 001
```

Branch runs are stored under:

```text
.petri/branches/factor-weight-search/runs/run-001/
```

## Fork From a Petri Run

Use `fork` when a Petri run produced a useful state or artifact and a new branch should explore a different direction from that point.

```bash
petri branch fork risk-off-universe-search \
  --from-branch factor-weight-search \
  --from-run 003 \
  --artifact candidate_strategy.json \
  --baseline run_007_production \
  --reason "Factor-weight candidate exposed risk-off concentration risk" \
  --objective "Explore risk-off universe variants"
```

This writes:

```yaml
schema_version: 1
branch_id: risk-off-universe-search
status: active
objective: Explore risk-off universe variants
baseline: run_007_production
forked_from:
  type: branch_run
  branch_id: factor-weight-search
  run_id: run-003
  artifact: candidate_strategy.json
  reason: Factor-weight candidate exposed risk-off concentration risk
  forked_at: "2026-05-20T06:16:41.367Z"
```

## When to Fork

Fork when a run suggests a distinct search direction that should not pollute the current branch.

Good fork points:

- A run passes gates and exposes a new optimization target.
- A rejected run fails the primary metric but reveals a strong secondary signal.
- A branch has stalled and needs a wider search space.
- A cross-branch comparison identifies a champion run worth combining with another idea.

Stay in the same branch when the next run is just a small local adjustment to the same hypothesis.

## Promotion Boundary

Petri records candidates and evidence. It does not make an external artifact production-ready by itself.

A winning branch run should be promoted explicitly into the target project. For example:

```text
Petri artifact:
  .petri/branches/factor-weight-search/artifacts/iteration-004/candidate_strategy.json

Promoted project artifact:
  config/strategies/rotation/run_008_production.json
  config/strategies/rotation/sota.json
```

After promotion, future Petri branches should seed from the new production artifact instead of relying on old branch artifacts.

## Quick Reference

```bash
petri branch init <id> \
  --seed-project <project> \
  --seed-strategy-id <strategy-id> \
  --seed-strategy-path <path> \
  --baseline <baseline> \
  --objective <text>

petri run --branch <id>
petri status --branch <id>
petri log --branch <id> --run 001

petri branch fork <new-id> \
  --from-branch <parent-id> \
  --from-run 001 \
  --artifact <artifact-path> \
  --objective <text>

petri branch list
```

