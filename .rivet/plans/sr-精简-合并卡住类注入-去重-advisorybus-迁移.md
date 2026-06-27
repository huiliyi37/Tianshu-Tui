> **Status: COMPLETED** — 2026-06-19

> **Status: APPROVED** — 2026-06-18T06:02:52.163Z

# SR 精简：合并卡住类注入 + 去重 + advisoryBus 迁移

## 问题

模型卡住时，3 个注入源同时触发，产生方向矛盾或内容重复的 SR 注入：

1. **convergence kick** (`loop.ts:1017`) — 天璇-感知 + 信号诊断。价值最高。
2. **doom loop gate hint** (`loop.ts:1030`) — "该结束了"。与 #1 方向矛盾（#1 说换方向继续，#2 说停）。
3. **kick-hook** (`hooks/kick-hook.ts:44`) — dissipative kick + 替代框架。与 #1 完全重叠，无信号诊断。

signal-consumer-hook 已有 kick 互斥（`if shouldKick(sensorium) return`），但 convergence kick 没有对 kick-hook 做互斥。

## 方案

### Task 1: 互斥门控 — convergence 触发时抑制 kick-hook

**文件**: `src/agent/hooks/kick-hook.ts`

当前 kick-hook 通过 `shouldKick(sensorium)` 判断是否触发。convergence kick 在 `loop.ts` 中通过 `evaluateConvergence` 判断，条件不同但场景重叠。

**改动**: 在 kick-hook 的 deps 中新增 `wasConvergenceTriggered: () => boolean`。kick-hook 在 `shouldKick(sensorium)` 通过后，检查 convergence 是否已在本轮触发——如果是，跳过注入（仍保留 dead-end deposit 等副作用）。

```typescript
// kick-hook.ts run() 内部
if (!sensorium || !shouldKick(sensorium)) return
if (currentTurn - lastKickTurn < cooldown) return
// 新增：convergence 互斥
if (deps.wasConvergenceTriggered?.()) return
```

**loop-factory.ts**: 提供 `wasConvergenceTriggered` 实现：
```typescript
wasConvergenceTriggered: () => self.latestConvergenceResult?.shouldKick ?? false
```

### Task 2: 合并 convergence kick + gate hint

**文件**: `src/agent/loop.ts` (L1003-L1032)

当前逻辑：convergence kick 注入一条消息（L1017），然后 doom loop blocked 时再注入 gate hint（L1030）。两条消息方向矛盾。

**改动**: 合并为单条注入。当 `shouldKick && level >= 2` 时：
- 先检查 doom loop blocked 条件，构建 gate hint 文本
- 将 gate hint 追加到 convergence injectedMessage 末尾
- 只调用一次 `appendSystemReminder`

```typescript
if (convergenceCheck.shouldKick && convergenceCheck.injectedMessage) {
  // ... existing callbacks ...
  
  let fullMessage = convergenceCheck.injectedMessage
  
  // 合并 gate hint（如果有）
  if (this.getDoomLoopLevel() === 'blocked' && convergenceCheck.level >= 2) {
    let gateHint = '任务验证循环已检测到。如果交付门禁为 GREEN，请输出最终摘要并结束回合。不再调用工具。'
    try {
      const gate = this.config.deliveryGateV2?.([...this.evidence.getState().filesModified])
      if (gate) gateHint = `任务验证循环已检测到。${buildGateConvergenceHint(gate, this._taskDepthLayer)}`
    } catch { /* gate evaluation must never break convergence handling */ }
    fullMessage += '\n\n---\n' + gateHint
  }
  
  this.session.appendSystemReminder(fullMessage)
}
```

移除原来单独的 gate hint `appendSystemReminder` 调用（L1030）。

### Task 3: dedup-guard 无条件走 advisoryBus

**文件**: `src/agent/hooks/dedup-guard-hook.ts` (L88)

当前 dedup-guard 在没有 advisoryBus 时回退到 `injectUserMessage`。重复检测的价值不足以抵消 SR 注入的噪音。

**改动**: 移除 `injectUserMessage` 回退路径。没有 advisoryBus 时静默跳过。

```typescript
// 改前
if (deps.advisoryBus) {
  deps.advisoryBus.submit({ ... })
  return
}
ctx.effects.injectUserMessage(...)

// 改后
if (!deps.advisoryBus) return  // 静默跳过，不注入 SR
deps.advisoryBus.submit({ ... })
```

## 验证

1. `npx tsc --noEmit`
2. `node --import tsx --test src/agent/__tests__/convergence-detector.test.ts`
3. `node --import tsx --test src/agent/__tests__/dissipative-kick.test.ts`
4. `node --import tsx --test src/agent/hooks/__tests__/` (如有)

## 认知影响

- Task 1: 模型卡住时少收一条重复的 kick 注入。convergence kick 仍然注入，信号诊断不丢失。
- Task 2: 模型卡住时收到一条合并消息而非两条矛盾消息。方向更清晰。
- Task 3: 当 advisoryBus 不可用时，模型不再收到重复输出检测提示。可接受——convergence 的 textRepetitionPenalty 已覆盖此场景。
