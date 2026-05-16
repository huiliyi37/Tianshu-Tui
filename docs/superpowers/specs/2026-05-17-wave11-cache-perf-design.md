# Wave 11: 性能优化 — Cache 效率 + Token 节约

## 目标

1. 让 prefix cache 效率可观测（per-turn hit rate、prewarm stats、miss 诊断）
2. 通过 tool result 截断减少 context 不必要膨胀
3. 增强 prewarm cache 提升 read_file 命中率

## 架构

### Part 1: Cache 可观测性（Task 1-3）

**数据流：**
```
SessionContext.addUsage() → recordTurnCache() → TurnCacheSnapshot[]
                                                       ↓
AgentLoop.getPrewarmStats() ─────────────────→ cockpit model panel
                                                       ↑
diagnoseCacheMiss() ← on cache_hit_rate < 0.8 ────────┘
```

**Task 1: Per-turn cache hit rate 计算**

`SessionContext` 已有 `recordTurnCache` 和 `getCacheHistory`。需要：
- 在 `AgentLoop.run()` 的 `onStopReason` 回调中调用 `session.recordTurnCache(turn, usage)`
- 新增 `SessionContext.getPerTurnHitRate()` 返回最近 turn 的 hit rate
- cockpit model panel 读取并展示

**Task 2: Prewarm stats 暴露**

`PrewarmCache.stats()` 已存在。需要：
- `AgentLoop.getPrewarmStats()` 公开方法
- cockpit model panel 展示 hits/misses/hitRate

**Task 3: Cache diagnostic 自动触发**

`diagnoseCacheMiss()` 已实现但未被自动调用。需要：
- 在 `AgentLoop.run()` 的 turn 结束时，如果 hit rate < 0.8，调用 diagnostic
- 结果存入 `traceStore` 作为 trace event
- cockpit model panel 展示最近的 diagnostic message

### Part 2: Tool Result 截断（Task 4-5）

**位置：** `src/agent/tool-pipeline.ts` 的 harness result 返回后

**策略：**
```typescript
const MAX_RESULT_TOKENS = contextWindow * 0.3  // 已定义在 compactThresholds

if (estimateMessageTokens(result) > MAX_RESULT_TOKENS) {
  result = truncateToolResult(result, MAX_RESULT_TOKENS)
}
```

**截断算法：**
- head: 前 60% 字符
- tail: 后 30% 字符
- 中间插入: `\n...[truncated ${removed} chars]...\n`
- 保留完整的最后一行（避免截断 JSON/代码中间）

**新文件：** `src/agent/tool-result-truncate.ts`（~40 行）

### Part 3: Prewarm 增强（Task 6-7）

**Task 6: 扩容 + LRU**

修改 `PrewarmCache`：
- `maxEntries`: 20 → 50
- `ttlMs`: 30_000 → 60_000
- 淘汰策略: FIFO → LRU（`get` 时更新 timestamp）

**Task 7: 并行预读**

修改 `maybePrewarm`：
- 当 `extractIntents` 返回多个 file intent 时，用 `Promise.all` + `fs.promises.readFile` 并行读取
- 限制并行度 ≤ 5（避免 fd 耗尽）

## 验收标准

| 标准 | 验证 |
|------|------|
| cockpit model panel 展示 per-turn hit rate | 手动验证 |
| cockpit model panel 展示 prewarm stats | 手动验证 |
| cache miss 时 diagnostic 自动触发 | unit test |
| tool result > 阈值时截断 | unit test |
| 截断后 context 增长可控 | unit test |
| prewarm LRU 淘汰正确 | unit test |
| prewarm 并行预读不超过 5 并发 | unit test |
| 全量测试通过 | npm test: 0 fail |
| Typecheck 通过 | npx tsc --noEmit: 0 errors |
