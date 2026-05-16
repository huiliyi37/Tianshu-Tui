# 会话高可用（Session HA）头脑风暴背景

> 来源：Rivet vs Qwen Code vs OpenCode 竞品分析，聚焦会话终端性能渲染层

## 1. 触发问题

用户原始意图：「看 Qwen Code 和 OpenCode 关于会话终端性能渲染层哪些做得好、我们不足的，提高会话高可用」

### 问题层级

- 主层级：L2 链路结构 — 流式渲染管线与会话持久化链路存在结构性缺口
- 关联层级：L5 执行 handoff（recovery 时渲染管线缺失）、L7 代码实现

## 2. 竞品分析发现

### Qwen Code 关键架构

**BlockStreamer** (`packages/channels/base/src/BlockStreamer.ts`)
- 渐进式多消息投递：将流式文本按语义断点分块
- 配置：minChars=400, maxChars=1000, idleMs=1500
- 断点优先级：段落 > 换行 > 空格 > 强制 maxPos
- 串行化发送：promise chain 保证顺序

**Session** (`packages/cli/src/acp-integration/session/Session.ts`, ~1200 行)
- `pendingPromptCompletion`: Promise 串行化防止竞态
- `captureHistorySnapshot()` / `restoreHistory()`: 全量快照
- `rewindToTurn(targetTurnIndex)`: turn 级回退
- `#sendMessageStreamWithAutoCompression()`: 自动压缩 + 诊断消息
- `runToolCalls()`: bounded concurrency (cap=10) + Agent/sequential 分区
- `#preserveUnsentMessageHistory()`: 中断时保留未发送消息
- `MessageRewriteMiddleware`: 消息后处理管线
- L3→L4→L5 权限流

**HistoryReplayer** (`packages/cli/src/acp-integration/session/HistoryReplayer.ts`)
- 使用与 live session 相同的 MessageEmitter/ToolCallEmitter
- 保证 replay 与 live 的渲染一致性
- 处理 user/assistant/tool_result/system(slash_command) 四种记录类型

### OpenCode 关键架构

**session-cache** (`packages/app/src/context/global-sync/session-cache.ts`)
- 40 session 限制 + LRU 淘汰
- `dropSessionCaches`: 按 sessionId 批量清理
- `pickSessionCacheEvictions`: 智能淘汰（保留当前 + 指定 set）

**session-prefetch** (`packages/app/src/context/global-sync/session-prefetch.ts`)
- 15s TTL + inflight 去重 + 版本号检查
- `runSessionPrefetch`: 自动取消过期请求
- `clearSessionPrefetchDirectory`: 按目录批量清理

**session-trim** (`packages/app/src/context/global-sync/session-trim.ts`)
- 时间窗口裁剪 + 保留根会话 + 保留有权限请求的子会话
- `takeRecentSessions`: 保留最近活跃会话

**terminal.tsx** (`packages/app/src/context/terminal.tsx`)
- LocalPTY 持久化：buffer/scrollY/cursor 位置保存
- `MAX_TERMINAL_SESSIONS = 20` 上限
- workspace-scoped 终端缓存
- migration 支持（旧格式兼容）

**terminal-writer** (`packages/app/src/utils/terminal-writer.ts`)
- microtask 调度批量合并写入
- `push` → 累积 chunks → `schedule(run)` → `write(joined)`
- `flush(callback)`: 等待所有写入完成后回调
- 避免逐字符渲染抖动

**session-event** / **session-message** (core)
- EventV2 事件溯源：每个事件 sessionID + timestamp + type
- Schema-validated（Effect Schema）
- 事件类型：prompted, agent-switched, model-switched, shell.started/ended, tool.started/completed/failed, assistant.text/part, file-attachment

## 3. Rivet 当前状态

### 已有的优势
- ECF (Evolutionary Context Fabric) — claim store, compact policy, context ledger 等远超竞品
- ErrorBoundary 组件捕获渲染错误
- TurnHarness: retry/trajectory 自动重试
- RingBuffer(500) 限制静态条目数
- SessionPersist: JSONL append + metadata + memory + claims
- session-fork.ts: 按 line 切分 fork 会话
- 80ms/200ms/120ms 分级定时 flush (stream/thinking/tool)
- context ceiling enforcement (95% threshold)
- Cache diagnostic + drift detection

### 已识别的差距（按影响排序）

| # | 差距 | 影响 | 竞品参照 |
|---|------|------|---------|
| G1 | 流式渲染无语义断点 | 长文本截断不连贯 | Qwen BlockStreamer |
| G2 | 无会话快照/turn 级恢复 | 崩溃恢复不可靠 | Qwen captureHistorySnapshot |
| G3 | 恢复时无渲染管线 | 恢复会话视觉质量低 | Qwen HistoryReplayer |
| G4 | 无提交串行化保护 | 边缘竞态风险 | Qwen pendingPromptCompletion |
| G5 | 无终端状态持久化 | 重启后输出全丢 | OpenCode LocalPTY |
| G6 | 无会话淘汰策略 | session 文件无限增长 | OpenCode session-cache |

## 4. 设计方向决策

### 决策 1：语义流式 vs 固定定时
- 选择：**语义流式断点**（Qwen 模式）— 在字符阈值内寻找自然断点
- 理由：80ms 固定定时在网络波动时表现差，语义断点更尊重文本结构
- 风险：实现稍复杂，但 BlockStreamer 模式已在 Qwen 生产验证

### 决策 2：快照策略
- 选择：**turn 级快照**（非全量） — 每个 turn 完成时保存 checkpoint
- 理由：全量快照开销大；turn 级已足够支持 rewind 和崩溃恢复
- 实现方式：在 SessionPersist 中增加 turn-indexed snapshot 文件

### 决策 3：恢复渲染
- 选择：**轻量 replay** — 恢复时通过现有 LogEntry → renderStaticEntry 管线渲染
- 理由：Qwen 的 HistoryReplayer 需要独立 emitter，Rivet 的 Static + LogEntry 架构可以直接复用
- 不引入独立 replay 层，而是在 `loadMessages` 后重建 staticItems

### 决策 4：串行化
- 选择：**Promise chain** — handleSubmit 返回 Promise，下个 submit 等前一个 resolve
- 理由：最简单有效，Qwen 已验证

### 决策 5：会话淘汰
- 选择：**LRU + 上限** — 保留最近 N 个 session，清理最旧的
- 理由：OpenCode 的 40 session limit 合理；Rivet 的 `listSessions()` 已有基础

### 不做的
- **不引入事件溯源**（OpenCode 的 EventV2）— 过度设计，JSONL 已足够
- **不做工具并发**（Qwen bounded concurrency）— 独立优化，不在 HA 范围
- **不做终端 buffer 持久化**（OpenCode LocalPTY）— Ink 的 Static 组件不支持此模式，收益不大

## 5. 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 语义断点在高吞吐时增加延迟 | 低 | 低 | maxChars 强制分割保底 |
| turn 快照写入性能 | 低 | 中 | 异步写入 + writeback |
| replay 大量条目时启动慢 | 中 | 中 | 懒加载 + 分页 |
| Promise chain 在异常中断链 | 低 | 高 | finally 中始终 resolve |

## 6. 预期成果

- BlockStreamWriter 替换固定定时 flush → 流式渲染质量显著提升
- TurnSnapshot 增加崩溃恢复可靠性 → 长会话不再怕意外退出
- HistoryReplayBridge 恢复时走渲染管线 → 恢复会话与实时会话视觉一致
- PromptQueue 串行化提交 → 消除竞态
- SessionEviction 自动淘汰旧会话 → 磁盘使用可控
