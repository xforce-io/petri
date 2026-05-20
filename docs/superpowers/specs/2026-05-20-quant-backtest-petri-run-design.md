# 量化回测作为一等 Petri Run — 设计 Spec

> 日期:2026-05-20
> 状态:草案,待审阅
> 上游:`2026-05-20-petri-evolution-model-design.md`(本 spec 是它的消费者 —— quant `todo #5` 落地)

把 quant 轮动策略回测接进一条 petri pipeline,让每次策略实验成为正式的 `.petri/branches/<branch>/runs/run-NNN/`。

---

## 1. 问题

quant `todo #5`:让每次回测实验成为一等 petri run、血缘连贯。当前 `factor-weight-search` branch 下血缘是断的 —— `runs/run-001` 只是 smoke 测试,真实的 iteration-002 是手工 artifact 目录,候选 JSON 内部又自称 `run-002`,三套 ID 互不一致。

petri 框架现已具备 `command` 确定性 stage 与 command stage 输出 gating(进化模型 Plan 1 + Plan 2,已合并)。本 spec 用这些能力把回测 pipeline 化。

## 2. 背景

- **实验工作区** `~/lab/petri/quantitative_trading` —— **不是 git 仓库**(`git init` 已决定暂缓,属已知接受的风险)。petri 配置与本 spec 的实验侧产物都放这里。
- **quant 生产仓库** `/Users/xupeng/lab/quantitative_trading` —— **完全不动**。
- **回测**:quant 仓库的 `scripts/long_rotation_discovery.py`,`--mode candidate --params-file <json> --output <json>`。output JSON 把三个 universe 放在 `results.{index_proxy,real_etf_subset,real_etf_full}` 下,每个含 `candidate_oos_*` 与 `baseline_oos_*`。
- **验收准则**(来自旧 `lines/line-001/line.yaml`):主指标 = `real_etf_full` 年化改善 ≥ 1.0pp;guardrail = `real_etf_full` MDD ≥ −0.1252、`real_etf_subset` 年化 ≥ 0.0974。
- **branch**:`factor-weight-search` 已存在(`branch.yaml` schema v1)。

## 3. 组件

### 3.1 petri 增强 —— command stage 产物快照

`runCommandStage` 把命令的输出产物快照进 `runs/run-NNN/artifacts/`,仿 agent stage 的 `snapshotRoleArtifacts`。

**理由**:目前 command stage 的输出写在共享的 `branchDir/artifacts/<stage>/`,引擎每次 run 开头的 `clearStaleArtifacts` 会清空它 —— 下一个 run 覆盖上一个的产物。不快照,就没有"每个 run 产物可追溯"。

归属:**petri 仓库**(git,正常 TDD)。

### 3.2 delta 评估脚本

一个小脚本(实验工作区),读回测 `--output` JSON → 写 gate-ready `result.json`:

- `delta.real_etf_full_annual_return_pp` = (candidate − baseline) × 100,取 `real_etf_full` 年化。
- `candidate.real_etf_full.max_drawdown`、`candidate.real_etf_subset.annual_return` —— 透传,供两个 guardrail check。
- `decision`:ACCEPT / REJECT,脚本自行算出(供人读;gate 才是裁决权威)。

只通过回测 output JSON 的字段名与回测松耦合。

### 3.3 petri pipeline

实验工作区 `pipeline.yaml`,`factor-weight-search` branch 下一个 `command` stage `backtest`:

```yaml
- name: backtest
  command: >
    cd /Users/xupeng/lab/quantitative_trading &&
    .venv/bin/python scripts/long_rotation_discovery.py
      --mode candidate --params-file <candidate.json>
      --output {artifact_dir}/raw.json &&
    <python> <evaluator> --input {artifact_dir}/raw.json
      --output {artifact_dir}/result.json
  gate:
    id: candidate-accepted
    evidence:
      path: "{stage}/result.json"
      check:
        - { field: delta.real_etf_full_annual_return_pp, gte: 1.0 }
        - { field: candidate.real_etf_full.max_drawdown, gte: -0.1252 }
        - { field: candidate.real_etf_subset.annual_return, gte: 0.0974 }
```

gate 三个 check AND:全过 → run `done`(verdict ACCEPT);任一不过 → `blocked`(verdict REJECT)。

回测以 quant 仓库为 cwd 运行(脚本用相对路径读 `data/` `config/`)。`<candidate.json>`、`<evaluator>`、`<python>` 的具体路径由实现计划定。

### 3.4 候选策略

第一个真实 run 的输入 —— 反向方向候选:从 run_007 基线(momentum 0.40 / low_volatility 0.32 / relative_strength 0.18)往 momentum 挪,定为 **momentum 0.46 / low_volatility 0.26 / relative_strength 0.18**(镜像 iteration-002 的 −0.06 / +0.06)。一个候选 JSON 放实验工作区。

### 3.5 清理

删实验工作区里失效的 `exp-001..005` 与 `lines/` 死约定。

## 4. 数据流

一个 run:

1. `petri run --branch factor-weight-search` → `runs/run-NNN/`。
2. `backtest` command stage:回测(cwd = quant 仓库)→ `raw.json`;评估脚本 → `result.json`。
3. petri 把 `raw.json` + `result.json` 快照进 `runs/run-NNN/artifacts/`(组件 3.1)。
4. command stage 的 gate 检查 `result.json` → ACCEPT(run `done`)/ REJECT(run `blocked`)。
5. 该 run 的 verdict 与指标永久留在 `runs/run-NNN/`。

## 5. 错误处理

- 回测崩溃 → 命令非零退出 → run `blocked`(基础设施失败,无 `result.json`)。
- 评估脚本崩溃 → 非零退出 → run `blocked`。
- gate 不过(候选不够好)→ run `blocked`,verdict REJECT —— 一个**有效的、被记录的实验**(`result.json` 在)。

## 6. 测试

- **petri 增强**:一个 command stage 的输出产物出现在 `runs/run-NNN/artifacts/`(petri 仓库的 vitest)。
- **评估脚本**:单测 —— 给一份 fixture 回测 output JSON,产出正确的 `delta` 与 `decision`。
- **pipeline**:由第一个真实 run 端到端验证。

## 7. 范围

**In**:petri 增强(command stage 产物快照)、评估脚本、pipeline + gate、第一个真实 run、清理旧物。

**Out**:实验工作区 `git init`(暂缓);`branch.yaml` v2(内联 pipeline gate 已够,不需要 branch 携带判据);guardrail 子系统;`petri promote`。

## 8. 拆分 —— 两个计划

1. **petri command-stage 产物快照**(petri 仓库)—— 正常 TDD,git 提交。
2. **量化回测 petri-run 落地**(实验工作区)—— 评估脚本 + pipeline + 候选 + 首个 run + 清理。依赖计划 1。

**注**:实验工作区不是 git 仓库,计划 2 无法走"每任务一提交"的 TDD 流程 —— 评估脚本用"写好 + 跑 fixture 验证"、pipeline / 候选是配置、首个 run 即端到端验证。计划 1 在 petri 仓库,正常 TDD。
