# Petri CLI 参考

权威以 `petri <cmd> --help` 为准；本页供 agent 快速选型。

## 全局

```bash
petri --version
petri --help
petri help <command>
```

## `petri init`

脚手架新项目（写入 `petri.yaml`、`pipeline.yaml`、`roles/` 等）。

```bash
petri init
petri init --template code-dev   # 默认即为 code-dev
```

- 当前内置模板：`code-dev`（`petri list templates`）
- 已有项目勿重复 init 覆盖；改配置用手改或 Web Config

## `petri run`

执行 `pipeline.yaml`（可用 `-p` 换文件）。

| 标志 | 含义 |
|------|------|
| `-p, --pipeline <file>` | pipeline 文件，默认 `pipeline.yaml` |
| `-i, --input <text>` | 管道输入文本；也可是 GitHub/GitLab Issue URL |
| `--from <file>` | 从文件读 input |
| `--skip-to <stage>` | 跳过更早 stage，复用 artifacts（如 `unit_test`、`develop`） |
| `--resume-run <run-id>` | 续跑来源（如 `001`）；**必须与 `--skip-to` 同用**；未给 input 时继承该 run 的 input |
| `--require-clean` | 要求 git 工作区干净 |
| `--worktree [name]` | **默认**隔离：在 `.worktrees/` 下建临时 git worktree；可传目录名 |
| `--in-place` | 在**当前工作树（主干）**跑，不创建 worktree；与 `--worktree` 互斥 |
| `--branch <id>` | 在命名探索分支下跑 |

**工作区默认（issue #71）**：无标志时等价于 worktree 模式。要动当前 checkout 必须显式 `--in-place`。非 git 仓库创建 worktree 会失败并提示改用 `--in-place`。

### 常用配方

```bash
# 文本目标
petri run --input "Add rate limiting to the API"

# Issue（须与 origin 同源）
petri run --input https://github.com/org/repo/issues/42
petri run --input https://gitlab.example.com/group/proj/-/issues/7

# 从 goal 文件
petri run --from .petri/goal.md

# 仅质量门（推荐带 resume）
petri run --skip-to unit_test --resume-run 002

# 从 develop 续（修 review findings 后）
petri run --skip-to develop --resume-run 002

# 探索分支
petri run --branch factor-weight-search

# 明确在当前工作树改代码（非默认）
petri run --in-place --input "hotfix on trunk"

# 命名 worktree 目录（仍为隔离，默认行为的具名版）
petri run --worktree exp-rate-limit --input "..."
```

## `petri status` / `petri log`

```bash
petri status
petri status --branch <id>

petri log
petri log --run 001
petri log --branch <id>
petri log --branch <id> --run 001
```

## `petri validate`

检查项目配置（roles、playbooks、provider/model 引用等）是否合法。改完 yaml 先 validate 再 run。

## `petri list`

```bash
petri list templates    # 脚手架模板
petri list playbooks    # 内置 playbook（role.yaml 里用 petri: 前缀）
```

内置 playbook 当前包括：

- `petri:file_operations` — 工作区读写约定
- `petri:shell_tools` — shell 执行约定

## `petri web`

```bash
petri web
petri web --port 3000
```

产品入口：Home（模板建项）、Runs、Config、Create（实验性 NL）。可在父目录启动以发现多个 Petri 子项目。

## `petri create`

从自然语言生成 pipeline（实验性）。生产路径优先 `init --template`。

```bash
petri create "multi-agent debate with a judge"
```

## `petri branch`

探索分支：独立 run 序号与 artifacts 树。

```bash
petri branch list

petri branch init <id> \
  --baseline ... \
  --seed-project ... \
  --objective "..."

petri branch fork <new-id> \
  --from-branch <id> \
  --from-run 003 \
  --artifact candidate.json \
  --objective "..."
```

存储：

```text
.petri/branches/<id>/runs/run-NNN/
.petri/branches/<id>/artifacts/
```

详见仓库 `docs/branches.md`。

## 退出与失败信号（解读用）

- Stage gate 失败 → 同 stage 重试，context 注入历史失败
- 连续相同失败 hash → stagnation，提前 block
- Command stage：`Command exec failed` / `Command gate failed` / `Command config failed`
- 缺 input 且无法继承 → `No input provided`

## 环境变量

| 变量 | 用途 |
|------|------|
| `PETRI_GROK_BIN` | 覆盖 grok CLI 路径 |
| `PETRI_CODEX_BIN` | 覆盖 codex CLI 路径 |
| `GITLAB_API_TOKEN` | GitLab Issue 读取（GitLab only） |
