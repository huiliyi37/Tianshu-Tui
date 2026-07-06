# 2026-07-06 — Frozen 快照孤儿化修复：跨轮 invalidate 不再引爆前缀截断

## 背景

当天出现"修一个 bug、引入一个更规律的 bug"的接力：

- 上午 8396ac51 调查发现 cacheRead 倒退落在用户边界（上一代根因：`frozenUserMerged`
  每工具轮直写导致数组膨胀触发 64 条驱逐 + DeepSeek 工具轮 `reasoning_content`
  缺失/补空的 wire 字节抖动）。
- 16:34 `e0351f44` 修复上一代：改为「任内只写 `frozenPendingMerged`、真实用户边界
  commit 一次」的两段式。**但 commit 守卫写成了依赖 `cachedFreshForUser` 非空。**
- `invalidateFreshCache()` 会清空 `cachedFreshForUser`，且它在**每条新用户消息**处理
  链上必然触发（`turn-step-producer.ts` → `intentRoute.buildForTurn` →
  `setIntentRetrievalRoute` 所有分支都调用）。触发点在 turn N 最后一次 build 之后、
  turn N+1 首次 build 之前 → commit 被跳过 → pending 快照**永久孤儿化**。

## 实证（两个独立会话，同一模式）

| 证据 | Windows 会话（200K 级上下文） | 本地 `1924fe2b`（97K） |
|------|------|------|
| `frozenEvicted` 常亮 | 158/160 请求 | 首个边界后 61/72 请求 |
| `prefix_truncation` | 每用户边界一次，最惨单次重建 18.9 万 token（197K 输入命中 4.4%） | 每边界丢 2.1万/2.3万 token |
| 断点位置 | `prefixDiverged idx=1, approxCharPos 9918`（首条用户消息 volatileBlock 结合部） | 同一位置 9918 |

次生伤害：fallback 重建结果不回存，每请求重算 → 历史消息字节在两种形态间翻转 →
探针每请求报 divergence，每请求多付几 K~十几 K cacheCreate（DeepSeek 侧靠多分支缓存
维持 90%+ 命中，但重建税持续）。

现有测试只覆盖"invalidate 后同一用户消息仍为 last 时再次 build"（该序列会重新登记
`cachedFreshForUser`，掩盖了洞）；生产序列"invalidate 落在两轮之间"无覆盖。

## 改动（`src/prompt/engine.ts`）

1. **边界 commit 改为 pending 驱动清扫**：`buildOaiRequest` 前置 commit 块遍历
   `frozenPendingMerged`，key ≠ 当前 lastUserContent 的条目一律 commit + 清除——
   不再依赖会被 invalidate 清空的 `cachedFreshForUser`。同文本判定
   （`hasPriorInstanceNowHistorical`）改为基于 pending 与消息数组本身。
2. **fallback 回存自愈**：两处 fallback（首条/历史用户消息）重建结果回存
   `frozenUserMerged`——孤儿只翻车一次，后续请求字节稳定，对旧会话残留数据也自愈。
3. **invalidateFreshCache 不 commit**（评审否决了"清空前先 commit"方案）：任内
   invalidate 后边界 rebuild 会产出该消息的最终 wire 字节，提前 commit 会留下陈旧
   中间版快照，破坏"历史检索 = 最后上线字节"不变量。pending 由下次主路径 build 的
   清扫兜底，语义上等价且不产生中间版。

## 测试

`engine-cache-stability.test.ts` 新增 describe「frozen snapshot orphaning across
turn boundaries」：①跨轮 invalidate 生产序列（断言零 fallback + 历史字节等于最后
wire 字节）②重复「继续」夹 invalidate ③fallback 回存幂等（字节稳定、计数只 +1）。
修复前三条全红（1!==0 / 1!==0 / 2!==1），修复后 prompt 套件 374 全绿。

## 教训

- 守卫条件不要依赖会被其他子系统清空的可变状态；commit 的真值来源应是待提交数据
  本身（pending map 自带 key）。
- 缓存修复必须用**生产调用序列**写回归测试——"同轮再 build"与"跨轮首 build"是
  两条不同路径，前者通过不代表后者安全。
