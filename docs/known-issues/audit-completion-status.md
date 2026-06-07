# 审计项完成状态对照表

**审计文档:** `docs/known-issues/perf-and-recovery-audit-2026-06-05.md`
**审计提交:** `57273c7`
**对照截止:** `13a2664` (当前 HEAD)
**权威进度来源:** `docs/known-issues/perf-and-recovery-audit-progress.md`
**最后刷新:** 2026-06-07（P2 段与进度文档对齐 + 网#4 子缺口闭环）

---

## P0 — recovery 真实缺陷（3 项）

| # | 发现 | 状态 | 证据 |
|---|------|------|------|
| 中#1+#2 | delegate worker 信号链断裂 + 父→worker 信号传播 | ✅ **已修** | `d7c4fe3` fix(agent): worker signal chain + per-loop process isolation |
| 网#3 | abort 被伪装成正常完成 | ✅ **已修** | `anthropic-client.ts:335` + `codex-client.ts:246` 均加了 `if (signal?.aborted) throw AbortError`，且硬超时也已补（网#2 一并修） |
| 压#6 | canonical memory 并发丢条目 | ✅ **已修** | `e354cf1` fix(memory): add advisory lock + atomic write for project memory |

**P0 全部完成。** ✅

---

## P1 — recovery 隐患 / 死机制（5 项）

| # | 发现 | 状态 | 证据 |
|---|------|------|------|
| 中#5 | recovery-trigger 两条腿是死的 | ✅ **已修** | `loop.ts:141,561,677-694,708,725,869` — `_turnInterruptCount` + `detectPendingTools()` + `computeSessionIntegrity()` 替换硬编码值 |
| 网#2 | anthropic/codex 缺硬超时 | ✅ **已修** | `24625ee` + `anthropic-client.ts:336` / `codex-client.ts:248` 均有 10min hard timeout |
| 压#2 | 1M 窗口压缩无断路器 | ✅ **审计前已修** | `a2880d6` fix(compaction,perf): circuit breaker + token baseline — `recordCompactFailure`/`recordCompactSuccess` 已在 `compaction-controller.ts:287,292,380`。**审计遗漏此提交。** |
| 网#1 | DeepSeek tool-JSON-in-content 无消费者 | ✅ **已修** | `openai-client.ts:79,245,448-451,529,604` — `_textAccum` 累积 + `tryParseToolJsonFromContent()` 在 finish_reason 时兜底解析 |
| 压#7 | 会话恢复孤立 tool_call | ✅ **已修** | `session-persist.ts:200,204` — `repairOrphanToolCalls()` 配对校验，commit `edd2935` |

---

## P1 — perf 热路径（3 项）

| # | 发现 | 状态 | 证据 |
|---|------|------|------|
| 网#5 | 每 turn 全量深拷贝+NFC 扫描请求体 | ✅ **审计前已修** | `a2880d6` incremental sanitize — `_sanitizedCount` 跟踪已 sanitize 位置，只处理新增消息。**审计遗漏此提交。** |
| 压#1+#3 | token 估算系统性偏低 + 丢 reasoning | ✅ **审计前已修** | `a2880d6` — `prefixOverhead` 加入 system prompt + tools + volatile 基线（`context.ts` + `compaction-controller.ts:225`）；`micro.ts:27-28` 已累加 `reasoning_content`。**审计遗漏此提交。** |

---

## P2 — perf 可缓存重算 / 低风险（11 项）

> **状态来源对齐 `perf-and-recovery-audit-progress.md`（权威进度文档）。**
> 本表此前误列全部 ❌ 未修，已于 2026-06-07 校正：部分项已修，部分经验证判
> NO-OP（无需改），部分 DEFERRED（需设计 / 影响面大）。

| # | 发现 | 状态 | 证据 / 理由 |
|---|------|------|------|
| 中#4 | sensorimotor SHA-256 同步阻塞 | ✅ **已修** | `c3a39f3` — defer to setImmediate |
| 中#7 | turn-end 每 turn 全量 | 🔍 **NO-OP** | `getEntries()` 返回内部数组引用（`trajectory.ts:29-31`，非拷贝），3 次调用开销可忽略 |
| 中#8 | 每 turn git 子进程 | 🔍 **NO-OP** | 已是 fire-and-forget（`.then()` 不 `await`），不阻塞主循环 |
| 中#9 | hook pipeline 串行 | ⏳ **DEFERRED** | 需逐 hook 标记 `parallelSafe`，17 个 hook 影响面大，须先出设计 |
| 中#10 | snapshot 每次重建 | ⏳ **DEFERRED** | 已是 shallow ref copy（`recentToolHistory.map()` 有界量小），开销可接受 |
| 网#4 | onRateLimit 丢 retry-after | ✅ **已修** | 消费侧 `ef3d55c`（retryDelayMs→inter-turn delay）+ 发射侧 `2026-06-07`（anthropic/codex 补 `onRetry→onRateLimit`，原仅 openai-client 发射） |
| 网#6 | Codex 缺 thinking-stall 短超时 | ✅ **已修** | `48efed7` — 90s stall detection（`codex-client.ts` THINKING_STALL_TIMEOUT_MS） |
| 网#7 | classifier 408/425 漏判 retryable | ✅ **已修** | `866a80d` — `error-classifier.ts:98`(408) / `:110`(425) 新增分支 |
| 压#4 | appendix 循环不注入 | ⏳ **DEFERRED** | cache-safe 尾部增量，架构级改动，需专门设计文档 |
| 压#5 | 请求时剪枝每 turn 全量 | ⏳ **DEFERRED** | 架构级改动，需专门设计文档 |
| 压#8 | snapshot 活引用 | ✅ **已修** | `e218fd6` — `session-state.ts:74` JSON deep copy |

---

## 汇总
| 优先级 | 总数 | 已修 | NO-OP | DEFERRED | 完成率* |
|--------|------|------|-------|----------|--------|
| P0 | 3 | 3 | 0 | 0 | **100%** |
| P1 (recovery) | 5 | 5 | 0 | 0 | **100%** |
| P1 (perf) | 2 | 2 | 0 | 0 | **100%** |
| P2 | 11 | 5 | 2 | 4 | **64%** |
| **合计** | **21** | **15** | **2** | **4** | **81%** |

> *完成率 = (已修 + NO-OP) / 总数。NO-OP 项经验证确认无需改动，计入已处置。
> **P0 + P1 全部完成。** P2 剩余 4 项 DEFERRED 均为低风险性能优化，无 recovery 影响：
> 中#9（hook 并行）需逐 hook 标 parallelSafe 设计；中#10 已是 shallow ref copy 开销可接受；
> 压#4 / 压#5 为架构级改动，需专门设计文档。

> **2026-06-07 校正记录:** 本表 P2 段此前与 `perf-and-recovery-audit-progress.md` 冲突
> （误列全部未修）。已对齐权威进度文档。其中 **网#4 发现一处子缺口**——`ef3d55c` 只修了
> 消费侧（loop.ts retryDelayMs→inter-turn delay），但 `onRateLimit` 回调原本仅 openai-client
> 发射，anthropic-client / codex-client 提取了 retry-after 却未触发回调；已于 2026-06-07
> 补 `onRetry→onRateLimit`（对齐 openai-client，category==='rate_limit' 时回传 retryDelayMs），
> `tsc --noEmit` 通过，三个活 provider 的 rate-limit 状态信号现已一致。

## 审计后额外修复（不在审计列表中）

| 提交 | 内容 |
|------|------|
| `bbdc8aa` | edit_file OOM guard + write_file staleness warn + path-validate symlink |
| `75b3677` | edit stale-recovery mtime refresh |
| `c53f50b` | read_file binary rejection |
| `9718ce3` + `b31ba91` + `6495ccd` | session-registry safeRun/safeGet + FK cascade + ESM fix |
| `e435a43` | edit/hash-edit 测试 tmpdir 路径修复 |
| `1d652d0` | `--test-force-exit` 解测试孤儿进程 |
| `d6824f1` | read-section size guard |
| `fe14ad0` | setInterval .unref() + checkpoint race 分析 |
