# Petri — Evolutionary Agent Harness

**Set the conditions. Watch it evolve.**

Petri is an evolutionary agent harness. You define goals, roles, and quality gates — the system iterates autonomously until output meets your criteria, or tells you it's stuck. No hand-holding. No step-by-step scripting. Just constraints and evolution.

Named after the Petri dish: provide a culture medium, inoculate strains, set growth conditions, observe what emerges.

[Design](docs/design.md) · [Examples](#examples) · [Quick Start](#quick-start) · [Web Dashboard](#web-dashboard)

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

**Node >= 20** required.

```bash
# From source
git clone https://github.com/xforce-io/petri.git
cd petri && npm install && npm run build

# Scaffold a project
petri init --template code-dev

# Run it
petri run --input "Build a CLI calculator in Python"

# Watch the evolution
petri status
petri log
```

## Web Dashboard

```bash
petri web
# → http://localhost:3000
```

- **Dashboard** — overview: stats cards (total runs, success rate, cost), recent runs
- **Runs** — start runs, browse history, drill into run detail (stage timeline, per-stage logs, artifacts, gate results)
- **Config** — edit pipelines, roles, and config files with YAML validation

Multi-project: run `petri web` from a parent directory to auto-discover all Petri projects underneath.

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
    type: pi             # pi | claude_code

models:
  sonnet:
    provider: default
    model: claude-sonnet-4-6

defaults:
  model: sonnet
  max_retries: 3
```

## CLI

```bash
petri init [--template <name>]     # Scaffold project
petri run [--pipeline <file>]      # Execute pipeline
petri status                       # Latest run status
petri log [--run <id>]             # View logs
petri list templates               # Available templates
petri list playbooks               # Built-in playbooks
petri validate                     # Check configuration
petri web [--port <number>]        # Web dashboard
```

## Engine Internals

- **Unrestricted file access** — agents can read/write any path on the host (not sandboxed to the project directory), useful for cross-repo workflows
- **Parallel roles** — multiple roles within a stage run concurrently
- **Failure context injection** — attempt history is formatted and injected into agent context
- **Stagnation detection** — SHA-256 hash of failure reason; consecutive identical hashes → early block
- **Agent timeout** — configurable per-stage (default 10 min), prevents hanging
- **Artifact manifest** — tracks all outputs, provides context to downstream stages
- **Run history** — structured JSON + text logs per run in `.petri/runs/run-NNN/`

## Development

```bash
npm install
npm test                   # vitest
npm run dev -- run ...     # Dev mode
npm run build              # tsup → dist/
```

## License

MIT
