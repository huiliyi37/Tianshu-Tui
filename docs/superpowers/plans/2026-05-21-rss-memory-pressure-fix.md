# RSS 内存压力修复

## 问题

100 万 token context window 下，compaction 触发阈值为 72-86%（720K-860K tokens）。
正常使用 30-40 轮只产生 100-200K tokens，远不到 compaction 阈值。
但 Node.js 进程 RSS 在此时已达 500MB+，触发 reliability mode 拦截。

**根本矛盾**：compaction 是为控制 API payload 大小设计的，不是为控制进程内存。

## 原因分析

| 因素 | 说明 |
|------|------|
| V8 堆不归还 OS | GC 回收对象后 RSS 不下降，V8 保留内存页 |
| Message 对象开销 | 1 token ≈ 4B 文本，但 V8 对象实际占用 3-5x |
| 旧限制太紧 | 512MB 对 20+ 轮 session 不够 |
| stale-round 只截断不删除 | 截断 tool_result 文本但对象仍在堆中 |
| compaction 永远不触发 | 100K/1M = 10%，远低于 72% watch 阈值 |

## 修复

### 1. 提高默认内存限制（resource-sensor.ts）

```
512MB → 1GB
```

环境变量 `RIVET_MEMORY_LIMIT_BYTES` 可覆盖。

### 2. 启用 V8 手动 GC（package.json + tsup.config.ts）

```
node --expose-gc --max-old-space-size=1536
```

- `--expose-gc`：允许代码调用 `globalThis.gc()` 提示 V8 释放
- `--max-old-space-size=1536`：让 V8 GC 更积极（不等到 1.7GB 默认上限）

### 3. RSS 驱动的 microCompact（loop.ts）

当 RSS > 70% 限制且 token-based compaction 未触发时：
- 用虚拟 30% window 调用 `microCompact`
- 强制删除中间旧 rounds 的 Message 对象
- 之后调用 `globalThis.gc()` 释放内存

```typescript
if (!compactResult.compacted && rssRatio >= 0.7 && messages.length >= 10) {
  const virtualWindow = Math.floor(contextWindow * 0.3)
  const { messages: trimmed } = microCompact(before, virtualWindow, estimatedTokens)
  session.replaceMessages(trimmed)
  globalThis.gc?.()
}
```

### 4. Compaction 后主动 GC

每次 compaction 或 stale-round 成功替换消息后，调用 `globalThis.gc()`。

## 效果预期

- 30-40 轮 session 不再触发 reliability mode
- RSS 峰值从 ~600MB 降至 ~400MB（compaction 后可回落）
- 超长 session（100+ 轮）通过 RSS-driven microCompact 自动瘦身
