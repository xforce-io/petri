# Petri 进化模型 — 设计 Spec

> 日期:2026-05-20
> 状态:草案,待审阅

把 petri 的核心模型重新定义为五个清晰、正交的 primitive,并界定为实现它们所需的框架级改动。

---

## 1. 问题

petri 自我定位是 "evolutionary agent harness",但当前的 primitive 把几个本质不同的概念压成了同一种形态 —— "agent stage + gate":

- **被进化的 worker**、**确定性测量**、**反馈机制**、**accept/reject 决策** 四件事,今天都只能表达成"一个 agent role 带一个 gate"。
- "Failure injection"(让第 N+1 轮比第 N 轮更聪明的反馈)是 gate 失败的*副产物*,不是一等概念。你无法在不让 gate 失败的情况下给反馈;也无法让 gate 失败而不把它变成反馈。
- 确定性工作(回测)没有归宿 —— 只能用一个 LLM agent 去包(见 `examples/ml-training` 的 `tester`),给一个既不需要非确定性、也不需要 token 成本的步骤平白注入两者。
- lines→branches 改名时,branch 模型丢了东西:旧的 `lines/line-001/line.yaml` 携带 `baseline`、`search_space`、`acceptance{primary_metric, minimum_improvement_pp, guardrail_metrics}`;今天的 `branch.yaml` 只剩 `objective` / `baseline` / `notes`。

本 spec 把 petri 的进化模型定义为五个干净、正交的 primitive,并给出实现它们的架构改动。

---

## 2. 概念模型

petri 进化的是 **artifact**。五个 primitive:

| Primitive | 是什么 | 确定性 |
|---|---|---|
| **artifact** | 一次迭代的产物 —— 被进化的东西。携带血缘。 | 数据 |
| **role** | 进化*过程*的定义 —— 给定 artifact + 反馈,产出下一个 artifact。是算子,可跨 artifact 复用。实现为 LLM agent。 | 非确定性 |
| **gate** | 一个确定性检查,把一个观测量变成二值的 ACCEPT/REJECT 贡献。 | 确定性 |
| **guardrail** | 一个机制,把一个观测量(或跨迭代趋势)变成给下一轮的反馈。**绝不**影响 ACCEPT/REJECT。 | 计算确定,作用为建议性 |
| **branch** | 一条进化*方向*。由人开启。携带 objective、baseline,以及该方向专属的 gates 与 guardrails。 | — |

支撑概念:一个 **run** 是某 branch 下的一代;**lineage**(branch / fork / baseline / run 父子关系)是谱系。

还有一个不是 primitive、而是一类 stage 角色的元素:**measurement(测量)** —— 一个确定性步骤,产出 gate 与 guardrail 消费的指标(如回测)。它是 *fitness function*;它的确定性是**必需的**,不是偶然的。

---

## 3. 关键决策

### D1 — gate 与 guardrail 彻底正交

- gate 产出 ACCEPT/REJECT。guardrail 产出反馈。两者谁也不消费谁的输出。它们可以读同一份测量。
- **REJECT 只从 gate 来,反馈只从 guardrail 来。**
- 任何"必须导致拒绝"的东西都是 gate。硬约束(如 "MDD ≤ 上限")是一个 **gate**,不是 guardrail。同一个指标可以**同时**挂一个 gate(硬限)和一个 guardrail(软引导)—— 两者共存而不重叠。

### D2 — 组合规则:ACCEPT ⟺ 所有 gate 通过

- 一个 run 的结局是每个 gate 的 AND(主目标 gate + 各约束 gate)。petri 现有 `gate_strategy: all` 即此语义。
- "Feasibility dominance"(约束违反压倒强劲的主目标)不是一条特殊规则 —— 它是 AND 的自然结果。回撤爆表的候选挂在回撤 gate 上,主目标 gate 救不回来。
- guardrail 并行运行、喂下一轮迭代;对结局**零话语权**。

### D3 — 确定性测量是一等 stage 类型

- petri 新增一种非 agent 的 stage。带 `command:`(而非 `roles:`)的 stage 确定性地执行一条 shell 命令。
- 它**没有**"重试 = 反馈"语义 —— 重跑一个确定性命令得到相同结果。
- 它把指标作为 evidence 产出,供下游 gate / guardrail 消费。

### D4 — branch.yaml 携带方向专属判据;guardrail 不嵌在 acceptance 下

- lines 模型丢掉的判据回到 `branch.yaml`:baseline、gates、guardrails。
- `gates:` 与 `guardrails:` 是**平级**的两个列表。guardrail **不**嵌在 `acceptance` 块里 —— 嵌进去就是 penalty-function 反模式(把约束折进目标),约束处理文献一致认为它劣于"把约束与目标分开"。

### D5 — 以 artifact 为中心的血缘

- 被进化的单元是 artifact,不是 role。一个 run 产出一个候选 artifact;artifact 记录它从什么派生而来(baseline、父 run / branch)。

---

## 4. 架构

### Stage 类型

- **agent stage** —— `roles: [...]`。非确定性。受 `max_retries` + 反馈注入约束。进化一个 artifact。
- **command stage** —— `command: <shell>`。确定性。无反馈重试。产出 evidence(指标)。**【新增】**
- **repeat block** —— 不变;把内部 stage 循环 `until:` 某个 gate,上限 `max_iterations`。

### 一个优化 run 的形态(一代)

```
[agent stage: strategist]      从反馈进化出候选 artifact        (可选 —— 见下注)
        │  candidate_strategy.json
        ▼
[command stage: backtest]      确定性测量 → metrics.json
        │  metrics.json
        ├───────────────┬────────────────┐
        ▼               ▼                ▼
   [gate: objective] [gate: MDD]   [guardrail: …]
        │               │                │
        └───── AND ──────┘           feedback.md
        ▼                                │
   ACCEPT / REJECT  ◄──────────────────  (反馈带入下一轮迭代)
```

**关于 agent stage 的注**:候选生成是"人提供的 run 输入"还是"一个进化的 agent",是 **branch 配置的选择**,不是框架约束。框架两者都支持;量化工作区(todo #5)再各自挑一种。这把早先的 Q1 留在**消费层**而非框架层 —— 这是对的。

### 变更 / 新增的组件

- **Engine**:识别 `command` stage 并确定性执行;把 guardrail 反馈与 gate 裁决**分开**路由 —— 反馈进入下一轮 agent stage 的输入。
- **Pipeline schema**:新增 `command` stage 条目。
- **branch.yaml schema v2**:新增 `baseline`、`gates`、`guardrails`。
- **gate**:**引擎零改动**。比较运算符 `gt/gte/lt/lte/in/equals` 已存在。baseline 相对比较由**测量步骤直接输出 delta 字段**(如 `delta_vs_baseline.real_etf_full_annual_return_pp`)解决,gate 用现成的 `gte` 即可。优化 branch 的 gate 在 `branch.yaml` 声明、检查测量产物;现有的 role 级 gate(`roles/<r>/gate.yaml`)不变。
- **guardrail**:新增配置 —— 要观察的指标 / 趋势,以及它发出的反馈。

### 示意 schema(说明性,非规范;细节留给实现计划)

```yaml
# branch.yaml (schema_version: 2)
schema_version: 2
branch_id: factor-weight-search
objective: ...
baseline:
  strategy_id: run_007_production
  strategy_path: config/strategies/rotation/run_007_production.json
gates:
  # 测量步骤直接输出 delta 字段;gate 用现成的比较运算符
  - id: primary-objective
    field: delta_vs_baseline.real_etf_full_annual_return_pp
    check: { gte: 1.0 }
  - id: drawdown-ceiling
    field: candidate.real_etf_full.max_drawdown
    check: { gte: -0.1252 }       # MDD 为负;不得比上限更差
  - id: subset-floor
    field: candidate.real_etf_subset.annual_return
    check: { gte: 0.0974 }
guardrails:
  - id: drawdown-headroom
    metric: real_etf_full.max_drawdown
    feedback_when: approaching_threshold
    references_gate: drawdown-ceiling
```

---

## 5. 数据流

一个 run = 一代:

1. 输入 artifact(候选)进入 —— 来自 run 输入,或来自一个 agent stage。
2. `command` 测量 stage 运行确定性评估 → `metrics.json`(baseline + 候选指标)。
3. 每个 gate 读 `metrics.json`,套用其比较 → pass / fail。
4. 每个 guardrail 读 `metrics.json`(及历史 run,用于趋势)→ 反馈文本。
5. Engine 组合:ACCEPT ⟺ 所有 gate 通过。记录 run、其 decision、其血缘。
6. 下一轮迭代(`repeat` 块内,或下一次手动 run)时,guardrail 反馈注入 agent stage 的输入。

---

## 6. 结局与错误处理

petri 的执行状态保持 `done | blocked` 两值 —— **不新增 `REJECT` 枚举**。"候选好不好"是另一根轴上的 **verdict**,它是产物内容,不是执行状态:

- **verdict(ACCEPT / REJECT)** —— 由测量 / 评估步骤写进 `result.json` 的 `decision` 字段。`petri status` / `log` 读产物把它显示出来。一个 REJECT 的 run 是**有效的、被记录的实验**,其 `metrics.json` 是要保留的产物。
- **执行状态 `done`** —— pipeline 跑到底,可能 verdict=ACCEPT 也可能 =REJECT。
- **执行状态 `blocked`** —— pipeline 没跑到底:`command` stage 非零退出、或产出残缺 / 非法指标 —— 基础设施失败,无 verdict 可言。

"真实验 vs 基础设施崩溃"的区分不需要状态枚举:崩溃的 run 没有 `metrics.json`,跑完的 run 有。

---

## 7. 测试

- **Pipeline 解析**:含 `command` stage 的 pipeline 能加载;`command` stage 没有 `roles`。
- **Engine**:`command` stage 只跑一次、不带反馈重试;非零退出 → run BLOCKED。
- **组合**:所有 gate AND;任一 gate 失败 → verdict=REJECT;全部通过 → verdict=ACCEPT。
- **guardrail 正交性不变式(关键回归测试)**:guardrail 产出反馈文本;guardrail 违反**不改变** run 的 verdict。
- **branch.yaml v2 解析**。

---

## 8. 范围

**In(本 spec 涵盖):** 五 primitive 模型;gate / guardrail 解耦与正交性不变式;组合规则(所有 gate AND);`command` 确定性 stage 类型;`command` stage 输出可被 gate 检查;`branch.yaml` v2 携带 baseline + gates + guardrails。

**Out(各自单独的后续 spec):**

- `petri promote` —— 把被 ACCEPT 的 artifact 推回源项目(todo #4)。
- 清理量化工作区里 `lines/` 与 `exp-001..005` 的死约定。
- quantitative_trading 工作区的落地实现(todo #5)—— 一份**消费**本框架的薄 spec。

---

## 9. 迁移说明

- `branch.yaml` schema v1 → v2:现有 branch(`legacy-clean-baseline`、`factor-weight-search`)补上 `gates` / `guardrails`。无 gates 的 v1 branch 仍合法,但只能是探索性的 —— 没有 gate 就无法产生 ACCEPT/REJECT。
- `lines/line-001/line.yaml` 里的判据是 `factor-weight-search` v2 字段的参考内容(`primary_metric: real_etf_full.annual_return`、`minimum_improvement_pp: 1.0`、guardrail 指标)。
