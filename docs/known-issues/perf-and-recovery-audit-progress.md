# 审计进展追踪 · perf-and-recovery-audit-2026-06-05

> 源文档: `docs/known-issues/perf-and-recovery-audit-2026-06-05.md`
> 本文档追踪审计条目的修复状态。最后更新: 2026-06-06

## 总览

| 状态 | 数量 | 占比 |
|------|------|------|
| ✅ FIXED | 16 | 70% |
| 🔍 NO-OP (验证后无需改) | 2 | 9% |
| ⏳ DEFERRED | 5 | 22% |

---

## ✅ FIXED (16)

### 前序会话修复 (11)

| # | 层 | 描述 | Commit |
|---|---|------|--------|
| P0#1 | 中间层 | delegate worker 信号链断裂 + per-loop 进程隔离 | `d7c4fe3` |
| P0#2 | 网络 | abort 被伪装成正常完成 → throw AbortError | `2c59dad` |
| P0#3 | 压缩层 | memory 并发丢条目 → advisory lock + atomic write | `e354cf1` |
| P1#4 | 中间层 | recovery-trigger 盲输入 → 接真实 interrupt 计数 | `5b29778` |
| P1#5 | 网络 | anthropic/codex 缺硬超时 → 10min hard timeout | `24625ee` |
| P1#6 | 压缩层 | 1M 压缩无断路器 → circuit breaker + 退避 | `a2880d6` |
| P1#7 | 网络 | DeepSeek tool-JSON-in-content 无消费者 → fallback parse | `3f9a700` |
| P1#8 | 压缩层 | 会话恢复孤立 tool_call → repairOrphanToolCalls | `edd2935` `63f64f6` |
| P1#9 | 中间层 | stigmergy 每 postTool 全文件 I/O → 内存缓存 + 防抖 | `6f31685` |
| P1#10 | 网络 | 每 turn 全量深拷贝 sanitize → incremental sanitize | `a2880d6` |
| P1#11 | 压缩层 | token 估算系统性偏低 → 固定前缀开销加进基线 | `a2880d6` |

### 本会话修复 (5)

| # | 层 | 描述 | Commit |
|---|---|------|--------|
| P1网#4 | 网络 | onRateLimit 丢 retry-after → 透传 retryDelayMs 到 inter-turn delay | `ef3d55c` |
| P2网#6 | 网络 | Codex 缺 thinking-stall 短超时 → 90s stall detection | `48efed7` |
| P2网#7 | 网络 | classifier 408/425 漏判 retryable → 新增 408/425 分支 | `866a80d` |
| P2压#8 | 压缩层 | snapshot 活引用 → JSON deep copy | `e218fd6` |
| P2中#4 | 中间层 | sensorimotor SHA-256 同步阻塞 → defer to setImmediate | `c3a39f3` |

---

## 🔍 NO-OP — 验证后确认无需改动 (2)

| # | 层 | 描述 | 理由 |
|---|---|------|------|
| P2中#7 | 中间层 | turn-end 每 turn 全量 getEntries | `getEntries()` 返回内部数组引用（非拷贝），3 次调用开销可忽略 |
| P2中#8 | 中间层 | 每 turn git 子进程 → 缓存+降频 | 已是 fire-and-forget（`.then()` 不 `await`），不阻塞主循环 |

---

## ⏳ DEFERRED — 需设计文档或影响面大 (5)

| # | 层 | 描述 | 原因 |
|---|---|------|------|
| P1中#6 | 中间层 | recovery suggestedActions 执行器 + crash breadcrumb | 设计级，需跨 reliability-mode + loop + TUI 多层 |
| P2中#9 | 中间层 | hook pipeline 串行 → 并行 | 需逐 hook 标记 parallelSafe，17 个 hook 影响面大 |
| P2中#10 | 中间层 | snapshot 每 tool 重建 → batch 复用 | 已是 shallow ref copy，开销可接受 |
| P2压#4 | 压缩层 | appendix 循环不注入 → cache-safe 尾部增量 | 架构级改动，需专门设计文档 |
| P2压#5 | 压缩层 | 请求时剪枝每 turn 全量 → 增量 | 架构级改动，需专门设计文档 |

---

## 未在审计范围内的已知问题

- **TUI 真凶①**: 消息重复渲染 — 交接文档 `HANDOFF-2026-06-05-steer-and-render-fixes.md` §三 有方案 A（锁步 ref++）
- **TUI 真凶②**: 流式滚屏 — 同上 §二，方案 A（布局钉底，推荐）vs 方案 B（tail window）
- **A/B/C steer 丢消息**: 已修复 `97aaacb`，测试未跑，需接手验证
