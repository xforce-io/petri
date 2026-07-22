# Petri 配置要点

## 项目文件

| 文件 | 作用 |
|------|------|
| `petri.yaml` | providers、models、defaults |
| `pipeline.yaml` | stages / repeat 循环 / command stage |
| `roles/<name>/role.yaml` | persona、playbooks、model、可选 provider |
| `roles/<name>/soul.md` | 角色人格长文 |
| `roles/<name>/gate.yaml` | 该角色「完成」定义 |
| `roles/<name>/playbooks/*.md` | 本地 playbook；或 `petri:<builtin>` |

## petri.yaml 骨架

```yaml
providers:
  default:
    type: grok          # grok | codex | claude_code | milkie | pi
  review:
    type: codex
    reasoning_effort: high

models:
  default:
    provider: default
    model: default
  terra:
    provider: review
    model: gpt-5.6-terra

defaults:
  model: default
  gate_strategy: all    # all | majority | any
  max_retries: 3
```

- `role.yaml` 可设 `provider: review` 选用命名 provider
- 未配置 provider 时历史优先级：`grok > codex > claude_code > milkie > pi`
- 错误的 model/provider 引用在 `validate` 或 run 前失败，不静默回退

## pipeline stage

```yaml
stages:
  - name: design
    roles: [designer]
    max_retries: 2
    timeout: 300000
    overrides:
      designer:
        model: default

  - repeat:
      name: train-eval-loop
      max_iterations: 10
      until: some-gate-id
      stages:
        - name: train
          roles: [trainer]
        - name: evaluate
          roles: [evaluator]

  - name: unit_test
    command: >
      npm test && printf '%s\n' '{"tests_passed":true}' > "{artifact_dir}/result.json"
    timeout: 600000
    gate:
      id: unit-tests-pass
      evidence:
        path: "{stage}/result.json"
        check:
          field: tests_passed
          equals: true
```

### Command stage 多行

`command:` 支持 YAML `>` / `|`。引擎会归一化折行；含 `if/then/fi` 时保留真多行脚本。约定见仓库 `docs/safe-yaml-command.md`。占位符含 `{artifact_dir}`、`{stage}` 等。

## Gate

```yaml
id: tests-pass
description: ...
evidence:
  path: "{stage}/{role}/results.json"
  check:
    field: all_passed
    equals: true
```

- Gate = 角色/command 的「完成」定义；不过则 stage 重试
- `contract.type: review` 用于 review 类结构化契约（以模板为准）

## role.yaml

```yaml
persona: soul.md
provider: review          # 可选
model: terra
playbooks:
  - petri:file_operations
  - petri:shell_tools
  - implement             # → playbooks/implement.md
```

## 引擎行为（配置相关）

- **并行 roles**：同一 stage 多角色并发
- **失败上下文注入**：重试时带上历史 attempt
- **停滞检测**：连续相同失败原因 hash → 提前终止
- **超时**：per-stage / 默认约 10min，防挂死
- **文件访问**：agent 侧可对宿主路径读写（非仅项目沙箱），跨仓工作流可用但需谨慎

## 改配置检查清单

1. 编辑 yaml
2. `petri validate`
3. 小范围 `petri run --skip-to …` 或全量 run
4. `petri status` / `log` 确认 gate 与 provider 符合预期
