# 【T1 收束】回合边界 abort / 看门狗 / 恢复链

> **阶段标记：T1 收束** — 系统架构收束工作（团队级）。
> 基于代码级追踪（每条附 file:line 取证，非推测）。创建：2026-06-06。
> 所属子系统：AgentLoop 回合边界编排 / stall 恢复（分支 `fix/stall-root-causes-abort-exit` 主题）
> 关联记忆：[[rivet-turn-boundary-stall-blind-spot]]、[[rivet-process-and-todo-leak-symptoms]]

---

## 0. 结论先行（与前两条链路不同）

**这条链路大体是健全的。** 不同于 sub-agent 隔离和 server 锁（裂缝密集），
回合边界 abort 链已被当前分支系统性修复，设计扎实。本文 80% 篇幅是**确认它对**，
只有一个残留的微妙竞态值得收口。

T1 收束不只找裂缝——**验证"看似完成"的代码确实完成，本身就是收束**。这条就是正面案例。

---

## 1. 已验证为健全的设计（不要误改）

### a) 看门狗有牙（`turn-heartbeat.ts`）
`TurnHeartbeat` 双职责：silentMs(20s) 发"still working"心跳防误判卡死；
**hardStallMs(240s) → `onHardStall` → `abortStalledTurn()`**（loop.ts:887-893）——
回合边界楔住时主动 abort 打破僵局。这是"有牙的看门狗"。

### b) 全 boundary 阶段都包了 rejectOnAbort（`turn-boundary-abort.ts`）
`rejectOnAbort(work, signal, stage)` 用 abort 信号与进行中 work 竞速，信号触发即 reject。
loop.ts 已覆盖**全部**回合边界 await：
- `compaction`(1481) ← 含内层 maybeCompact 的 LLM compact
- `prewarm`(1497)、`perception`(1509)、`convergence`(1521)、`turnRequest`(1531)、(1744)

> 我曾怀疑内层 `maybeCompact`(loop.ts:1360) 未被包裹——**证伪**：它在 `runCompaction` 内，
> 而 `runCompaction` 整体被外层 rejectOnAbort 包住。内层 1355/1367 的 abort 检查是子步骤间的提前 bail 优化。

### c) abort 与看门狗 fire 同一信号
`abort()`(loop.ts:562) 和 `abortStalledTurn()`(578) 都调 `this.abortController?.abort()`——
**同一 signal**，所以看门狗的 abort 确实触发 (b) 的所有竞速。
区别仅：`abortStalledTurn` 不增 `_turnInterruptCount`（避免被 recovery-trigger 误判为用户中断）。

### d) 记忆 note 已过时（需更正）
[[rivet-turn-boundary-stall-blind-spot]] 记的"Ctrl+C 救不回来"**已被本次修复闭合**：
Ctrl+C → `agent.abort()` → 同一 signal → rejectOnAbort 立即 reject，**无需等 240s**。
240s 看门狗只兜底"用户不按 Ctrl+C"的场景。该记忆应标注为已修复。

---

## 2. 唯一残留接缝：晚到的 LLM compact mutate 已遗弃回合的 session

🟡 **P1 — void-resolution 竞态**

**取证**：`compaction-controller.ts:458-460`

```ts
const summary = await this.llmCompact(undefined, this.deps.getAbortSignal?.())
if (summary) {
  this.replaceWithCheckpoint({ ... })   // ← mutate session，await 与此之间无 abort 再检查
}
```

**机理**：
1. signal 被传进 `llmCompact` 用于取消 fetch（行 199 注释确认）——这覆盖"fetch 进行中被取消"。
2. 但若 fetch **已 resolve**、abort 在 `await` 落定与 `replaceWithCheckpoint` 之间的 microtask 窗口触发：
   - loop 层 `rejectOnAbort`(1481) 已 reject → 进入 `onAbort`/下一回合；
   - 被**遗弃**的 `trySessionSplit` promise 续体仍执行 `replaceWithCheckpoint` → **session 被晚到的 compaction mutate**。
3. controller **无 generation guard**（TUI 有，`app.tsx:258` generation counter；controller 没有对应物）。

**后果**：晚到的 compaction 可能落在已被遗弃回合 / 已开始的下一回合的 session 上 →
消息历史错乱 → **prefix cache 污染**（本愿受损）+ 可能丢回合。

**触发条件**：abort 须落在窄 microtask 窗口 **且** llmCompact 是 resolve（非被取消）。
窗口窄但**非纯理论**：看门狗恰恰在 llmCompact 慢/楔住时 fire abort，
"楔住→最终 resolve" 正是该场景。

**修法（任选其一，都很便宜）**：
- **A（最小）**：`await` 之后、`replaceWithCheckpoint` 之前，重查 `this.deps.getAbortSignal?.()?.aborted` → true 则放弃 mutate。
- **B（更稳）**：进入 compact 时捕获 turn-generation token，mutate 前比对；不匹配则丢弃。
  与 TUI 的 generation counter 模式对齐，子系统内统一。

---

## 3. 收口建议

```
1. [修] 接缝 2 — 加 post-await abort 重查（方案 A，1 行 if）或 generation guard（方案 B）
2. [文档] 更正记忆 [[rivet-turn-boundary-stall-blind-spot]] → 标注 Ctrl+C 路径已闭合
3. [补测试] compaction-controller 的 abort-during-llm-compact 路径（当前 controller 有测试，
   但"await 落定后 abort"这条竞态路径需专门覆盖——正是 T1 纲领的"真验证"）
```

**与 T1 纲领的关系**：见 [[t1-convergence-unverified-new-code]]。这条链路证明纲领的另一面——
不是所有新代码都缺验证，但**未被测试覆盖的并发窗口**（await 落定后 abort）即使在健全设计里也会潜伏。
收束 = 确认健全部分 + 收口残留窗口 + 补那条没被测的竞态路径。