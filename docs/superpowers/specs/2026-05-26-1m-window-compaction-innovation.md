# 100 万窗口上下文压缩创新方案

> 日期：2026-05-26
> 目标：借鉴 Claude Code 压缩机制，结合天枢 100 万窗口特性，提出创新改造点
> 前置：已完成 prefix cache trailer mode、session split、prune request-time mask 等优化

---

## 一、Claude Code 压缩机制核心发现

### 1.1 三层压缩架构

```
microCompact（tool result 裁剪）
    ↓ 触发条件：estimatedTokens > effectiveWindow - 13K buffer
sessionMemoryCompact（会话记忆提取 + 保留）
    ↓ 用 LLM 摘要前先提取记忆
fullCompact（LLM 全量摘要）
    ↓ 9 个结构化 section + analysis scratchpad
postCompactCleanup（文件附件恢复 + 状态同步）
```

### 1.2 关键设计细节

**autoCompact 阈值**：
- `AUTOCOMPACT_BUFFER_TOKENS = 13,000` — 触发前保留的缓冲
- `MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20,000` — 摘要输出预留
- 有效窗口 = contextWindow - reservedForSummary
- 连续失败 3 次触发熔断器停止重试

**microCompact 策略**：
- 只压缩特定工具：FileRead, Shell, Grep, Glob, WebSearch, WebFetch, FileEdit, FileWrite
- 时间驱动触发 + 缓存路径优化
- `TIME_BASED_MC_CLEARED_MESSAGE = '[Old tool result content cleared]'`
- 图片固定 2000 token 估算

**fullCompact 摘要 Prompt**（核心创新）：
```
CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

<analysis>
[思考过程草稿 — 最终被剥离，不进入上下文]
</analysis>

<summary>
1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections（含完整代码片段）
4. Errors and fixes（含用户反馈）
5. Problem Solving
6. All user messages（非 tool result 的所有用户消息）
7. Pending Tasks
8. Current Work（含文件名和代码片段）
9. Optional Next Step（含直接引用防止任务漂移）
</summary>
```

**sessionMemoryCompact**：
- 压缩前自动提取会话记忆
- `minTokens: 10_000` — 保留的最小 token 数
- `minTextBlockMessages: 5` — 保留的最小文本消息数
- `maxTokens: 40_000` — 硬上限
- 记忆持久化到磁盘，跨压缩周期存活

**Tool Result 持久化**：
- 大结果写入磁盘（`tool-results/` 目录）
- 消息中只保留 `<persisted-output>` 引用
- 模型可通过 `read_file` 按需读取
- 每个工具可配置不同的持久化阈值

**Context Collapse**（新特性）：
- Feature-gated（`CONTEXT_COLLAPSE`）
- 在 autoCompact 中作为可选路径
- 目录 `src/services/contextCollapse/`（本次未找到源码，可能是内部实验）

---

## 二、天枢 100 万窗口的特殊性

### 2.1 当前架构

```
System Prompt (frozen)
    ↓
Volatile Block (stable portion — frozenBase)
    ↓
Cache Anchors (前 2 条消息)
    ↓
History Messages (append-only, 不修改)
    ↓
Dynamic Appendix (cachedFreshBlock + 用户输入, trailer mode)
```

### 2.2 当前压缩策略

| 层 | 策略 | 1M 窗口行为 |
|----|------|------------|
| Prune | request-time mask | 1M: 保护最近 60 条，只清除 >150KB 的 tool result |
| Stale Round | 时间衰减截断 | 1M: 保护最近 30 条，preview 150KB |
| Micro Compact | 跳过 | 1M 窗口下完全跳过（`contextWindow >= 1_000_000`） |
| Session Split | 86% 触发 | 保留 cache anchors + handoff summary |
| Emergency | 95% 强制 | checkpoint-resume |

### 2.3 核心约束

- DeepSeek V4 是 exact-prefix cache，字节级精确匹配
- 任何对历史消息的修改都会破坏 prefix cache
- 100M 窗口 ≈ 25M token，足够 30-100 轮深度编码会话
- 压缩的目标不是"释放空间"，而是"保持上下文质量"

---

## 三、创新改造点

### 创新 1：结构化智能摘要（借鉴 Claude Code 的 9-Section 摘要）

**现状**：session split 的 handoff 只有简单的工作状态摘要。

**改造**：在 session split 和 emergency compact 时，使用结构化摘要模板：

```
<session-split-summary>
<analysis>
[内部推理 — 不进入最终上下文]
</analysis>

## 1. 用户核心需求
[精确描述用户的所有显式请求]

## 2. 关键技术决策
[列出所有重要决策及其原因]

## 3. 文件与代码
- path/to/file.ts
  - 重要性：[为什么这个文件重要]
  - 变更：[做了什么修改]
  - 关键代码：[代码片段]

## 4. 错误与修复
- 错误：[具体错误]
  - 原因：[根因]
  - 修复：[怎么修的]
  - 用户反馈：[用户说了什么]

## 5. 当前工作
[正在做什么，最后一步是什么]

## 6. 待办事项
[明确的待办列表]

## 7. 下一步
[下一步要做什么，附直接引用]
</session-split-summary>
```

**实现位置**：`src/agent/compaction-controller.ts` 的 `trySessionSplit()` 和 `enforceContextCeiling()`

**收益**：
- 结构化摘要比自由文本更不容易丢失关键信息
- "文件与代码"部分保留代码片段，避免压缩后模型需要重新读取
- "错误与修复"部分保留调试经验，避免重复犯错
- "下一步"附直接引用，防止任务漂移

**复杂度**：低 — 只需修改 handoff 模板

---

### 创新 2：会话记忆自动提取（借鉴 Claude Code 的 sessionMemoryCompact）

**现状**：天枢有 Dream 记忆蒸馏，但不是每个会话都运行，且不与压缩集成。

**改造**：在 session split 和 compact 前，自动提取会话记忆：

```
提取目标：
1. 用户偏好（feedback 类型）— 用户纠正过的行为
2. 关键决策（decision 类型）— 架构选择、技术方案
3. 文件引用（file_observation 类型）— 重要的文件路径和内容
4. 错误模式（failure_pattern 类型）— 已知的失败模式和修复方法
5. 任务状态（task_state 类型）— 当前进度和待办
```

**实现方案**：
1. 在 `extractTaskState()` 基础上扩展，增加偏好/决策/错误模式提取
2. 提取结果写入 `.rivet/session-memory.json`（JSONL 格式）
3. 下一个会话启动时，自动加载最近的会话记忆
4. 与 claim store 集成，作为 `session_memory` 类型的 claim

**实现位置**：新建 `src/agent/session-memory.ts`，集成到 `compaction-controller.ts`

**收益**：
- 压缩不再丢失用户偏好和关键决策
- 跨会话知识积累（类似 Claude Code 的 MEMORY.md）
- 与现有的 claim store 机制天然兼容

**复杂度**：中 — 需要新的提取逻辑和持久化

---

### 创新 3：分层 Tool Result 管理（借鉴 Claude Code 的 toolResultStorage）

**现状**：天枢通过 artifact wrapping 处理大 tool result，但阈值策略较简单。

**改造**：实现分层 tool result 管理：

```
层级 0（内联）：< 4KB — 直接保留在消息中
层级 1（摘要引用）：4KB - 150KB — 保留摘要 + artifact 引用
层级 2（磁盘持久化）：> 150KB — 写入磁盘，消息中只保留引用
```

**关键改进**：
1. **每工具阈值**：不同工具使用不同的阈值
   - `read_file`: 150KB（代码文件通常较大）
   - `bash`: 50KB（命令输出通常较短）
   - `grep`: 20KB（搜索结果通常很紧凑）
   - `run_tests`: 100KB（测试输出可能很长）

2. **智能摘要**：对持久化的 tool result 生成结构化摘要
   - 包含文件路径、函数签名、错误信息
   - 让模型能够判断是否需要 `read_section` 读取完整内容

3. **引用格式标准化**：统一 `[artifact:ID]` 格式
   - 已实现，但可以增加元数据（文件类型、行数、大小）

**实现位置**：`src/compact/prune.ts` + `src/tools/output-store.ts`

**收益**：
- 更精细的 tool result 管理，避免过度截断或过度保留
- 结构化摘要让模型更容易判断是否需要读取完整内容
- 每工具阈值适应不同工具的输出特性

**复杂度**：低 — 基于现有 artifact wrapping 扩展

---

### 创新 4：重要性感知的消息保留（借鉴 Claude Code 的 partialCompact）

**现状**：session split 保留 cache anchors + 最近消息 + handoff summary，但不区分消息重要性。

**改造**：在 session split 时，根据消息重要性决定保留哪些消息：

```
重要性评分：
- 含错误的 tool result: +3
- 含用户反馈的 user message: +3
- 含关键决策的 assistant message: +2
- 含文件路径的 tool result: +1
- 普通 tool result: 0
- 成功的 bash 输出: -1（通常可以重新执行）
```

**保留策略**：
1. Cache anchors（前 2 条）：始终保留
2. 最近 N 条消息：始终保留（N = 30 for 1M window）
3. 高重要性消息（score >= 2）：保留
4. 低重要性消息：丢弃

**实现位置**：新建 `src/compact/message-importance.ts`，集成到 `compaction-controller.ts`

**收益**：
- 压缩后保留最有价值的上下文
- 避免丢失错误调试经验和用户反馈
- 100M 窗口下可以保留更多高价值消息

**复杂度**：中 — 需要重要性评分算法

---

### 创新 5：压缩后状态恢复（借鉴 Claude Code 的 postCompactCleanup）

**现状**：session split 后只保留 handoff summary，不恢复文件状态。

**改造**：压缩后自动恢复关键状态：

```
恢复目标：
1. 最近读取的文件列表 — 从 trajectory 中提取
2. 最近修改的文件列表 — 从 evidence tracker 中提取
3. 活跃的 claim — 从 claim store 中提取
4. 当前任务状态 — 从 task state 中提取
5. 最近的错误模式 — 从 trace store 中提取
```

**实现方案**：
1. 在 session split 后，自动读取最近 5 个文件的前 50 行
2. 将读取结果作为附件消息注入
3. 恢复 claim store 的活跃 claims
4. 恢复 task state

**实现位置**：扩展 `compaction-controller.ts` 的 `replaceWithCheckpoint()`

**收益**：
- 压缩后模型不需要重新读取文件
- 任务状态和决策不会丢失
- 减少压缩后的"冷启动"时间

**复杂度**：中 — 需要状态提取和注入逻辑

---

### 创新 6：上下文分析仪表盘（借鉴 Claude Code 的 analyzeContext）

**现状**：天枢有 `VolatilePayloadReport` 但没有全面的上下文分析。

**改造**：实现上下文分析工具：

```
分析维度：
1. Token 分布 — system / tools / messages / volatile / dynamic 各占多少
2. 消息统计 — 总数、各角色分布、平均长度
3. Tool result 统计 — 各工具的输出大小分布
4. 缓存效率 — prefix cache 命中率、miss 原因
5. 压缩历史 — 压缩次数、压缩比、压缩后恢复时间
```

**实现方案**：
1. 新建 `src/context/analyzer.ts`
2. 提供 `/analyze` 命令或 `analyze_context` 工具
3. 输出结构化报告

**收益**：
- 让用户了解上下文使用情况
- 帮助调试缓存命中率问题
- 为压缩策略优化提供数据支持

**复杂度**：低 — 主要是统计和展示

---

## 四、100M 窗口下的压缩策略矩阵

| 上下文使用率 | 策略 | 具体行为 |
|-------------|------|---------|
| < 60% | 无压缩 | 正常运行，不做任何压缩 |
| 60-72% | 观察 | 记录增长趋势，准备压缩 |
| 72-86% | Micro + Prune | 截断旧 tool result，清除 >150KB 的输出 |
| 86-92% | Session Split | 保留 cache anchors + 高价值消息 + 结构化 handoff |
| 92-95% | Reactive Compact | LLM 摘要 + 会话记忆提取 + 状态恢复 |
| > 95% | Emergency | checkpoint-resume，强制压缩 |

**关键差异**（vs 小窗口）：
- 100M 窗口下，micro compact 被跳过（已有实现）
- Prune 阈值大幅提高（150KB vs 1.2KB）
- Session split 是主要压缩手段，不是 LLM 摘要
- 会话记忆提取在 split 前运行，不丢失关键信息

---

## 五、实施优先级

### Phase 1（1 周）：结构化摘要 + Tool Result 分层
- 改造 session split handoff 模板
- 实现每工具阈值配置
- 预期收益：压缩后信息保留率提升 30%+

### Phase 2（1 周）：会话记忆自动提取
- 实现 `session-memory.ts`
- 集成到 compaction controller
- 预期收益：跨会话知识积累，减少重复工作

### Phase 3（2 周）：重要性感知保留 + 状态恢复
- 实现消息重要性评分
- 实现压缩后状态恢复
- 预期收益：压缩后"冷启动"时间减少 50%+

### Phase 4（1 周）：上下文分析仪表盘
- 实现 `analyzer.ts`
- 提供 `/analyze` 命令
- 预期收益：调试效率提升

---

## 六、与 Claude Code 的关键差异

| 维度 | Claude Code | 天枢 | 差异原因 |
|------|------------|------|---------|
| 窗口大小 | 200K (Sonnet) | 1M (DeepSeek V4) | 天枢可以更激进地保留上下文 |
| 缓存策略 | TTL-based | Exact-prefix matching | 天枢需要更严格的 prefix 稳定性 |
| 压缩触发 | 80% 阈值 | 86% session split | 100M 窗口有更多 headroom |
| 摘要方式 | LLM full compact | Session split + handoff | 天枢避免 LLM 调用的延迟和成本 |
| 记忆系统 | MEMORY.md + 自动提取 | Claim store + Dream | 天枢的记忆更结构化 |
| Tool result | 磁盘持久化 + 引用 | Artifact wrapping | 天枢已实现类似机制 |

**天枢独有优势**：
1. Exact-prefix cache 优化 — Claude Code 没有的深度优化
2. Session split 替代 compaction — 更适合大窗口
3. Claim store — 结构化的知识积累
4. Ice Mirror cache engine — 多提供商缓存适配
5. Sensorium 自感知 — 基于 agent 状态的自适应压缩

---

## 七、源码级补充发现

### 7.1 时间驱动的 Micro Compact（Claude Code 独有）

Claude Code 有一个时间驱动的 micro compact 触发器（`timeBasedMCConfig.ts`）：

```typescript
// 当距离上次 assistant 回复超过 60 分钟时，清除旧 tool results
// 因为服务器端 prompt cache 已经过期，整个前缀会被重写
// 此时清除旧 tool results 可以减少重写的数据量
gapThresholdMinutes: 60
keepRecent: 5  // 保留最近 5 个 tool results
```

**核心洞察**：如果缓存已经过期，保留旧的 tool results 没有意义——它们会被重写。不如提前清除，减少重写的数据量。

**天枢借鉴**：
- DeepSeek V4 的缓存 TTL 是数小时到数天
- 可以在检测到缓存 miss 率骤升时，主动清除旧 tool results
- 不需要等 60 分钟——可以基于 cache hit rate 下降来触发

### 7.2 Cached Micro Compact（Claude Code 独有）

Claude Code 使用 cache-editing API 来移除 tool results，而不破坏缓存前缀：

```typescript
// 关键差异：不修改本地消息内容
// cache_reference 和 cache_edits 在 API 层添加
// 使用基于计数的触发/保留阈值
// 优先于 regular microcompact
```

**核心洞察**：有些 API 支持 `cache_edits`，可以在不修改消息内容的情况下删除旧的 tool results。

**天枢借鉴**：
- DeepSeek V4 不支持 `cache_edits` API
- 但可以通过 request-time prune 达到类似效果（已实现）
- 未来如果 DeepSeek 支持类似 API，可以无缝集成

### 7.3 Forked Agent 用于 Compact Summary（Claude Code 独有）

Claude Code 在 forked agent 中运行 compact summary，复用主对话的缓存前缀：

```typescript
// 复用主对话的缓存前缀（system prompt, tools, context messages）
// 3P default: true — forked-agent path reuses main conversation's prompt cache
// 实验确认：false path is 98% cache miss, costs ~0.76% of fleet cache_creation
```

**核心洞察**：compact summary 本身也需要调用 LLM，如果能复用主对话的缓存前缀，可以大幅降低成本。

**天枢借鉴**：
- 天枢的 compact 使用独立的 `compactClient`，不复用主对话的缓存
- 可以改为使用主对话的 StreamClient + 相同的 system prompt
- 预期收益：compact 调用的 cache hit rate 从 ~2% 提升到 ~90%

### 7.4 Partial Compact（Claude Code 独有）

Claude Code 支持 `partialCompactConversation`，只摘要部分对话：

```typescript
// direction: 'from' — 摘要 pivotIndex 之后的消息
// direction: 'up_to' — 摘要 pivotIndex 之前的消息
// 保留的消息过滤掉 progress 和 compact boundary
```

**核心洞察**：大上下文下，不需要摘要整个对话——可以只摘要"旧的部分"，保留"新的部分"。

**天枢借鉴**：
- 天枢的 session split 保留 cache anchors + 最近消息
- 可以增加"半压缩"模式：只摘要中间部分（30-60 轮之前的消息）
- 保留最近 30 轮的完整消息 + 最早 2 条 cache anchors

### 7.5 Post-Compact Cleanup（Claude Code 独有）

Claude Code 在压缩后执行广泛的清理：

```typescript
resetMicrocompactState()        // 重置 micro compact 状态
resetContextCollapse()           // 重置 context collapse
getUserContext.cache.clear?.()   // 清除用户上下文缓存
resetGetMemoryFilesCache()       // 清除记忆文件缓存
clearSystemPromptSections()      // 清除 system prompt 缓存
clearClassifierApprovals()       // 清除分类器审批
clearSpeculativeChecks()         // 清除投机检查
clearBetaTracingState()          // 清除追踪状态
clearSessionMessagesCache()      // 清除会话消息缓存
```

**核心洞察**：压缩后，很多缓存和状态都需要清除——否则它们会与新的消息历史不一致。

**天枢借鉴**：
- 天枢在 `session.replaceMessages()` 后调用 `refreshLedger()`
- 但没有清除 prompt engine 的缓存（`cachedFreshBlock`、`fingerprint` 等）
- 应该在 session split 后重置 prompt engine 状态

### 7.6 Session Memory Compact 流程

Claude Code 的 session memory compact 流程：

1. `shouldUseSessionMemoryCompaction()` — 检查 feature flag
2. `waitForSessionMemoryExtraction()` — 等待后台记忆提取完成
3. `getSessionMemoryContent()` — 获取已提取的会话记忆
4. `calculateMessagesToKeepIndex()` — 计算要保留的消息范围
   - 从 `lastSummarizedIndex` 开始
   - 向后扩展直到满足 `minTokens (10K)` 和 `minTextBlockMessages (5)`
   - 不超过 `maxTokens (40K)`
   - 调整以不拆分 tool_use/tool_result 对
5. `createCompactionResultFromSessionMemory()` — 创建压缩结果
6. `buildPostCompactMessages()` — 构建压缩后的消息数组

**核心洞察**：会话记忆在压缩前就被提取好了，压缩时直接使用——不需要额外的 LLM 调用。

**天枢借鉴**：
- 天枢的 Dream 记忆蒸馏是独立的，不与压缩集成
- 可以在 Dream 运行后，将结果保存为"会话记忆"
- 在 session split 时，将会话记忆注入 handoff summary

---

## 八、风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 结构化摘要增加 LLM 调用成本 | 中 | 中 | 只在 session split 时使用，不额外调用 |
| 会话记忆提取增加压缩延迟 | 中 | 低 | 异步提取，不阻塞主流程 |
| 消息重要性评分不准确 | 中 | 中 | 保守策略：不确定时保留 |
| 状态恢复注入过多上下文 | 低 | 中 | 设置上限（最多 5 个文件，每个 50 行） |
| 100M 窗口下压缩策略过于保守 | 低 | 低 | 有 95% emergency 兜底 |
