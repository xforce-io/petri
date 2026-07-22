# code-dev 内置流程

模板路径：`src/templates/code-dev/`（`petri init --template code-dev` 拷贝到项目）。

## 适用 / 不适用

**适合**：边界清晰、Stories 可验收、能在项目工作区用确定性命令验证的交付。

**不适合直接满轮全自动**：跨多部署单元、需生产权限/人工安全判断、不可逆数据迁移、无法写出可执行验收的大范围改造。应切片、降迭代，或 design/review 后人工 gate，并用 `--skip-to` 恢复确定性验证。

## 阶段拓扑

```text
issue (issue_analyst)
  → design (designer)
  → repeat develop-review-cycle (max_iterations: 5, until: review-approved)
        develop (developer)
        → unit_test (command stage, deterministic)
        → review (code_reviewer)
```

来自 `pipeline.yaml`：

| Stage | 类型 | 角色 / 命令 | 典型 max_retries |
|-------|------|-------------|------------------|
| `issue` | agent | `issue_analyst` | 2 |
| `design` | agent | `designer` | 2 |
| `develop` | agent | `developer` | 5 |
| `unit_test` | **command** | 纯测试 runner | timeout 600s |
| `review` | agent | `code_reviewer` | 2 |

循环直到 gate **`review-approved`**，或耗尽 `max_iterations`（引擎可写 `exhaustion.json` 与续跑指引）。

## Provider 默认（模板 `petri.yaml`）

| 角色 | Provider | Model / 备注 |
|------|----------|----------------|
| issue / design / develop | `grok`（`providers.default`） | `defaults.model` |
| `code_reviewer` | `codex`（`providers.review`） | `gpt-5.6-terra`，`reasoning_effort: high` |

旧项目 init 后不会自动升级 provider，需手改 `petri.yaml` / `role.yaml`。

## 角色与产物（闭环）

### 1. issue_analyst — `capture`

- 输入：`--input` 文本或 Issue Source（含 body + 评论）
- 写出：`issue.md`（Title / Background / Goals / Acceptance / Out of scope / …）
- Gate 证据：`{stage}/{role}/issue.json` → `accepted: true|false`

### 2. designer — `design`

- 读 issue 产物
- 写出：`design.md`（架构、组件、数据结构、**Test plan**、**Acceptance checklist** 稳定 ID）
- Gate：`design.json` → `completed: true`
- 每个 design 必须声明交付边界、非目标、带稳定 ID 的验收清单

### 3. developer — `implement`（TDD）

- 在 **Source workspace** 改真实源码（不是只在 artifact 目录造假项目）
- 先测后码；自报 `{stage}/{role}/result.json` 的 `tests_passed`
- Playbooks 常含 `petri:file_operations`、`petri:shell_tools`、`implement`

### 4. unit_test — 确定性门禁

- 引擎在**源码根**执行 `command`，证据写入 artifact dir 的 `result.json`
- 默认逻辑（摘要）：
  - 有 `package.json` 且存在 `scripts.test` → `npm test`
  - 否则像 pytest 项目 → `python -m pytest`
  - 否则失败并提示配置 `unit_test.command`
- **不要**默认用 lint-bundled wrapper（如先全仓 ruff 再 pytest 的 `tests/run_tests.sh unit`）
- Gate id：`unit-tests-pass`，`tests_passed == true`

### 5. code_reviewer — `review`

- 对照 issue + design + 源码 + unit_test 证据
- 写出 `review.json`：`approved`、`findings[]`、`previous_findings`、`acceptance[]`、`followups`
- **否决批准**：CRITICAL，或显式 `blocks_approval: true`
- 未标记的 HIGH **默认不**为扩 scope 而阻断；最后一轮可用 `approved_with_followups`（≤1 阻断 HIGH）
- 须回归上一轮 findings（`fixed` / `still_open` / `deferred`）

## Agent 操作手册（常见任务）

### A. 绿场：从 0 跑通

```bash
mkdir my-app && cd my-app
petri init --template code-dev
# 按需改 unit_test.command / providers
petri validate
petri run --input "……可验收的目标……"
petri status
```

### B. 从 Issue 进入

```bash
# 必须在对应 git 仓库内，origin 与 URL 匹配
petri run --input https://github.com/o/r/issues/123
```

### C. Review 挂了，本地改完再进循环

```bash
petri log --run 003          # 看 findings
# 人工或本会话最小修复源码后：
petri run --skip-to develop --resume-run 003
# 或只信当前树、只跑门禁+review：
petri run --skip-to unit_test --resume-run 003
```

### D. 已有实现，只做质量门

```bash
petri run --skip-to unit_test --resume-run 001
# 无 resume 时需自备 input：
petri run --skip-to unit_test --from .petri/goal.md
```

### E. 迭代耗尽

查看 artifacts 中的 `exhaustion.json`（若有）与 log；按提示
`petri run --skip-to develop --resume-run …` 做最小补丁清单，勿无目标全量重跑。

## 目录速查（运行后）

```text
.petri/
  runs/run-NNN/          # 默认线
  artifacts/             # 证据（或 branches 下）
  branches/<id>/...      # 探索分支
  goal.md                # 可选持久目标
petri.yaml
pipeline.yaml
roles/
  issue_analyst|designer|developer|code_reviewer/
    role.yaml
    soul.md
    gate.yaml
    playbooks/*.md
```

## 与「本 skill」的边界

- **本 skill**：教操作 Petri 的外层智能体如何调用 CLI / 解读 run。
- **roles/*/playbooks**：给 Petri **内部**角色 agent 的 prompt 片段（含 `petri:file_operations` 等）。
- 不要把两者混为同一安装包职责。
