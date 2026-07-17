# 【web】Config 以 pipeline 为配置导航单元

- Issue: #12
- 状态: Approved
- 最后更新: 2026-07-17
- 相关: #11（Run 逻辑名）、#9（产品 Web）

## 1. 背景

Config 原为项目文件树；用户心智是 pipeline。与 Run 展示逻辑名一致，配置导航应以流程为单位。

## 2. 名词解释

- **逻辑名**：pipeline YAML 顶层 `name:`
- **文件路径**：如 `pipeline.yaml`，引擎加载用

## 3. 目标与非目标

- **目标**：Config 一级为 Project settings + Pipelines（逻辑名）；选中后按 stage/role 导航并编辑；API 提供元数据避免 N+1。
- **非目标**：拖拽编排；模板作者；多用户；删除「All files」高级入口。

## 4. 设计思路

| 方案 | 结论 |
|------|------|
| 仅前端读多个文件拼树 | 放弃：N+1、与 Run 重复 |
| **GET /api/pipelines** 返回 `{file,name,stages[]}` | **采用**；#11/#12 共用 |
| 完全去掉文件树 | 不做；折叠在 All files |

## 5. API

`GET /api/pipelines` → `ProjectPipelineInfo[]`（`src/web/pipelines.ts`）。

## 6. UI

- Project → petri.yaml  
- Pipelines → 逻辑名列表 → Structure（pipeline 定义 + stage → role 文件）  
- All files → 原文件树  

## 7. 测试

- Unit：`listProjectPipelines` / `pipelineDisplayLabel`  
- API：`GET /api/pipelines`  
- Structural：index.html / app.js 含 pipeline-centric 标记  

## 8. 关联

- #11, #12, `src/web/pipelines.ts`, `src/web/public/*`
