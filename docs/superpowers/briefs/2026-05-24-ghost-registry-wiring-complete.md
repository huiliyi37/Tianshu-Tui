# GhostRegistry 接入完成 — 冰鉴 v3 自适应缓存闭环

**日期**: 2026-05-24
**状态**: ✅ 已完成
**关联计划**: `docs/superpowers/plans/2026-05-24-冰鉴v3-自适应缓存闭环引擎.md`

## 背景

冰鉴 v3 的核心模块（GhostRegistry、AdaptiveThresholdController、BehaviorLearner、SessionWarmthTracker）已全部实现并通过测试，但 `loop.ts` 中的 `cacheAdvisor.onTurnEnd()` 一直传入空数组——GhostRegistry 从未收到真实的 eviction/access 事件，自适应阈值调整形同虚设。

## 实现方式

### 数据流

```
tool-pipeline: artifactIntercept() 创建 artifact
    → extractArtifactId(content) 提取 ID
    → deps.artifactIdsEvicted.push(id)

tool-pipeline: read_section 执行成功
    → tu.input.artifactId 提取 ID
    → deps.artifactIdsAccessed.push(id)

tool-execution: executeBatch()
    → 创建 turn-scoped 累加器 []
    → 传入每个 executeToolUse 的 ToolPipelineDeps
    → 返回 ToolExecBatchResult { artifactIdsEvicted, artifactIdsAccessed }

loop.ts: tool execution 完成后
    → cacheAdvisor.onTurnEnd({ ..., r.artifactIdsEvicted, r.artifactIdsAccessed })
    → ghostRegistry.record() / markAccessed()

AdaptiveThresholdController.adjust():
    → getRecentGhostHits(3, turn) >= 2 → 提高阈值 (+200)
    → getEvictionEfficiency() > 0.9 → 降低阈值 (-50)
    → 下一轮 artifactIntercept 使用新阈值
```

### 关键设计决策

1. **Turn-scoped 累加器而非修改 artifactIntercept 返回值** — `artifactIntercept` 返回 `string`，改为 tuple 会影响所有调用点。用 `deps` 上的可选数组更轻量。

2. **从返回内容提取 ID 而非从 artifactStore.save() 传出** — `extractArtifactId()` 用正则 `/^\[artifact:([^\]]+)\]/` 匹配。虽然间接，但避免了修改 `artifactIntercept` 的签名。

3. **cacheAdvisor.onTurnEnd() 移到 tool execution 之后** — 原来在 API streaming 完成后立即调用，此时还没有 artifact 数据。移到 `executeBatch` 返回后，cache metrics 和 artifact 事件一起送入。

4. **非 tool 轮次仍调用 onTurnEnd** — 文本回复轮次没有 eviction/access，但 cache hit rate 仍需记录，传空数组即可。

## 改动文件

| 文件 | 改动 |
|------|------|
| `src/agent/tool-pipeline.ts` | +`extractArtifactId()` helper; +`artifactIdsEvicted`/`artifactIdsAccessed` on `ToolPipelineDeps`; 3 处 intercept 后 push evicted ID; read_section 后 push accessed ID |
| `src/agent/tool-execution.ts` | `ToolExecBatchResult` 新增两个字段; `executeBatch` 创建累加器并传入/返回 |
| `src/agent/loop.ts` | 移除旧 TODO; `onTurnEnd` 移到 tool execution 后; 非 tool 轮次单独调用 |

## 验证

- TypeScript 编译通过
- 1264 tests pass（含 agent、cache、tool-pipeline 测试套件）
- GhostRegistry / AdaptiveThreshold / CacheAdvisor 单元测试全部通过
