# Petri Design Spec

通用 multi-agent stage runner。设定目标、约束、角色和停止条件，让系统演化出创造性产出。

名称来自培养皿（Petri dish）——提供培养基（约束）、接种菌株（角色）、设定条件（目标），
观察演化。同时指向 Petri net（并发系统形式化模型）。

---

## 1. 核心概念

五个核心概念：

### Pipeline

阶段编排。定义 stage 顺序、重试策略，支持线性流程和 `repeat` 循环块。

```yaml
# pipeline.yaml
name: deep-research
description: 多角色深度研究

stages:
  - name: research
    roles: [researcher]
    max_retries: 3

  - name: fact_check
    roles: [fact_checker]
    max_retries: 2

  - name: critique
    roles: [devil_advocate, domain_expert]
    gate_strategy: all            # all | majority | any，默认 all
    max_retries: 2

  - name: synthesize
    roles: [synthesizer]

input:
  description: "研究主题或问题"
```

循环用 `repeat` 块：

```yaml
stages:
  - name: data_prep
    roles: [data_engineer]

  - repeat:
      name: train_loop
      max_iterations: 10
      until:
        artifact: "evaluate/evaluator/metrics.json"
        field: target_met
        equals: true
      stages:
        - name: train
          roles: [trainer]
          max_retries: 3
        - name: evaluate
          roles: [evaluator]
```

`repeat` 内每个 stage 保留独立的 `max_retries`（stage 级重试）。
`max_iterations` 控制整个循环块的最大轮次（repeat 级循环）。
Stage 重试耗尽 → 整个 run blocked；repeat 迭代耗尽 → 整个 run blocked。

### Role

自包含的角色插件。自带人格、技能、gate 声明。工作流和角色完全解耦——同一个角色可以
出现在完全不同的 pipeline 里，同一个 pipeline 可以插入任意角色。

```
roles/
  researcher/
    role.yaml         # model、skills 引用
    soul.md           # 人格描述
    gate.yaml         # 约束声明（可选）
    skills/
      deep_research.md
```

### Skill

Markdown 指令，描述角色如何完成工作。分内置（`petri:` 前缀）和自定义两类。
Skill 不是可调度的任务单元，而是角色的能力描述——agent 拿到全部 skills 后自行决定如何使用。

### Artifact

角色的产出物。写入约定路径（`.petri/artifacts/{stage}/{role}/`），
engine 通过 manifest.json 追踪路径和描述，但不读取内容。
下一个 stage 的 agent 通过 file_read 按需读取前序 artifact。

### Gate

跟随 role 的声明式约束。通过检查 artifact 是否存在且满足条件来判定。
Gate 分布式配置在每个 role 目录下，不集中管理。
加一个新角色 = 加一个目录（含 gate.yaml），engine 代码不动。

```yaml
# roles/fact_checker/gate.yaml
requires:
  fact_check_completed: true
evidence:
  type: artifact
  path: "{stage}/{role}/fact_check_result.json"
  check:
    field: all_claims_verified
    equals: true
```

### 概念关系

```
Pipeline 编排 → Stage 激活 → Role 提供 persona + skills
                                    ↓
                              Agent Provider 创建 agent
                                    ↓
                              Agent 执行 skill（tool-use loop）
                                    ↓
                              产出 Artifact（写入约定路径）
                                    ↓
                              Gate 检查 artifact
                                    ↓
                         通过 → 下一个 stage / 不通过 → 重试
```

---

## 2. 项目结构与配置

### 用户项目结构

```
my-project/
  petri.yaml                  # 全局配置（providers, models, defaults）
  pipeline.yaml               # 默认 pipeline（可以有多个 pipeline-*.yaml）
  roles/
    researcher/
      role.yaml               # model、skills 引用、provider 覆盖
      soul.md                 # 人格描述
      gate.yaml               # 约束声明（可选）
      skills/
        deep_research.md
    fact_checker/
      role.yaml
      soul.md
      gate.yaml
      skills/
        verify_claims.md
  skills/                     # 项目级共享 skill（可选）
    custom_tool.md
  .petri/                     # 运行时产物（gitignore）
    artifacts/
      manifest.json           # engine 维护的 artifact 索引
      {stage}/{role}/*.json
    runs/                     # 运行历史
      run-001/
        log.jsonl             # 结构化日志
        artifacts/            # 该次运行的 artifact 快照
```

### petri.yaml

```yaml
providers:
  default:
    type: pi                     # 默认用 pi-agent-core
  claude:
    type: claude_code            # 可选
  codex:
    type: codex                  # 可选

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
  model: sonnet                  # 角色未指定 model 时的默认值
  gate_strategy: all
  max_retries: 3

web:
  port: 3000
```

model 绑定优先级：**pipeline override > role.yaml > defaults**

```yaml
# pipeline.yaml 可以覆盖角色默认 model
stages:
  - name: review
    roles: [code_reviewer]
    overrides:
      code_reviewer:
        model: opus              # 覆盖 role 默认的 sonnet
```

### role.yaml

```yaml
persona: soul.md
model: opus                      # 可选，覆盖 defaults
skills:
  - petri:web_search             # 内置 skill
  - petri:file_operations        # 内置 skill
  - deep_research.md             # 本地 skill（角色目录下）
```

---

## 3. Engine 核心逻辑

Engine 极薄，只做 pipeline 推进、gate 检查、重试控制。不碰 artifact 内容，不干预 agent 行为。

### 主循环

```typescript
async function run(pipeline: Pipeline, input: string) {
  const runId = createRunId()
  const manifest = new ArtifactManifest()

  for (const stage of pipeline.stages) {
    if (stage.type === 'repeat') {
      await executeRepeat(stage, input, manifest)
      continue
    }

    let attempt = 0
    let stagePassed = false
    let failureContext = ''
    const attempts: AttemptRecord[] = []
    let lastFailureHash = ''

    while (!stagePassed && attempt < stage.maxRetries) {
      attempt++

      // 1. 为每个 role 创建 agent 并并行执行
      const results = await Promise.all(
        stage.roles.map(role =>
          executeRole(role, {
            input, manifest, failureContext, stageName: stage.name,
            attemptHistory: attempts,   // 轮次记忆注入
          }))
      )

      // 2. 收集 artifact，更新 manifest
      manifest.collect(stage.name, results)

      // 3. 检查 gate
      const gates = collectGates(stage.roles)
      const gateResult = checkGates(gates, stage.gateStrategy)

      if (gateResult.passed) {
        stagePassed = true
      } else {
        failureContext = gateResult.reason

        // 记录本轮尝试
        attempts.push({
          attempt,
          failureReason: gateResult.reason,
          failureHash: hash(gateResult.reason),
        })

        // 收敛检测：连续相同错误 → 提前 blocked
        const currentHash = hash(gateResult.reason)
        if (currentHash === lastFailureHash) {
          return {
            status: 'blocked',
            stage: stage.name,
            reason: `stagnant: same failure in attempts ${attempt - 1} and ${attempt}`,
          }
        }
        lastFailureHash = currentHash
      }
    }

    if (!stagePassed) {
      return { status: 'blocked', stage: stage.name }
    }
  }

  return { status: 'done' }
}
```

### Role 执行

```typescript
async function executeRole(roleName: string, context: RunContext) {
  const role = loadRole(roleName)
  const provider = resolveProvider(role)

  const agent = provider.createAgent({
    persona: role.soul,
    skills: role.skills,
    context: buildContext(context),
    artifactDir: `.petri/artifacts/${context.stageName}/${roleName}/`,
    model: role.model,
  })

  return agent.run()
}
```

### Gate 检查

```typescript
function checkGates(gates: Gate[], strategy: 'all' | 'majority' | 'any') {
  const results = gates.map(gate => {
    if (!exists(gate.evidence.path)) {
      return { passed: false, reason: 'artifact missing' }
    }
    if (gate.evidence.check) {
      const content = readJSON(gate.evidence.path)
      return evaluateCheck(content, gate.evidence.check)
    }
    return { passed: true }
  })

  switch (strategy) {
    case 'all':      return { passed: results.every(r => r.passed) }
    case 'majority': return { passed: results.filter(r => r.passed).length > results.length / 2 }
    case 'any':      return { passed: results.some(r => r.passed) }
  }
}
```

### Context 组装

Agent 收到的 context（engine 只传路径，不传内容）：

```
你的工作目录: {artifactDir}
前序 artifact（按需用 file_read 读取）:
  - research/researcher/findings.md: "研究发现"
  - fact_check/fact_checker/result.json: "事实核查结果"

用户输入: {input}

{如果是重试}
上轮失败原因: {failureContext}

历次尝试记录（DO NOT repeat failed approaches）:
  Attempt 1: FAIL — "test_parser: expected Token::Select, got Token::Ident"
  Attempt 2: FAIL — "test_executor: index out of bounds"
请根据以上历史，采取不同的策略解决问题。
```

轮次记忆通过 `attemptHistory` 注入，engine 自动格式化为简洁的一行一条摘要。
Agent 看到历史后可以避免重复失败路径。同时，engine 对失败原因做 hash，
连续两轮相同 hash → 判定为停滞（stagnant），提前 blocked，不烧剩余重试次数。

---

## 4. Agent Provider

三种 provider 统一实现一个接口：

```typescript
interface AgentProvider {
  createAgent(config: AgentConfig): Agent
}

interface Agent {
  run(): Promise<AgentResult>
}

interface AgentConfig {
  persona: string           // soul.md 内容
  skills: string[]          // 所有 skill markdown 内容
  context: string           // manifest + input + failure context
  artifactDir: string       // artifact 输出目录
  model: string             // 模型标识
}

interface AgentResult {
  artifacts: string[]       // 产出的文件路径列表
  usage?: {
    inputTokens: number
    outputTokens: number
    costUsd?: number
  }
}
```

### Pi Provider（默认）

基于 `pi-agent-core` + `pi-ai`。Agent 内部是 tool-use loop：
LLM 思考 → 调 tool → 拿结果 → 继续思考 → 直到完成。

三个内置 tool：

| Tool | 签名 | 用途 |
|---|---|---|
| `shell_run` | `(cmd: string, timeout?: number) => string` | 执行命令 |
| `file_read` | `(path: string) => string` | 读文件（含前序 artifact） |
| `file_write` | `(path: string, content: string) => void` | 写文件（含 artifact） |

向下兼容单轮模式——如果 LLM 第一轮就能完成（如 judge 打分），loop 自然只跑一轮。

### Claude Code Provider

调 `claude` CLI，JSON 输出模式。Claude Code 自带完整工具链（MCP、文件操作等），
适合 coding 场景。

### Codex Provider

调 `codex` CLI。结构同 Claude Code Provider。

新增 provider 只需实现 `AgentProvider` 接口，在 petri.yaml 注册即可。

---

## 5. CLI 与 Web

### CLI 命令

```bash
# 初始化（交互式 onboard）
petri init                          # 引导式创建项目
petri init --template research      # 从模板创建

# 运行
petri run                           # 运行默认 pipeline.yaml
petri run --pipeline werewolf.yaml  # 指定 pipeline
petri run --input "研究量子计算"     # 直接传入输入
petri run --from requirements.md    # 从文件读输入

# 状态
petri status                        # 当前/最近一次运行状态
petri log                           # 查看运行日志
petri log --run run-003             # 查看指定运行

# Web
petri web                           # 启动 web 界面（默认 :3000）

# 辅助
petri list templates                # 列出可用模板
petri list skills                   # 列出内置 skills
petri validate                      # 校验项目配置
```

### 交互式 Onboard

```
$ petri init

Welcome to Petri

? What do you want to build?
  > Deep research pipeline
    Werewolf game
    Code development
    Structured debate
    Model training
    Start from scratch

? Configure your LLM provider:
  > Anthropic (Claude)
    OpenAI
    Custom endpoint (OpenAI-compatible)

? API key: sk-ant-***

? Default model:
  > claude-sonnet-4-6 (balanced)
    claude-opus-4-6 (strongest)
    claude-haiku-4-5 (fastest)

Created petri.yaml
Created pipeline.yaml (3 stages)
Created roles/ (3 roles with skills)
Ready!

  petri run       Run your pipeline
  petri web       Open web dashboard
  petri validate  Check configuration
```

### Web 界面

`petri web` 启动本地服务，两个 tab：

**Dashboard**（只读）：
- Pipeline 可视化——stage 进度、状态（pending/running/passed/failed/blocked）
- 实时日志流（SSE）
- Artifact 浏览——点击 stage 查看产出内容
- Token 用量统计

**Management**（操作）：
- 启动新 run（选 pipeline、填 input）
- 手动通过/拒绝 BLOCKED 的 stage
- 查看和对比历史 run
- 配置编辑的简易表单

技术栈：engine 进程内起 HTTP server，前端 HTML + SSE，不需要 React。

---

## 6. 内置模板与 Skills

### 内置 Skills

通过 `petri:` 前缀引用：

```
petri:web_search          # 搜索网页，提取信息
petri:http_request        # 调用 HTTP API
petri:file_operations     # 文件读写、目录操作
petri:data_analysis       # CSV/JSON 解析、统计
petri:git_operations      # Git diff、commit、log
petri:shell_tools         # 常用命令行工具
```

用户也可以在项目 `skills/` 目录放共享 skill，或在 role 的 `skills/` 目录放角色专属 skill。

### 内置模板

| 模板 | 角色 | 流程 |
|---|---|---|
| **research** | researcher, fact_checker, devil_advocate, synthesizer | research → fact_check → critique → synthesize |
| **werewolf** | werewolf, villager, seer, witch, moderator | repeat: night → day → vote → elimination |
| **code-dev** | designer, developer, code_reviewer | design → develop → review |
| **debate** | proposer, opponent, judge | propose → oppose → judge |
| **model-training** | data_engineer, trainer, evaluator | data_prep → repeat: train → evaluate |

模板生成完整的 roles/（含 soul.md、skills/、gate.yaml）和 pipeline.yaml，开箱即用。

---

## 7. 多实例（Future）

同一角色 spawn 多个实例（并行分片、多视角对抗、投票）。具体设计待明确场景后再定。
pipeline.yaml 预留 `instances` 字段但 MVP 不解析。

---

## 8. MVP 范围

### 包含

| 模块 | 范围 |
|---|---|
| Engine | 线性 pipeline + repeat 块 + gate 检查 + 重试 |
| Role 加载 | role.yaml / soul.md / gate.yaml / skills/ |
| Artifact | 文件系统 + manifest.json |
| Gate | artifact 存在性 + JSON 字段检查 |
| Agent Provider | Pi provider |
| 内置 Skills | file_operations、shell_tools |
| CLI | `petri init`、`petri run`、`petri status`、`petri validate` |
| 模板 | code-dev（1 个先跑通） |

### 不包含（后续迭代）

| 模块 | 推迟原因 |
|---|---|
| Claude Code / Codex provider | 先跑通 pi |
| Web 界面 | CLI 先行 |
| 多实例 / 投票 / 分片 | 设计待定 |
| Hooks | 预留字段，不解析 |
| 运行历史对比 | 先跑通单次 |
| 其他模板 | 先跑通 code-dev |

### 技术栈

- **语言**：TypeScript
- **Agent 底层**：pi-agent-core + pi-ai
- **CLI**：commander
- **配置解析**：yaml
- **打包**：tsup
- **发布**：npm（`npx petri init`）

### 首个验证场景

code-dev 模板：designer → developer → code_reviewer，3 个 stage，
覆盖核心机制（多 stage、gate、重试），可直接与 ShadowCoder 对比效果。
