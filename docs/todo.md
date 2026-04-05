# Petri TODO

MVP 之后的改进项，按优先级排列。

---

## P1 — 核心体验

### 跨角色升级（Escalation）

Stage 内 retry 连续失败时，引入另一个角色介入分析，而不是直接 blocked。

```yaml
- name: develop
  roles: [developer]
  max_retries: 5
  on_stagnant:
    escalate_to: code_reviewer
```

来源：ShadowCoder 的 developer 连续 gate 失败 → 自动升级给 reviewer 分析根因。

### Gate 跨轮次对比

Gate 支持 `compare` 模式，对比当前轮和上一轮的 artifact 值，检测是否改进。

```yaml
evidence:
  path: "{stage}/{role}/metrics.json"
  check:
    field: score
    compare: improving
```

来源：ShadowCoder 的 metric_gate + Pareto 改进检测。

### 预算控制

整个 run 的 token/cost 上限，超限自动 blocked。

```yaml
# petri.yaml
defaults:
  max_budget_usd: 10.0
```

---

## P2 — 增强功能

### Gate 动态增长

允许角色在执行过程中向 gate 追加新条件（如 reviewer 提出新测试用例）。
需要设计 artifact 协议让 gate 条件可以被 agent 扩展。

来源：ShadowCoder 的 reviewer 每轮提出 proposed_tests，自动累积到回归集。

### Version Archives

每次 retry 的 artifact 按 attempt 编号存快照，支持回溯和对比。

```
.petri/artifacts/{stage}/{role}/
  _versions/
    attempt-1/
    attempt-2/
```

### Session Resume

Pi provider 支持 agent session 持续，retry 时延续上一轮对话上下文而不是创建新 agent。

来源：ShadowCoder 的 Claude Code session resume 机制。

### Blocked 分类

区分不同 blocked 原因（stagnant、budget、escalation_failed、max_retries），
方便 web 界面展示和用户针对性处理。

---

## P3 — 扩展场景

### Claude Code / Codex Provider

实现 claude_code 和 codex 两个 agent provider。

### Web 界面

Dashboard（只读监控）+ Management（操作管理）。

### 多实例

同一角色 spawn 多个实例：并行分片、多视角对抗、投票。

### Hooks

Pipeline stage 的生命周期钩子（before_stage、after_artifact、on_gate_fail）。

### 其他模板

research、werewolf、debate、model-training 模板实现。

### Git Worktree 隔离

Code-dev 场景下为每个 run 创建独立的 git worktree。可做成内置 skill 或 hook。
