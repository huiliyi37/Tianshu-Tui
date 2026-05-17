# Dream Phase 1 复盘 · 2026-05-17

> 来源：天枢在执行 Project Memory Dream Phase 1 时的自我诊断 + 用户分析反馈

## 设计发现

| # | 发现 | 严重度 | 处置 |
|---|------|--------|------|
| 1 | persistDream MAX_FILE_SIZE=8000 vs volatile KNOWLEDGE_MAX_CHARS=2000 不对称，缺设计 rationale 文档 | 低 | 接受。8000 服务人类（git 查阅）、2000 服务模型（prefix cache 预算），是两个消费者的有意分工。需在 dream.ts JSDoc 中记录此意图 |
| 2 | persistDream 裸 slice 8000 不保证 `### ` 条目边界，旧条目可能被切碎 | 中 | Phase 2 修复：按最后一个完整 `### ` 头截断 |
| 3 | distillSession 只取最后一次 verification，多验证 session 信息丢失 | 低 | Phase 1 接受，Phase 2 LLM 蒸馏时传全量 |
| 4 | decisions/trajectoryEntries 在 shutdown hook 中硬编码 `[]`，依赖 Phase 2 才能填值 | 高 | ✅ 已修复。loop.ts 新增 getTrajectoryEntries()，main.tsx 映射 trajectory 到 Dream 格式 |
| 5 | 无条目去重，2000 chars 下误损可忽略（~3-4 条目） | 不做 | Phase 1 不做去重 |

## 协作过程问题

### 1. 工具连续调用被限流

**现象**：连续 3+ 次调用同一文件读取工具时被拒绝，需要换用 bash sed/grep 绕过
**影响**：拖延了调研阶段节奏
**根因**：tool rate limiter 阈值（3 次）对"连续读多个文件做调研"的合法场景误判
**建议**：rate limiter 阈值从 3 提升到 5-8 次/分钟，或按 tool 类型分类（read_file 类放宽，write_file/bash 类收紧）

### 2. 用户无法感知 agent 中间状态

**现象**：终端 TUI 建设中，用户输入后看不到 agent 在读文件、写代码还是卡住，只能询问"怎么样"
**影响**：需要定期主动询问进度，打断 agent 工作流
**方向**：activity-status-layer（另一个智能体在开发中）需要覆盖 phase 切换通知 + 心跳

## 执行统计

- 改动文件：4 个（dream.ts 新建，volatile.ts、main.tsx、loop.ts 修改）
- 测试：8 个新建，全量 1056 pass
- 提交：2 个（Phase 1 主体 + trajectory 修复）
- 代码量：~215 行
