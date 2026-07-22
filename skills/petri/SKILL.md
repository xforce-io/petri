---
name: petri
description: >
  操作 Petri 进化型 agent harness：用 CLI 初始化项目、跑 pipeline、看 status/log、
  从 issue 启动 code-dev、断点续跑、分支探索与 Web 面板。触发词包括 petri、
  petri run、code-dev、init template、skip-to、resume-run、unit_test gate、
  进化循环 / 质量门 / 多角色流水线。用户说「用 petri 跑」「初始化 code-dev」
  「续跑质量门」「petri 现在什么状态」时加载。Use when the user runs /petri.
---

# Petri operator

把「用 Petri 交付 / 进化跑任务」的意图翻译成正确的 `petri` CLI（或 Web），
并按协议解读运行结果。这是 CLI 之上的**薄壳**：不重实现引擎，不替用户发明
pipeline 语义。

Petri = **约束 + 进化循环**：角色（persona + playbooks）→ 产出 artifacts →
gate 验收 → 失败注入上下文重试 → 停滞检测后退出。同一引擎可挂 code-dev、
辩论、ML 训练等不同 roles 目录。

## 前置自检

首次操作前：

```bash
petri --version   # 或 which petri
node -v           # 需要 Node >= 20
```

失败时说明：从源码 `npm install && npm run build`，或确认 `petri` 在 PATH。
CLI-backed provider 另需本机已装对应 CLI：

| provider | 依赖 |
|----------|------|
| `grok`（默认优先） | `grok` / `PETRI_GROK_BIN` |
| `codex` | `codex` / `PETRI_CODEX_BIN` |
| `claude_code` | Claude Code CLI |
| `milkie` / `pi` | 对应运行时 |

GitHub Issue 输入需 `gh` 已登录；GitLab Issue 需 `GITLAB_API_TOKEN` 或 `glab`。

## 意图 → 命令（看优先）

| 用户意图 | 跑什么 |
|----------|--------|
| 现在什么状态 / 最近跑完没 | `petri status`（可加 `--branch <id>`） |
| 看日志 / 为什么挂了 | `petri log` 或 `petri log --run <id>` |
| 初始化 code-dev 项目 | `petri init --template code-dev`（默认就是 code-dev） |
| 有哪些模板 / 内置 playbook | `petri list templates` / `petri list playbooks` |
| 校验配置 | `petri validate` |
| 用自然语言描述任务跑一轮 | 在**已 init 的项目根**执行 `petri run --input "..."` |
| 从 GitHub/GitLab Issue 跑 code-dev | `petri run --input <issue-url>`（URL 须属当前 origin） |
| 只跑质量门 / 从某阶段续 | `petri run --skip-to <stage> --resume-run <id>` |
| 开 Web 面板 | `petri web`（推荐产品入口，http://localhost:3000） |
| 探索分支 | `petri branch init/list/fork` + `petri run --branch <id>` |
| NL 生成全新 pipeline | `petri create "..."`（实验性；优先模板 init） |

**默认 cwd = 目标 Petri 项目根**（含 `petri.yaml` + `pipeline.yaml` + `roles/`）。
不在项目根时先 `cd` 或让用户确认路径；多项目可用父目录 `petri web` 发现子项目。

## 最小闭环（code-dev）

```bash
# 1. 脚手架（空目录或新项目）
petri init --template code-dev

# 2. 可选：改 petri.yaml providers / unit_test.command

# 3. 启动一轮
petri run --input "Build a CLI calculator in Python"
# 或
petri run --input https://github.com/<owner>/<repo>/issues/<n>

# 4. 观察
petri status
petri log --run 001
```

内置 **code-dev** 阶段链（详见 `references/code-dev.md`）：

```text
issue → design → repeat(develop → unit_test → review) until review-approved
```

- `issue` / `design` / `develop`：默认 **Grok**
- `code_reviewer`：默认 **Codex** `gpt-5.6-terra` + `reasoning_effort: high`
- `unit_test`：引擎在**源码工作区**跑确定性命令（默认纯 `npm test` 或 `python -m pytest`），**不是** agent 自评

## 铁律

1. **先 status / log，再重跑**：用户只想「看看」时不要立刻 `petri run` 全链路（烧 provider token + 改工作区）。
2. **续跑必须配对**：`--resume-run` 必须与 `--skip-to` 一起用；来源 run 须存在。未传 `--input`/`--from` 时会继承来源 run 的 input。
3. **质量门 ≠ 全链路**：实现已在工作区时优先  
   `petri run --skip-to unit_test --resume-run <id>`，勿无脑从 issue 重跑。
4. **unit_test 要纯测试**：默认不要用「先全仓 lint 再测」的 wrapper 当 harness 门禁；项目特殊 runner 改 `pipeline.yaml` 的 `unit_test.command`。
5. **Issue URL 同源**：`--input` 的 forge URL 必须属于当前 git `origin`；失败会在启动前明确报错，不要改成残缺纯文本硬跑。
6. **改源码在 source workspace**：agent 证据在 `.petri/artifacts`；实现落在真实项目树。skill 解读结果时区分「证据目录」与「源码目录」。
7. **默认 worktree，主干需显式**：`petri run` 默认在 `.worktrees/` 临时 worktree 隔离执行；只有用户明确要改当前工作树时才加 `--in-place`。不要默认加 `--in-place`。`--require-clean` 仍是可选严格检查。
8. **不重写引擎语义**：gate / stagnation / branch 行为以仓库 README 与 `docs/` 为准；细节读 `references/`。

## 输出解读

`petri status` / `log` 优先归纳成人话：

- **当前 stage / attempt / gate id**
- **通过 / 重试 / blocked（含 stagnation）**
- **关键 artifact 路径**（`.petri/runs/run-NNN/` 或 `.petri/branches/<id>/runs/`）
- 续跑时点出 `resumedFrom` 链路

命令失败 → 转述 stderr / 日志中的 `Command exec failed` / `Command gate failed` 等前缀，不臆造通过。

## 渐进阅读

需要细节时再读（按需，勿一次塞满上下文）：

| 主题 | 文件 |
|------|------|
| CLI 全参数与常见标志 | `references/cli.md` |
| code-dev 角色、门禁、验收约定 | `references/code-dev.md` |
| petri.yaml / pipeline / gate / provider | `references/config.md` |

仓库权威文档：`README.md`、`docs/branches.md`、`docs/safe-yaml-command.md`、
`src/templates/code-dev/README.md`。

## Common mistakes

- 在非 Petri 项目根执行 `run` → 先 `init` 或 `cd`。
- 把 Petri **playbook**（`petri:file_operations` 等）当成可安装 agent skill → 那是角色 prompt 片段；本 skill 才是给「操作 Petri 的智能体」用的。
- review 不过就整段重写 develop → 应读 findings，最小修复后 `skip-to develop` 或继续循环。
- 用 lint 包进 unit_test 当默认门禁 → 违反 code-dev 约定。
- GitLab 仓库却用 `gh`、或未设 `GITLAB_API_TOKEN` → 按 origin 选 forge 工具。
- 无参就 `petri create` 生成生产 pipeline → 优先 `init --template code-dev`。
