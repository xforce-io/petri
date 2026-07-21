# code-dev 的适用范围

code-dev 适合边界清晰、Stories 可验收、能在项目工作区用确定性命令验证的交付任务。它会在 source workspace 修改源码，并把证据写入 `.petri/artifacts`；默认 `unit_test` 从 workspace 根运行 Node 或 Python 测试。

不适合直接满轮全自动交付的场景包括：跨多个独立部署单元、需要生产权限或人工安全判断、数据迁移不可逆、以及无法给出可执行验收条目的大范围存量改造。此类任务应缩小切片，使用更少迭代，借助 `--skip-to` 恢复确定性验证，或在 design/review 后加入人工 gate。

每个 design 必须声明交付边界、非目标和带稳定 ID 的验收清单。review 会回归上一轮 findings；新发现的高风险问题仍可阻断，但不能替代既有 finding 的处理记录。
