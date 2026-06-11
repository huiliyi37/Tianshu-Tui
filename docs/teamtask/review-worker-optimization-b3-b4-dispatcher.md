# 审查报告：子代理工作流优化 (6a22148 / b88075a / 05f4d2f)

> 审查范围：`6a22148` feat(agent): wire auto-delegation dispatcher, relax explore worker budgets, artifact tiering, worker persistence, escalation visibility
> `b88075a` feat(agent): B4 explore worker independent concurrency pool (5 explore / 3 write)
> `05f4d2f` test(agent): B3 integration test for worker T4/T7/T10 context optimization pipeline
> 计划：`天枢子代理工作流优化_6035537b.plan`

---

## 总体评估：🟡 有条件通过

三个 commit 整体结构合理，与计划对齐度高，但存在 **1 个 P1 bug + 2 个 P2 风险 + 1 个测试质量缺陷**，需要在后续迭代中修复。

---

## P1：artifactStore.save() 竞态 — packet 引用了可能未完成的 artifact

**文件**: `src/agent/worker-prompts.ts:333-361`

```typescript
artifactStore.save({...}).then(id => {
  // Fire-and-forget: the artifact ID is embedded in the packet below
}).catch(() => {})

// ← 这行在 save 完成之前就执行了
return `<worker_results>${json}\n[artifact:${artifactId}] — ...`
```

**问题**: `artifactStore.save()` 是异步的，但 `buildPrimaryWorkerPacket` 是同步函数，返回的 packet 立刻被写入主对话上下文。如果 save 失败（磁盘满、权限），主代理看到 `[artifact:worker-packet-xxx]` 引用但 read_section 会找不到——**丢失整个 worker 结果**。

**严重性**: P1 — 数据丢失风险。大结果场景（>32K）走 artifact 路径时，如果 save 失败，主代理拿到的 packet 只有被 truncate 的 JSON + 一个指向虚空的 artifact 引用。

**修复建议**: 要么 (a) 把 `buildPrimaryWorkerPacket` 改 async 并 await save，要么 (b) 在 catch 里 fallback 到完整的 progressive field drop（当前 catch 是空的 `() => {}`，没有 fallback）。

---

## P2-1：dispatcher-hook 的 coordinator 指针可能过期

**文件**: `src/agent/hooks/dispatcher-hook.ts` + `src/agent/loop.ts:393-399`

```typescript
// loop.ts 中 wiring
autoDelegate: this.config.coordinatorRef ? {
  coordinator: this.config.coordinatorRef(),  // ← 调用一次，取值固化
  getTaskContract: () => this.getTaskContract(),
  getSensorium: () => this.sensorium,
} : undefined,
```

`coordinatorRef()` 在 hook 创建时被调用一次。如果 coordinator 在 session 生命周期中被重建（热重载、config 变更），hook 持有的是旧引用。`getTaskContract` 和 `getSensorium` 正确使用了 getter，但 `coordinator` 没有走 getter。

**影响**: 当前 main.tsx 中 `_coordinatorRef` 是 module 级变量，生命周期与 session 一致，所以实际不会触发。但如果未来 coordinator 被重建，这里会静默地用空引用。

**修复建议**: 改为 `coordinator: () => this.config.coordinatorRef?.() ?? null`，与 getTaskContract 保持一致。

---

## P2-2：work-queue per-role 并发计数不考虑 global maxConcurrency

**文件**: `src/agent/work-queue.ts:59-72`

```typescript
const index = this.entries.findIndex(e => {
  const role = classifyProfile(e.order.profile)
  if (role === 'hands') {
    if (writeInFlight >= this.maxWriteConcurrency) return false
  } else {
    if (exploreInFlight >= this.maxExploreConcurrency) return false
  }
  return true
})
```

当 `maxExploreConcurrency=5, maxWriteConcurrency=3` 时，理论上可以同时跑 8 个 worker（5 explore + 3 write），但 `maxConcurrency`（constructor 参数）仍然是旧的全局限制。`dequeue()` 没有检查全局上限。

**实际影响**: main.tsx 传入 `maxWorkers: 3` 但同时设了 `maxExploreWorkers: 5, maxWriteWorkers: 3`。WorkOrderQueue 的 constructor 签名是 `constructor(maxConcurrency = Infinity, roleConcurrency?)` — 看 main.tsx 的调用方式，`maxConcurrency` 被忽略因为默认 Infinity。但如果将来有人传了 `maxConcurrency=3`，per-role 逻辑会绕过它。

**修复建议**: 在 dequeue 的 findIndex 中加一个全局检查 `inFlightKeys.size >= this.maxConcurrency`。

---

## 测试质量评估 (05f4d2f)

### 测试清单

| # | 测试名 | 验证了什么 | 质量评价 |
|---|--------|-----------|---------|
| 1 | `worker AgentLoop receives contextWindow: 1_000_000` | runWorkerSession 不 crash | 🟡 弱 — 只验证 status 是 passed/blocked，不验证 T4/T7/T10 是否实际触发 |
| 2 | `worker AgentLoop config flows contextWindow` | AgentLoop 构造不 crash | 🔴 无断言 — `assert.ok(agent instanceof AgentLoop)` 是构造验证，没有检查 contextWindow 是否真的传入 tool execution |
| 3 | `verify T10 tiering thresholds` | determineTier 边界值 | 🟢 好 — 直接测纯函数 |
| 4 | `verify T4 tool accumulator collapses` | ToolAccumulator 4 次聚合 | 🟢 好 — 直接测纯逻辑 |
| 5 | `worker agent loop propagates maxTurns` | maxTurns=12 传入后 worker 完成 | 🟡 弱 — 不验证用了多少 turns，只验证完成 |
| 6 | `verify T7 collapse activates for 1M+` | PromptEngine.buildOaiRequest 不 crash | 🔴 无断言 — 只验证 `request.messages.length > 0`，完全不验证 collapse 是否发生。1 条消息的 session 根本不会触发 collapse |

### 核心缺陷

**B3 的目标是「验证 T4/T7/T10 在 worker AgentLoop 生效」**，但 6 个测试中没有一个是真正的集成测试：

- 测试 1 和 5 用 mock client 返回固定 response，worker 只跑 1-2 turn 就结束，**没有 grep storm 来触发 T4**
- 测试 6 用 1 条消息的 session 调 buildOaiRequest，永远不会触发 T7 collapse（需要上下文接近窗口大小才触发）
- 测试 2 只构造了 AgentLoop，完全没有执行任何 turn

**「B3 integration test」名不副实——它是单元测试集合，不是集成测试。** 真正的集成测试应该：构造一个大 session（接近 1M token）→ 跑 grep storm → 验证 ToolAccumulator 的 tryCollapse 被调用且 tool result 被 tiering。

---

## 其他观察

### 正面
- **A2 只读约束**实现干净：`inferWorkOrderKind` 统一返回 `code_search`，注释清晰
- **A3 去重+冷却**设计合理：per-contract.id 的 Set + lastDispatchTurn 计数，简洁有效
- **B4 并发池**实现正确：WorkOrderQueue 的 per-role classifyProfile 分流逻辑清晰
- **D1 持久化**是纯增量，try-catch 保护不阻塞主流程
- **提示词更新**（static.ts）简洁实用，没过度膨胀

### 次要问题
- `delegate-task.ts:31` 的 `run.escalated` 检查 — `CoordinatorRun` 类型需要有 `escalated` 字段，需确认类型定义是否已更新（未在 diff 中看到类型变更）
- `coordinator.ts` 中 `persistWorkerResult` 在两个路径都调用了（delegateTask 和 delegateBatch），如果同一 result 被两个路径都处理会有 double write（但不会 double impact，因为是幂等的 JSON 覆写）
- `main.tsx:1034` 的 `maxExploreWorkers: 5` 缩进不一致（4 空格 vs 周围 6 空格）

---

## 与计划的对齐度

| 计划项 | 状态 | 备注 |
|--------|------|------|
| A1 注册 dispatcher-hook | ✅ 完成 | create-runtime-hooks.ts + loop.ts wiring |
| A2 强制只读探索 | ✅ 完成 | dispatcher-hook.ts 统一 code_search |
| A3 去重+冷却+kill-switch | ✅ 完成 | per-contract Set + cooldownTurns + enabled flag |
| B1 确认 worker 路由 1M | ✅ 完成 | main.tsx maxTurns 放宽 + contextWindow 保持 |
| B2 放宽 explore budget | ✅ 完成 | isWrite ? 8 : 12 |
| B3 验证 T4/T7/T10 生效 | 🟡 部分 | 测试存在但质量不足（见上） |
| B4 explore 独立并发池 | ✅ 完成 | WorkOrderQueue per-role concurrency |
| C1 大结果 artifact tiering | ⚠️ 完成 | 有 P1 竞态 bug |
| C2 强化 delegation 提示词 | ✅ 完成 | static.ts 更新 |
| D1 worker 结果落盘 | ✅ 完成 | persistWorkerResult |
| D2 escalation 可见性 | ✅ 完成 | formatUiContent + escalated flag |
