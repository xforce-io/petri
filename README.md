# Petri — Evolutionary Agent Harness

**Set the conditions. Watch it evolve.**

Petri is an evolutionary agent harness. You define goals, roles, and quality gates — the system iterates autonomously until output meets your criteria, or tells you it's stuck. No hand-holding. No step-by-step scripting. Just constraints and evolution.

Named after the Petri dish: provide a culture medium, inoculate strains, set growth conditions, observe what emerges.

[Design](docs/design.md) · [Branches](docs/branches.md) · [Examples](#examples) · [Quick Start](#quick-start) · [Web Dashboard](#web-dashboard)

## Why Petri

Most multi-agent frameworks ask you to choreograph agents: who talks to whom, in what order, with what handoff logic. You're writing a screenplay.

Petri takes a different approach. You define:

- **Roles** — independent agents with personas, playbooks, and expertise
- **Quality gates** — measurable acceptance criteria (does the code compile? did the model beat 75% accuracy?)
- **Retry budget** — how many attempts the system gets

Then you step back. The harness runs agents, checks gates, injects failure context into the next attempt, detects stagnation, and either converges on a passing result or reports exactly where it got stuck.

**The core insight**: quality gates + failure injection + retry = an evolutionary loop. Each iteration gets smarter because the agent sees what failed before and why. The system self-corrects without human intervention.

## What Makes It Different

| | Traditional Orchestration | Petri |
|---|---|---|
| **Approach** | Script agent interactions | Define constraints, let agents iterate |
| **Quality** | Hope the output is good | Gate-checked — provably meets criteria |
| **Failure** | Pipeline stops or you debug | Auto-retry with failure context injection |
| **Stagnation** | Burns through retries blindly | Detects repeated failures, stops early |
| **New scenario** | Rewrite orchestration logic | Add a role directory, done |

## The Evolutionary Loop

```
     ┌─────────────────────────────────────┐
     │                                     │
     ▼                                     │
  Agent executes                           │
     │                                     │
     ▼                                     │
  Gate checks artifacts                    │
     │                                     │
   Pass? ──yes──▶ Next stage               │
     │                                     │
    no                                     │
     │                                     │
     ▼                                     │
  Inject failure context ─────────────────►┘
  + attempt history
  + stagnation detection
```

Each retry isn't blind — the agent receives the full history of what was tried and why it failed. Two consecutive identical failures trigger stagnation detection and early termination, saving time and cost.

## Scenario Generalization

Same harness, different roles. Adding a new scenario = adding a directory:

```
roles/
  your_new_role/
    role.yaml       # Model, playbooks
    soul.md         # Persona
    gate.yaml       # What "done" means
    playbooks/
      do_the_thing.md
```

No engine code changes. No orchestration rewiring. The pipeline doesn't know or care what the agents do — it only checks whether the gates pass.

Role playbooks are prompt fragments scoped to a role.

**Built-in examples spanning wildly different domains:**

| Scenario | Roles | What it does |
|----------|-------|-------------|
| [Code Development](src/templates/code-dev) | designer, developer, reviewer | Design → implement → code review with test gates |
| [ML Training](examples/ml-training) | problem_definer, architect, researcher, tester | Iterative model training until accuracy threshold met |
| [Structured Debate](examples/debate) | proposer, opponent, judge | Multi-round debate with judge scoring |
| [Detective Mystery](examples/detective-mystery) | storyteller, detective, judge | Interactive investigation with evidence gathering |

All powered by the same engine. The only difference is the roles directory.

## Quick Start

**Node >= 20** required. **Recommended entry: Web UI** (single-user, local).

```bash
# From source
git clone https://github.com/xforce-io/petri.git
cd petri && npm install && npm run build

# Product UI — works even with zero projects (create from a preset template in the browser)
petri web
# → http://localhost:3000
```

Or via CLI:

```bash
petri init --template code-dev
petri run --input "Build a CLI calculator in Python"
petri status
petri log
```

## Web (product entry)

```bash
petri web
# → http://localhost:3000
```

- **Home** — onboarding when empty; create a project from a **preset template**; stats + recent runs when a project exists
- **Runs** — start runs, history, evolution view (stage / attempt / gate / blocked reason), logs, artifacts
- **Config** — edit instance pipeline/roles, validate, save
- **Create** — experimental NL generator (not the primary path; prefer Home → template)

Multi-project: run `petri web` from a parent directory to auto-discover Petri projects underneath. New projects from templates are created under the workspace (cwd).

## Configuration

### Pipeline

```yaml
name: code-dev
stages:
  - name: design
    roles: [designer]
    max_retries: 2

  - name: develop
    roles: [developer]
    max_retries: 5
    timeout: 300000          # 5 min per attempt
    overrides:               # Per-role model override
      developer:
        model: opus

  - name: review
    roles: [code_reviewer]
    gate_strategy: all       # all | majority | any
```

Iterative loops:

```yaml
  - repeat:
      name: train-eval-loop
      max_iterations: 10
      until: target-met      # Gate ID
      stages:
        - name: train
          roles: [trainer]
        - name: evaluate
          roles: [evaluator]
```

### Gate

```yaml
id: tests-pass
evidence:
  path: "{stage}/{role}/results.json"
  check:
    field: all_passed
    equals: true
```

A gate is the definition of "done" for a role. If it doesn't pass, the stage retries. If it keeps failing the same way, stagnation detection kicks in.

### Provider

```yaml
# petri.yaml
providers:
  default:
    type: grok           # grok (default) | codex | claude_code | milkie | pi

models:
  sonnet:
    provider: default
    model: claude-sonnet-4-6

defaults:
  model: sonnet
  max_retries: 3
```

`role.yaml` 可用可选的 `provider` 选择 `petri.yaml.providers` 中的命名 Provider；未设置时沿用默认模型对应的 Provider（保持旧项目行为）。角色的 `model` 与该 Provider 的命名模型应匹配，错误引用会在 `petri validate` 或运行前报错，不会静默回退。

```yaml
# petri.yaml
providers:
  coding:
    type: codex
  review:
    type: grok
models:
  coding:
    provider: coding
    model: default
  review:
    provider: review
    model: default
defaults:
  model: coding
  gate_strategy: all
  max_retries: 3

# roles/code_reviewer/role.yaml
provider: review
model: review
```

没有 `provider` 配置时仍使用历史选择规则：**grok > codex > claude_code > milkie > pi**；空 `providers` 时为 **grok**。

CLI-backed providers (`grok`, `codex`, `claude_code`) spawn the local CLI, write `_prompt.md` / `_agent_run.json` under the stage artifact dir, and scan produced files. Override binaries with `PETRI_GROK_BIN` / `PETRI_CODEX_BIN` when needed.

## CLI

```bash
petri init [--template <name>]     # Scaffold project
petri run [--pipeline <file>]      # Execute pipeline
petri run --skip-to <stage> --resume-run <run-id> # Continue from a recorded run
petri run --branch <id>             # Execute under a named exploration branch
petri status                       # Latest run status
petri status --branch <id>          # Latest run status within a branch
petri log [--run <id>]             # View logs
petri log --branch <id>             # View logs within a branch
petri branch init <id>              # Create an exploration branch
petri branch fork <id>              # Fork a branch from an existing branch run
petri branch list                   # List exploration branches
petri list templates               # Available templates
petri list playbooks               # Built-in playbooks
petri validate                     # Check configuration
petri web [--port <number>]        # Web dashboard
```

### 从 GitHub Issue 启动 code-dev

可把当前项目仓库的 GitHub Issue URL 直接作为输入：

```bash
petri run --input https://github.com/<owner>/<repo>/issues/<number>
```

Petri 会通过已登录的 `gh` CLI 读取 Issue 正文和全部评论，再将它们传给
`issue_analyst`。URL 必须属于当前 Git `origin`；无权限、Issue 不存在或评论
读取失败时，运行会在启动前明确失败，不会退化为不完整的纯文本需求。

### 断点续跑与流程链路

当某次运行在后续阶段需要重试时，显式指定来源 run 与继续阶段：

```bash
petri run --skip-to unit_test --resume-run 002
```

`--resume-run` 必须与 `--skip-to` 一起使用，且来源 run 必须存在。新的
`run.json` 会记录 `resumedFrom`，Runs 详情页以可点击的「研发流程」链路展示
来源 run 和本次续跑；旧 run 没有该字段时仍可照常查看，但不会被推断为有链路。

### Exploration Branches

A branch is a named, independent line of investigation. Use branches when several optimization directions should each have their own run history instead of sharing one global `run-001`, `run-002`, ... sequence.

Branches can start in two ways:

- `seeded_from` records an external source, such as a production strategy file in another project.
- `forked_from` records a Petri branch/run parent.

```bash
petri branch init factor-weight-search \
  --baseline run_007_production \
  --seed-project quantitative_trading \
  --seed-strategy-id run_007_production \
  --seed-strategy-path config/strategies/rotation/run_007_production.json \
  --objective "Tune live-ready factor weights"

petri run --branch factor-weight-search
petri status --branch factor-weight-search
petri log --branch factor-weight-search --run 001
```

Fork a sibling branch from a useful Petri run:

```bash
petri branch fork risk-off-universe-search \
  --from-branch factor-weight-search \
  --from-run 003 \
  --artifact candidate_strategy.json \
  --baseline run_007_production \
  --reason "Factor-weight candidate exposed risk-off concentration risk" \
  --objective "Explore risk-off universe variants"
```

The child branch records lineage in `branch.yaml`:

```yaml
forked_from:
  type: branch_run
  branch_id: factor-weight-search
  run_id: run-003
  artifact: candidate_strategy.json
```

Branched runs are stored under:

```text
.petri/branches/<id>/runs/run-NNN/
.petri/branches/<id>/artifacts/
```

See [Petri Branches](docs/branches.md) for the full branch, seed, fork, and promotion model.

## Engine Internals

- **Unrestricted file access** — agents can read/write any path on the host (not sandboxed to the project directory), useful for cross-repo workflows
- **Parallel roles** — multiple roles within a stage run concurrently
- **Failure context injection** — attempt history is formatted and injected into agent context
- **Stagnation detection** — SHA-256 hash of failure reason; consecutive identical hashes → early block
- **Agent timeout** — configurable per-stage (default 10 min), prevents hanging
- **Artifact manifest** — tracks all outputs, provides context to downstream stages
- **Run history** — structured JSON + text logs per run in `.petri/runs/run-NNN/` or `.petri/branches/<id>/runs/run-NNN/`

## Development

```bash
npm install
npm test                   # vitest
npm run dev -- run ...     # Dev mode
npm run build              # tsup → dist/
```

## License

MIT
