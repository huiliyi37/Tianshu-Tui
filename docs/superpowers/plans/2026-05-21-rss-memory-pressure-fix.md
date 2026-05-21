# RSS 内存压力修复

## 问题

100 万 token context window 下，compaction 触发阈值为 72-86%（720K-860K tokens）。
正常使用 30-40 轮只产生 100-200K tokens，远不到 compaction 阈值。
但 Node.js 进程 RSS 在此时已达 500MB+，触发 reliability mode 拦截（degraded/minimal）。

**根本矛盾**：
1. compaction 是为控制 API payload 大小设计的，不是为控制进程内存
2. RSS ≠ 实际内存压力。V8 GC 后保留已分配页，RSS 虚高但 heapUsed 正常

## 原因分析

| 因素 | 说明 |
|------|------|
| RSS ≠ heapUsed | V8 GC 回收对象后 RSS 不下降，但 heapUsed 会降 |
| 旧代码用 RSS 判断压力 | RSS 500MB 就触发 degraded，实际 heap 可能只有 200MB |
| 旧限制太紧 | 512MB 对 20+ 轮 session 不够 |
| compaction 永远不触发 | 100K/1M = 10%，远低于 72% watch 阈值 |

## 修复

### 1. 核心修复：用 heapUsed 替代 RSS 判断内存压力（recovery-trigger.ts）

**这是最关键的修复。** RSS 在 Node.js 中是虚高的（V8 保留已释放页），不代表真实压力。

```
旧逻辑：rssBytes / memoryLimitBytes >= 0.7 → degraded, >= 0.85 → minimal
新逻辑：heapUsedBytes / memoryLimitBytes >= 0.75 → degraded, >= 0.9 → minimal
```

heapUsed 才是真正的活对象内存。一个 RSS 600MB 的进程，heapUsed 可能只有 250MB。

### 2. 提高默认内存限制（resource-sensor.ts）

```
512MB → 1GB
```

环境变量 `RIVET_MEMORY_LIMIT_BYTES` 可覆盖。

### 3. 启用 V8 手动 GC（package.json + tsup.config.ts）

```
node --expose-gc --max-old-space-size=1536
```

- `--expose-gc`：允许代码调用 `globalThis.gc()` 提示 V8 释放
- `--max-old-space-size=1536`：让 V8 GC 更积极（不等到 1.7GB 默认上限）

### 4. Heap 驱动的 microCompact（loop.ts）

当 heapUsed > 60% 限制且 token-based compaction 未触发时：
- 用虚拟 30% window 调用 `microCompact`
- 强制删除中间旧 rounds 的 Message 对象
- 之后调用 `globalThis.gc()` 释放内存

### 5. Compaction 后主动 GC

每次 compaction 或 stale-round 成功替换消息后，调用 `globalThis.gc()`。

## 效果预期

- 正常 session（RSS 高但 heapUsed 正常）不再误触发 degraded mode
- 只有真正的内存压力（heapUsed 接近上限）才会降级
- 超长 session 通过 heap-driven microCompact 自动瘦身
