# Agent Harness Testing — 持久化知识参考

本文档描述天枢在任意项目中执行开发任务时应遵守的测试方法论。
内容与 `.rivet/skills/agent-harness-testing/SKILL.md` 对应，但此处为简洁参考版，
供 recall 工具检索和 prompt 注入用。

## 核心约束

- 禁止编造测试结果。未运行 = 说"未验证"。
- Bugfix 必须先复现再修复（RED → GREEN）。无法复现时说明原因。
- 临时探针必须清理。残留 = 任务未完成。
- 进入陌生项目先用 inspect_project 探测测试能力，不假设框架。
- 不同任务类型用不同测试深度（算法→单元，API→集成，DB→migration test）。

## 测试能力探测流程

1. `inspect_project` 获取语言/框架
2. 读 `package.json` / `pyproject.toml` / `go.mod` 找 test scripts
3. 试跑一条测试命令确认可用
4. 生成能力地图（可用/不可用）

## 测试策略

| 任务类型 | 最低验证 | 推荐 |
|---------|---------|------|
| Bugfix | RED 红灯 + 修复后 GREEN + typecheck | 回归测试 |
| Feature | 新测试 + typecheck + lint | 集成测试 |
| Refactor | 回归测试 + typecheck | 全量模块测试 |
| Performance | benchmark 对比 | 压力测试 |
| Security | 安全测试（越权/注入） | staging smoke |

## 探针管理

- 临时日志（console.log 含 `[probe:]`）→ 必须删除
- 结构化日志（logger.info）→ 可保留
- 断言（assert）→ 修复后转测试或删除

## 环境模拟

- 有 Docker Compose → 启动真实依赖再测
- 无 Docker → 说明限制，标记为 mock 验证
- 不硬编码密钥到测试代码

## 验证报告最低要求

- 列出改了哪些文件
- 列出每条测试命令和结果（PASS/FAIL/SKIP）
- 列出未验证项及原因
- 诚实：不把推测当验证结果
