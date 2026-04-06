# Petri Web Dashboard Design Spec

## Overview

`petri web` 启动本地 HTTP server，提供 pipeline 运行的可视化监控、run 管理和配置编辑功能。

技术栈：Node 原生 `http` 模块，前端纯 HTML + CSS + vanilla JS，实时推送用 SSE。零前端依赖，零后端框架依赖。

## Architecture

```
Browser (HTML+JS)  ←→  HTTP Server (Node http)  ←→  Engine / Config Loader
     ↑                      ↑
     SSE stream         EventEmitter
```

三层：

- **前端**：`src/web/public/` 下纯静态文件，SPA 风格单页 tab 切换
- **后端**：`src/web/server.ts` + `src/web/routes/` 处理 API 和静态文件
- **桥接**：RunLogger 继承 EventEmitter，运行时发事件，SSE route 订阅推送

依赖方向：`cli/web.ts` → `web/server.ts` → `web/routes/*` → `engine/*` + `config/loader.ts`

## Directory Structure

```
src/
  cli/
    web.ts                # petri web CLI 命令入口
  web/
    server.ts             # HTTP server 创建与路由分发
    routes/
      api.ts              # REST API endpoints
      sse.ts              # SSE 实时事件流
    public/               # 静态前端文件
      index.html          # SPA 壳
      app.js              # 路由切换 + API 调用 + SSE 订阅
      style.css           # 暗色主题样式
```

## UI: Three Tabs

### Dashboard Tab

Master-detail 布局：

- **左侧 — Vertical Timeline**：pipeline stages 纵向排列，每个 stage 显示名称、角色、状态（passed/running/pending/failed/blocked）、耗时。点击选中 stage。底部显示 run 总览（token、cost、时间）。
- **右侧 — Detail Panel**：选中 stage 的详情，包含三个子 tab：
  - **Log**：实时日志流（SSE 推送），monospace 字体
  - **Artifacts**：该 stage 产出的文件列表，点击查看内容
  - **Gate**：gate 检查结果（passed/failed + reason）

进入时自动加载最近一次 run。如果 run 正在执行，自动连 SSE 更新 timeline 和 log。无 run 时显示空状态。

### Runs Tab

- **顶部 — 启动表单**：pipeline 下拉选择（从项目目录扫描 pipeline*.yaml）+ input textarea + Run 按钮。点击 Run 后 POST 启动，自动跳转 Dashboard 观察进度。
- **下方 — 历史列表**：表格展示所有 run（runId、pipeline、status、开始时间、耗时、cost）。点击某行跳转 Dashboard 查看该 run 详情。

### Config Tab

- **左侧 — 文件树**：列出 petri.yaml、pipeline.yaml、roles/\*/role.yaml、roles/\*/soul.md、roles/\*/gate.yaml、roles/\*/skills/\*.md
- **右侧 — YAML 编辑器**：textarea 编辑 + Save 按钮。保存时后端先 validate 再写盘，失败返回错误信息展示在编辑器下方。

## API Endpoints

```
GET  /                          → index.html
GET  /public/*                  → 静态资源

GET  /api/runs                  → 历史 run 列表
GET  /api/runs/:id              → 单个 run 详情 (RunLog JSON)
GET  /api/runs/:id/log          → run.log 原文
GET  /api/runs/:id/artifacts    → artifact 文件列表 [{path, size}]
GET  /api/runs/:id/artifacts/*  → 单个 artifact 文件内容
POST /api/runs                  → 启动新 run {pipeline, input} → {runId}
GET  /api/events/:id            → SSE 实时事件流

GET  /api/config/files          → 可编辑文件列表 [{path, type}]
GET  /api/config/file?path=...  → 读取文件内容
PUT  /api/config/file?path=...  → 保存文件 (validate → write)
```

## Engine Event Integration

RunLogger 继承 EventEmitter，现有方法不变，每个 log 方法末尾加 emit：

- `logStageAttempt()` → emit `stage-start` `{stage, attempt, max}`
- `logRoleStart()` → emit `role-start` `{stage, role, model}`
- `logRoleEnd()` → emit `role-end` `{stage, role, gatePassed, usage, artifacts}`
- `logGateResult()` → emit `gate-result` `{stage, passed, reason}`
- `finish()` → emit `run-end` `{runId, status, blockedStage, durationMs}`

Web server 维护 `activeRuns: Map<string, RunLogger>`。`POST /api/runs` 创建 logger 后注册，run 结束后移除。SSE route 从 Map 取 logger 订阅事件。

CLI 路径不受影响（无监听者时 emit 是 no-op）。

## Config Validation

`PUT /api/config/file` 的 validation 策略：

1. 先用 `yaml.parse()` 校验 YAML 语法
2. 根据文件路径判断类型：
   - `petri.yaml` → 调用 `loadPetriConfig()` 校验
   - `pipeline*.yaml` → 调用 `loadPipelineConfig()` 校验
   - `roles/*/gate.yaml` → 校验 GateConfig 结构
   - 其他文件（soul.md、skills/*.md）→ 仅校验非空
3. 校验通过才写盘，失败返回 400 + 错误信息

## Error Handling

- API 统一返回 `{error: string}` + HTTP status（400 校验失败、404 not found、500 内部错误）
- `POST /api/runs` 配置加载失败立即返回 400
- SSE 断连后前端 `EventSource` 自动重连，重连时从 run.log 补全历史
- Config 保存失败不写盘，返回完整校验错误

## CLI Command

```bash
petri web                    # 启动，默认端口 3000
petri web --port 8080        # 指定端口
```

端口优先级：`--port` flag > `petri.yaml` 中 `web.port` > 默认 3000

## Build & Dev

- tsup 入口不变，web 代码随 `src/cli/index.ts` 一起编译
- `src/web/public/` 静态资源通过 `postbuild` 脚本复制到 `dist/web/public/`
- 运行时用 `__dirname` 解析 `public/` 路径（同现有 templates 路径解析模式）
- 开发：`tsx src/cli/index.ts web` 直接跑，改 HTML/JS/CSS 刷新浏览器

## Testing

- **routes 单测**：Node 原生 `http.request` 对 server 发请求，mock Engine/provider
- **logger 事件测试**：验证 EventEmitter emit 的事件类型和 payload
- **config validation 测试**：PUT 接口的 400 场景（语法错误、schema 错误）
- **前端不写自动化测试**：纯展示层，手动验证

## Scope Exclusions

以下功能不在本次 scope 内：

- 手动通过/拒绝 blocked stage（需 engine 支持暂停恢复）
- 历史 run 对比
- 前端框架（React 等）
- Monaco / CodeMirror 等重型编辑器
- 用户认证
