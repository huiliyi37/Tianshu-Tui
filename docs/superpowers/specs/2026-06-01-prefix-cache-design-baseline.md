# Prefix Cache 设计基线

版本：1.0
日期：2026-06-01
维护人：天璇（Opus 4.8）
状态：已验证（2369 tests pass, tsc clean）

本文档是 Rivet prefix cache 的权威设计基线。任何触及本文档描述的缓存链路的修改，
必须验证不破坏本文档中定义的不变量。

---

## 1. 设计目标

DeepSeek V4 prefix cache 是**字节级连续前缀匹配**。如果请求 2 的前 N 字节与请求 1
完全相同，前 N 字节的 KV cache 直接复用（cache hit），无需重新计算。

**成本模型：**
- cache read: 0.1 元/M tokens
- cache creation (miss): 0.5 元/M tokens（5x）
- 典型 session ~140k tokens/turn × 50 turns = 7M tokens
- 90% hit rate → 节省 ~3.15 元/session

**设计约束：**
- 历史消息的 frozen content 在首次冻结后**字节永不变**
- 最新消息的 frozenBase 部分必须与历史消息的 frozenBase **字节一致**
- dynamicAppendix 只出现在最新消息尾部，不影响历史前缀
- 1M+ 窗口下禁止任何 mutate 历史消息的操作（pruning、masking、dedup）

---

## 2. 架构总览

```
API Request = [system_prompt, ...messages]

消息组装 (PromptEngine.buildOaiRequest):
┌──────────────────────────────────────────────────────────┐
│ system prompt (frozen) — 永不变                          │
├──────────────────────────────────────────────────────────┤
│ 历史 user msg 0: frozenUserMerged["content"][0]          │
│ 历史 assistant msg 0                                      │
│ 历史 user msg 1: frozenUserMerged["content"][0]          │
│ 历史 assistant msg 1                                      │
│ ...                                                       │
├──────────────────────────────────────────────────────────┤
│ 最新 user msg: frozenBase + dynamicAppendix              │ ← cachedFreshBlock
│   + "
---
" + 用户原文                                  │    同一 user msg 内不重建
└──────────────────────────────────────────────────────────┘
```

---

## 3. Frozen Base（buildStableVolatileBlock）

frozenBase 在 session 启动时构建，session 全程不变。出现在每条 user message 的前部。

| 字段 | 来源 | 稳定性 |
|------|------|--------|
| `<environment>` | cwd/platform/os | session 内不变 |
| `<sober>` | 天枢锚点（静态文本） | 永不变 |
| `<project-instructions>` | AGENTS.md + .rivet.md | 30s TTL 缓存 |
| `<project-memory>` | .rivet/knowledge/memory.jsonl | 文件变更才更新 |
| `<seed-capsule>` | 天璇胶囊 L1 | 文件变更才更新 |
| `<working-set>` | session 启动时确定 | session 内不变 |

**显式 strip 的字段**（`buildStableVolatileBlock` 中设为 undefined）：
- `gitStatus` — 每轮变，移到 dynamic appendix
- `planModeState` — 可能 mid-session 变化
- `worktreeReality` — 可能 mid-session 变化
- `activeDomain` — 每轮变
- `toolHistory` — 每轮变
- `taskProgress` — 每轮变
- `behaviorMirror` / `decisions` / `strategyShift` / `repairHint` — 按需变
- `routingReason` / `cerebellarHint` — 按需变

**不变量：** frozenBase 在 constructor 中从 `config.volatileCtx` 构建后，只在
`updateSessionMemory()` 时通过 `rebuildFrozenBase()` 重建。重建后 frozenBase 变化
会导致 prefix cache miss（这是预期行为——session memory 变化意味着上下文本质变了）。

---

## 4. Dynamic Appendix（buildDynamicAppendix）

dynamicAppendix 只出现在**最新一条 user message** 的尾部。每轮可能变化。

| 字段 | 变化频率 | 说明 |
|------|---------|------|
| `<tool-history>` | 每轮 | 最近 8 条工具调用 |
| `<task-progress>` | 每轮 | 任务进度 |
| `<git-status>` | 每轮 | 30s TTL + dirty flag |
| `<recent-commits>` | 每轮 | 最近 5 条 commit |
| `<session-state>` | 按需 | session 状态快照 |
| `<cross-session-events>` | 按需 | 跨 session 事件 |
| `<worktree-warning>` | 按需 | worktree 不一致 |
| `<consolidated>` | 按需 | habituated 字段 promoted |
| `<historical-lessons>` | 按需 | playbook 经验 |
| `<repair-hint>` | 按需 | 修复建议 |
| `<decisions>` | 按需 | 最近决策 |

**不变量：** dynamicAppendix 的存在不影响历史前缀。它只在最新消息尾部追加。

---

## 5. Frozen User Merged（engine.ts）

### 5.1 数据结构

```typescript
frozenUserMerged: Map<string, string[]>   // content → [snapshot_0, snapshot_1, ...]
frozenFetchIndex: Map<string, number>     // content → next fetch index
lastMessageCount: number                   // 用于区分重复消息和 tool-call 轮次
lastMessageHash: string                    // 同上
```

### 5.2 冻结时机

当一条 user message 首次作为 `lastUserIdx` 被处理时：
1. 构建 `cachedFreshBlock = frozenBase + dynamicAppendix`
2. 合并 `merged = cachedFreshBlock + "
---
" + userContent`
3. 存入 `frozenUserMerged[content].push(merged)`

### 5.3 取回时机

当一条 user message 不是 `lastUserIdx`（变为历史消息）时：
1. 调用 `getNextFrozen(content)` 取回冻结快照
2. `frozenFetchIndex` 确保重复消息按序取回（第一次"继续"取 index 0，第二次取 index 1）

### 5.4 重复消息处理

**问题**：用户发送两条相同内容（如"继续"、"ok"），content-based key 会碰撞。

**解决方案**：`Map<string, string[]>`，每个 content key 存储数组。

**重复检测**：
```typescript
const isDuplicate = userContent === cachedFreshForUser
  && oaiMessages.length === lastMessageCount    // 消息数量相同
  && msgHash !== lastMessageHash                 // 但最后一条消息不同
  && frozenUserMerged.get(content)?.length > 0   // 且已有 frozen entry
```

- 同一消息的 tool-call 轮次：content 相同，length 增长 → 不是 duplicate → 复用缓存
- 真正的重复消息：content 相同，length 相同，但最后一条消息不同 → 强制重建
- 完全相同的调用（测试场景）：content、length、hash 全相同 → 复用缓存

### 5.5 Eviction

当 frozen entries 总数超过 64 时：
1. 找到最长的数组
2. 从头部移除（`.shift()`）
3. 孤儿 entries（compaction 移除的消息）自然被淘汰

### 5.6 不变量

- 历史消息的 frozen content 在首次冻结后字节永不变
- `frozenFetchIndex` 每次 `buildOaiRequest` 调用重置
- 重复消息各自有独立的 frozen snapshot
- eviction 不会破坏仍在消息数组中的 entries

---

## 6. Trailer Mode（engine.ts）

### 6.1 设计

volatile block 合并进最后一条 user message 的内容，而不是作为独立消息推送。

```typescript
// 最新 user message:
{ role: 'user', content: cachedFreshBlock + '
---
' + userContent }

// 历史 user message:
{ role: 'user', content: frozenUserMerged[content][fetchIdx] }
```

### 6.2 为什么用 trailer mode

- 消息数组 append-only → 跨 user-message 边界 prefix 稳定
- 不需要在历史消息前插入 volatile block → 避免 shift 操作
- DeepSeek exact-prefix cache 在消息边界处匹配

### 6.3 frozenUserMerged 冻结格式

每条 frozen entry 都包含完整的 `cachedFreshBlock + '
---
' + content`。
这意味着：
- 历史消息携带了冻结时刻的完整 volatile 上下文
- 不需要在后续调用中重新注入 volatile block
- 字节稳定性由 frozen entry 本身保证

---

## 7. Same-User-Message 缓存（engine.ts）

### 7.1 机制

当同一 user message 的多个 tool-call 轮次到来时：
1. `cachedFreshForUser === userContent` → 跳过 fresh block 重建
2. `cachedFreshBlock` 保持不变 → 字节一致 → prefix cache hit

### 7.2 什么时候重建

- 用户发送新内容（`userContent !== cachedFreshForUser`）
- 检测到真正的重复消息（`isDuplicate === true`）
- `cachedFreshForUser` 首次设置（`=== ''`）

### 7.3 cognitiveProjection 和 sessionState

`setCognitiveProjection()` 和 `setSessionState()` 不触发 fresh block 重建。
它们在下一次 user message 边界时自然生效。这是 by design——保护 tool-call 轮次间的
prefix cache。

---

## 8. Compaction 与 Prefix Cache 的关系

### 8.1 核心结论

**compaction 从不修改 user message 的 `.content`。** User messages 要么原封不动，
要么整体从消息数组中移除。

### 8.2 Mutation Path 清单

| # | Path | 文件 | 改 user content | 移除 user msgs | 1M 窗口 |
|---|------|------|----------------|---------------|---------|
| 1 | microCompactOai Tier 1 | compact/micro.ts:71-83 | NO | NO | 跳过 |
| 2 | microCompactOai Tier 2 | compact/micro.ts:91-114 | NO | YES (round) | 跳过 |
| 3 | replaceWithCheckpoint | compaction-controller.ts:531 | NO | YES (保留 2) | **执行** |
| 4 | stale-round | compact/stale-round.ts:33 | NO | NO (只改 tool) | 跳过 |
| 5 | agent-diet | compact/agent-diet.ts:118 | NO | NO (只改 tool) | 跳过 |
| 6 | observation masking | engine.ts:294-314 | NO | NO (只改 tool) | 跳过 |
| 7 | semantic prune | engine.ts:277-286 | NO | NO (只改 tool) | 跳过 |
| 8 | file dedup | engine.ts:318-341 | NO | NO (只改 tool) | 跳过 |
| 9 | llmCompact | compaction-controller.ts:595 | NO | NO | **执行** |
| 10 | /compact 命令 | slash-commands.ts:226 | NO | YES (同 #2) | N/A |
| 11 | /sessions resume | context/resume-preflight.ts:164 | NO | NO (splice tool) | N/A |
| 12 | frozenUserMerged eviction | engine.ts:349-360 | NO | NO (内存回收) | **执行** |

### 8.3 1M 窗口保护

1M+ 窗口下，以下操作全部被 `contextWindow < 1_000_000` 守卫跳过：
- observation masking
- semantic pruning + staleness detection
- file content dedup + disk budget
- micro compact Tier 1 & 2
- stale-round truncation
- agent-diet

**1M 窗口唯一的 compaction 路径**是 `replaceWithCheckpoint`（75% LLM compact
或 95% emergency ceiling）。这条路经保留 2 条 cache anchors + 1 条 summary，
重建 prefix。Prefix cache miss 是 inherent 的（消息数量变了），不是 bug。

### 8.4 frozenUserMerged 在 compaction 后的行为

| 场景 | frozenUserMerged 状态 | 后果 |
|------|----------------------|------|
| micro Tier 2 移除中间消息 | 被移除消息的 entries 变成孤儿 | 无害，eviction 回收 |
| replaceWithCheckpoint | 所有非 anchor entries 变成孤儿 | 无害，eviction 回收 |
| 新 summary message | 没有 frozen entry | 走 fresh build，正确冻结 |
| Anchor messages | 保留原始 frozen entries | 与 frozenBase 一致 |

---

## 9. Session Split 与 Abort

### 9.1 Session Split（86% 阈值）

`trySessionSplit` → `replaceWithCheckpoint` → 保留 2 anchors + handoff summary。

- PromptEngine 不重建（session 全程单例）
- frozenUserMerged 中的旧 entries 变成孤儿
- 新 summary message 走 fresh build
- **风险：LOW**

### 9.2 Abort / Error Recovery

```
if (collectedBlocks.length > 0) {
  addAssistantBlocks(collectedBlocks)  // 保留部分 assistant 响应
  assistantResponded = true
}
if (!assistantResponded && !userMessageConsumed)
  removeLastMessage()  // 回滚 user message
```

- `removeLastMessage` 移除最后一条 user message
- frozenUserMerged 中该 message 的 entry 变成孤儿
- 用户重试时，新 message 走 fresh build（`isDuplicate` 检测正确处理）
- `frozenFetchIndex` 每次调用重置，不受 abort 影响
- **风险：NEGLIGIBLE**

### 9.3 Cache Anchor 保护

`CACHE_ANCHOR_MESSAGES = 2`。前 2 条消息（初始 user request + assistant response）
在所有 compaction 路径中被保留。这是 prefix cache 的锚点：

```
[System][Tools][Volatile][User1][Asst1] ← 这 5 个字节前缀在 compaction 后仍然匹配
```

---

## 10. 风险矩阵

| 风险 | 级别 | 窗口 | 说明 | 缓解措施 |
|------|------|------|------|---------|
| frozenUserMerged key 碰撞 | ~~中~~ → **已修复** | ALL | Map → Map + occurrence array | e2ca89e |
| planModeState 未 strip | ~~低~~ → **已修复** | ALL | 显式 undefined | 4a45f05 |
| compaction 移除 user messages | LOW | <1M | entries 变孤儿 | eviction 回收 |
| replaceWithCheckpoint | MEDIUM* | ALL | 全量 prefix miss | 设计意图，非 bug |
| micro Tier 2 round 移除 | MEDIUM | <1M | 含 user messages | 1M 窗口跳过 |
| eviction shift 重复消息 | LOW | ALL | 最长数组 .shift() | 64 条上限 |
| gitStatusCache 刷新盲区 | NEGLIGIBLE | ALL | 30s 内可能过期 | 最终一致性 |
| firstUserIdx 双消息推送 | NEGLIGIBLE | ALL | 无 frozen entry 时 | 下游不依赖 index |
| updateSessionMemory stale entries | NEGLIGIBLE | ALL | rebuild 不清除 map | compaction 掩盖 |

*MEDIUM 不是 bug——emergency compaction 的设计意图。

---

## 11. 测试覆盖

| 测试文件 | 测试数 | 覆盖内容 |
|---------|--------|---------|
| engine-cache-stability.test.ts | 27 | frozen/dynamic 分离、multi-turn 稳定性、tool-call 缓存、sessionState 安全、habituation |
| engine.test.ts | 21 | trailer mode、git-dirty、toolHistory cap、frozenUserMerged eviction |
| volatile.test.ts | — | volatile block 结构、XML 标签 |
| static.test.ts | — | system prompt ��构 |
| npm test (full suite) | 2369 | 全量回归 |

### 关键测试场景

1. **FROZEN 不含 git-status** ✅
2. **FROZEN 是 FRESH 的字节前缀** ✅
3. **历史 turn 的 frozen base 跨 5 轮字节一致** ✅
4. **同一 user msg 内 10 次 tool-call volatile 不变** ✅
5. **sessionState 更新不破坏同 user msg 缓存** ✅
6. **cognitiveProjection 不破坏同 user msg 缓存** ✅
7. **habituation promoted 后历史消息保持 frozen** ✅
8. **eviction 在 70 条消息后正确清理** ✅

---

## 12. 修改 Checklist

任何触及以下文件的 PR 必须通过本文档的不变量检查：

- `src/prompt/engine.ts` — frozenUserMerged、buildOaiRequest、trailer mode
- `src/prompt/volatile.ts` — buildStableVolatileBlock、buildDynamicAppendix
- `src/prompt/static.ts` — system prompt
- `src/compact/*.ts` — pruning、masking、dedup
- `src/agent/compaction-controller.ts` — compaction 触发、replaceWithCheckpoint
- `src/agent/context.ts` — replaceMessages、removeLastMessage

**检查步骤：**
1. `npx tsx --test src/prompt/__tests__/engine-cache-stability.test.ts` — 27 tests pass
2. `npx tsx --test src/prompt/__tests__/engine.test.ts` — 21 tests pass
3. `npm test` — 2369 tests pass
4. `npx tsc --noEmit` — no errors
5. 确认 frozenBase 中没有新增每轮变化的字段
6. 确认 1M 窗口下没有新增 mutate 历史消息的操作

---

## 13. 已修复的问题

| Commit | 问题 | 严重度 | 修复 |
|--------|------|--------|------|
| d9256bc | git-status 在 frozen prefix 中 | 严重 | 移至 dynamic appendix |
| a23724c | consolidatedBlock 在 frozen prefix 中 | 高 | 移至 dynamic appendix |
| 4a45f05 | planModeState/worktreeReality 未 strip | 低 | 显式 undefined |
| e2ca89e | frozenUserMerged key 碰撞 | 中 | Map + occurrence array |

---

*本文档基于 2026-06-01 的代码审计和 3 路 scout 并行调查。*
*涉及 commits: d9256bc, a23724c, 4a45f05, e2ca89e。*
*下次审计触发条件：compaction 逻辑变更、frozenUserMerged 结构变更、新 volatile 字段。*
