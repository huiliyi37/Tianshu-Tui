# 审计项完成状态对照表

**审计文档:** `docs/known-issues/perf-and-recovery-audit-2026-06-05.md`
**审计提交:** `57273c7`
**对照截止:** `fe14ad0` (当前 HEAD)
**审计后提交数:** ~50

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
| 中#5 | recovery-trigger 两条腿是死的 | ❌ 未修 | `loop.ts:657-682` 硬编码 `orphanToolUseCount:0`, `totalInterruptsThisSession:0` 未改 |
| 网#2 | anthropic/codex 缺硬超时 | ✅ **已修** | `24625ee` + `anthropic-client.ts:336` / `codex-client.ts:248` 均有 10min hard timeout |
| 压#2 | 1M 窗口压缩无断路器 | ✅ **审计前已修** | `a2880d6` fix(compaction,perf): circuit breaker + token baseline — `recordCompactFailure`/`recordCompactSuccess` 已在 `compaction-controller.ts:287,292,380`。**审计遗漏此提交。** |
| 网#1 | DeepSeek tool-JSON-in-content 无消费者 | ❌ 未修 | `provider.ts:52` flag 存在但无兜底解析 |
| 压#7 | 会话恢复孤立 tool_call | ❌ 未修 | `session-persist.ts:185-256` 无配对校验 |

---

## P1 — perf 热路径（3 项）

| # | 发现 | 状态 | 证据 |
| 网#5 | 每 turn 全量深拷贝+NFC 扫描请求体 | ✅ **审计前已修** | `a2880d6` incremental sanitize — `_sanitizedCount` 跟踪已 sanitize 位置，只处理新增消息。**审计遗漏此提交。** |
| 压#1+#3 | token 估算系统性偏低 + 丢 reasoning | ✅ **审计前已修** | `a2880d6` — `prefixOverhead` 加入 system prompt + tools + volatile 基线（`context.ts` + `compaction-controller.ts:225`）；`micro.ts:27-28` 已累加 `reasoning_content`。**审计遗漏此提交。** |
| 压#1+#3 | token 估算系统性偏低 + 丢 reasoning | ❌ 未修 | `agent/context.ts` + `micro.ts:25-33` 未改 |

---

## P2 — perf 可缓存重算 / 低风险（8 项）

| # | 发现 | 状态 | 证据 |
|---|------|------|------|
| 中#4 | sensorimotor SHA-256 同步阻塞 | ❌ 未修 | |
| 中#7 | turn-end 每 turn 全量 | ❌ 未修 | |
| 中#8 | 每 turn git 子进程 | ❌ 未修 | |
| 中#9 | hook pipeline 串行 | ❌ 未修 | |
| 中#10 | snapshot 每次重建 | ❌ 未修 | |
| 网#4 | onRateLimit 丢 retry-after | ❌ 未修 | |
| 网#6 | Codex 缺 thinking-stall 短超时 | ❌ 未修 | |
| 网#7 | classifier 408/425 漏判 retryable | ❌ 未修 | |
| 压#4 | appendix 循环不注入 | ❌ 未修 | |
| 压#5 | 请求时剪枝每 turn 全量 | ❌ 未修 | |
| 压#8 | snapshot 活引用 | ❌ 未修 | |

---

## 汇总
| 优先级 | 总数 | 已修 | 未修 | 完成率 |
|--------|------|------|------|--------|
| P0 | 3 | 3 | 0 | **100%** |
| P1 (recovery) | 5 | 3 | 2 | **60%** |
| P1 (perf) | 3 | 3 | 0 | **100%** |
| P2 | 11 | 0 | 11 | 0% |
| **合计** | **22** | **9** | **13** | **41%** |

> **注:** 压#1/#2/#3 和网#5 在审计提交 `57273c7` 之前已由 `a2880d6` 修复，审计时遗漏。P1 perf 全部完成。P1 recovery 剩余中#5（recovery-trigger 盲输入）、网#1（DeepSeek tool-JSON）、压#7（孤立 tool_call）。
| **合计** | **22** | **6** | **16** | **27%** |

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
