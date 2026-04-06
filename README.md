# Petri — Multi-Agent Stage Runner

**Petri** is a _multi-agent pipeline orchestrator_. Define goals, constraints, roles, and stopping conditions — then watch agents evolve creative output.

Named after the Petri dish (provide a medium, inoculate strains, set conditions, observe evolution) and the Petri net (formal model for concurrent systems).

[Design](docs/design.md) · [Examples](#examples) · [Quick Start](#quick-start) · [Web Dashboard](#web-dashboard) · [Configuration](#configuration)

## How It Works

```
Pipeline orchestrates → Stage activates → Role provides persona + skills
                                              ↓
                                        Agent Provider creates agent
                                              ↓
                                        Agent executes (tool-use loop)
                                              ↓
                                        Produces Artifacts
                                              ↓
                                        Gate checks artifacts
                                              ↓
                                   Pass → next stage / Fail → retry
```

Five core concepts:

- **Pipeline** — stage orchestration with retry and `repeat` loop blocks
- **Role** — self-contained agent plugin (persona, skills, gate declaration)
- **Skill** — markdown instructions describing how a role does its work
- **Artifact** — role output written to `.petri/artifacts/{stage}/{role}/`
- **Gate** — declarative constraint checked against artifacts (existence + JSON field checks)

## Quick Start

Runtime: **Node >= 20**.

```bash
# Install
npm install -g petri
# or from source:
git clone https://github.com/xforce-io/petri.git
cd petri && npm install && npm run build

# Initialize a project from a template
petri init --template code-dev

# Run the pipeline
petri run --input "Build a CLI calculator in Python"

# Check status
petri status

# View logs
petri log
```

## Install

```bash
npm install -g petri
```

From source:

```bash
git clone https://github.com/xforce-io/petri.git
cd petri
npm install
npm run build
```

Development mode (auto-reload):

```bash
npm run dev -- run --input "your task"
```

## CLI Commands

```bash
petri init [--template <name>]     # Scaffold a new project
petri run [--pipeline <file>] [--input <text>] [--from <file>]
petri status                       # Show latest run status
petri log [--run <id>]             # View run logs
petri list templates               # List available templates
petri list skills                  # List built-in skills
petri validate                     # Check project configuration
petri web [--port <number>]        # Start web dashboard
```

## Web Dashboard

```bash
petri web
# → http://localhost:3000
```

Three tabs:

- **Dashboard** — project overview with stats (total runs, success rate, cost) and recent runs list
- **Runs** — start new runs, browse history, click into run detail with stage timeline, logs, artifacts, and gate results
- **Config** — edit `petri.yaml`, `pipeline.yaml`, and role files with YAML validation

Multi-project mode: run `petri web` from a parent directory and it auto-discovers all subdirectories containing `petri.yaml`.

```bash
cd examples/
petri web
# Discovers: debate, detective-mystery, fizzbuzz, ml-training
# Switch between projects via the dropdown in the nav bar
```

## Configuration

### Project Structure

```
my-project/
  petri.yaml              # Global config (providers, models, defaults)
  pipeline.yaml           # Pipeline definition
  roles/
    researcher/
      role.yaml           # Model, skills references
      soul.md             # Persona description
      gate.yaml           # Quality gate (optional)
      skills/
        deep_research.md  # Custom skill
  .petri/                 # Runtime artifacts (gitignored)
    runs/                 # Run history
    artifacts/            # Stage outputs
```

### petri.yaml

```yaml
providers:
  default:
    type: pi              # pi | claude_code | codex

models:
  opus:
    provider: default
    model: claude-opus-4-6
  sonnet:
    provider: default
    model: claude-sonnet-4-6
  haiku:
    provider: default
    model: claude-haiku-4-5

defaults:
  model: sonnet
  gate_strategy: all      # all | majority | any
  max_retries: 3

web:
  port: 3000
```

### pipeline.yaml

Linear stages:

```yaml
name: code-dev
description: Design, develop, and review code

stages:
  - name: design
    roles: [designer]
    max_retries: 2

  - name: develop
    roles: [developer]
    max_retries: 5
    overrides:
      developer:
        model: opus       # Override model for this stage

  - name: review
    roles: [code_reviewer]
    max_retries: 2
    gate_strategy: all

input:
  description: "What to build"
```

Iterative loops with `repeat`:

```yaml
stages:
  - name: data_prep
    roles: [data_engineer]

  - repeat:
      name: train_loop
      max_iterations: 10
      until: target-met         # Gate ID to check
      stages:
        - name: train
          roles: [trainer]
          max_retries: 3
        - name: evaluate
          roles: [evaluator]
```

### role.yaml

```yaml
persona: soul.md
model: sonnet
skills:
  - petri:file_operations   # Built-in skill
  - petri:shell_tools        # Built-in skill
  - deep_research.md         # Local skill (in skills/ directory)
```

### gate.yaml

```yaml
id: tests-pass
description: All tests must pass
evidence:
  path: "{stage}/{role}/test-results.json"
  check:
    field: all_passed
    equals: true
```

Gate strategies: `all` (every gate must pass), `majority` (>50%), `any` (at least one).

## Engine Features

- **Parallel role execution** — multiple roles within a stage run concurrently
- **Retry with context injection** — failed attempt history is injected into agent context so it avoids repeating mistakes
- **Stagnation detection** — consecutive identical failures block early instead of burning retries
- **Agent timeout** — configurable per-stage or global timeout (default: 10 minutes) prevents hanging agents
- **Repeat blocks** — iterative loops that continue until a gate passes or max iterations reached
- **Pipeline overrides** — override model per role at the stage level
- **Run history** — each run saved to `.petri/runs/run-NNN/` with structured JSON and text logs

## Agent Providers

| Provider | Type | Description |
|----------|------|-------------|
| **Pi** (default) | `pi` | Based on `pi-agent-core` + `pi-ai`. Tool-use loop with `shell_run`, `file_read`, `file_write`. |
| **Claude Code** | `claude_code` | Invokes `claude` CLI with JSON output mode. Full tool chain (MCP, file ops). |
| **Codex** | `codex` | Planned. |

New providers implement the `AgentProvider` interface and register in `petri.yaml`.

## Built-in Skills

| Skill | Prefix | Description |
|-------|--------|-------------|
| File Operations | `petri:file_operations` | Read, write, and manage files |
| Shell Tools | `petri:shell_tools` | Execute shell commands |

Reference skills in `role.yaml` with the `petri:` prefix. Custom skills are markdown files in the role's `skills/` directory.

## Examples

| Example | Pipeline | Description |
|---------|----------|-------------|
| [code-dev](src/templates/code-dev) | design → develop → review | Code generation with design, implementation, and review stages |
| [fizzbuzz](examples/fizzbuzz) | design → develop → review | Simple coding task |
| [debate](examples/debate) | propose → oppose → judge (repeat) | Structured debate with iterative rounds |
| [detective-mystery](examples/detective-mystery) | story → investigate → judge (repeat) | Interactive detective story |
| [ml-training](examples/ml-training) | define → design → develop → test (repeat) | ML model training with iterative refinement |

Run an example:

```bash
cd examples/ml-training
petri run
```

## Development

```bash
npm install
npm test              # Run tests (vitest)
npm run test:watch    # Watch mode
npm run build         # Build with tsup
npm run dev -- <cmd>  # Run CLI in dev mode
```

## Tech Stack

- **Language**: TypeScript
- **Agent runtime**: pi-agent-core + pi-ai
- **CLI**: commander
- **Config**: yaml
- **Build**: tsup
- **Test**: vitest
- **Web**: Node native `http` + vanilla JS (no frameworks)

## License

MIT
