# Theta Phase Machine — 架构设计

> 日期：2026-06-04
> 实现：`89a5516`
> 来源：联动 #6 Theta 相位机（跨系统联动创意文档 §6）
> 状态：相位振荡器已实现，联动 vigor/complexity 调制已实现

---

## 1. 问题

ThetaState 之前是简单计数器：每 N 次工具调用触发一次跨文件一致性检查。没有相位概念，没有认知模式切换，无法区分"编码中"和"反思中"。

## 2. 设计：相位振荡器

### 2.1 Phase 模型

```
Phase ∈ [0, 1):
  [0, 0.5) → ENCODING（接收信息，执行工具，编码新知识）
  [0.5, 1) → RETRIEVAL（反思整合，跨文件一致性检查）
```

类比神经科学的 theta-gamma 耦合：theta 振荡调制 gamma 节律（工具调用）的认知模式。在 encoding 阶段不中断 agent 的操作流，只在 retrieval 阶段才触发 theta check。

### 2.2 状态结构

```typescript
interface ThetaState {
  toolCallCount: number   // 累计工具调用次数
  lastThetaAt: number     // 上次 theta check 时的 toolCallCount
  interval: number        // 触发间隔（默认 7 次工具调用）
  phase: number           // 当前相位 [0, 1)
  cycleCount: number      // 已完成的完整相位周期数
}
```

### 2.3 调制机制

Phase 推进步长由两个因素联合调制：

```
step = baseStep × vigorMod × complexityMod

其中：
  baseStep = 1 / interval  (= 1/7 ≈ 0.143)
  vigorMod = 1 - vigor × 0.4    // [0.6, 1.0] — 高 vigor = 慢推进
  complexityMod = 0.5 + complexity × 0.5  // [0.5, 1.0] — 高 complexity = 快推进
```

**设计意图**：
- 高 vigor（活跃操作中）→ 慢推进 → agent 在 encoding 停留更久 → 保护心流
- 高 complexity（复杂任务）→ 快推进 → 更频繁进入 retrieval → 更多一致性检查

### 2.4 双重门控

Theta check 触发需同时满足：
1. **Interval 门控**：`toolCallCount - lastThetaAt >= interval`
2. **Phase 门控**：`phase >= 0.5`（必须在 retrieval 阶段）

```typescript
tickTheta(state, currentTurn): boolean {
  next = toolCallCount + 1
  due = next - lastThetaAt >= interval
  if (!due) return false
  return state.phase >= 0.5  // phase gate
}
```

### 2.5 周期完成

Theta check 完成后，phase 重置为 0（回到 encoding 起点），cycleCount +1：

```typescript
completeTheta(state): ThetaState {
  return { ...state, lastThetaAt: toolCallCount, phase: 0, cycleCount: cycleCount + 1 }
}
```

---

## 3. 调用链

```
tool-pipeline.ts (每次工具调用后)
  → theta-hook.ts: createThetaRuntimeHook()
    → advanceThetaCounter(state, { vigor, complexity })  // 推进相位
    → if complexity > 0.5:
        → tickTheta(advanced, turn)                      // 检查间隔
        → if tickTheta returns true:
            → getThetaPhase(advanced) → 确认 retrieval
            → requestThetaCheck("theta-cycle:retrieval")
            → completeTheta(advanced)                    // 重置周期
```

**条件激活**：`sensorium.complexity > 0.5` 时才参与 theta 检查。低复杂度任务不触发，避免噪声。

---

## 4. Sensorium 依赖

Theta hook 读取 `ctx.snapshot.sensorium`（复杂度）和 `ctx.snapshot.vigor`（能量）：

| 字段 | 来源 | 用途 |
|------|------|------|
| `sensorium.complexity` | Sensorium 状态机 | 决定是否激活 + phase 推进速度 |
| `vigor.vigor` | Vigor 能量状态机 | 调制 phase 推进速度 |

如果 sensorium 不可用（null），hook 退化为简单线性推进（无调制）。

---

## 5. 测试覆盖

已有 32 个测试（`src/agent/__tests__/star-event.test.ts` + `theta-hook.test.ts`），覆盖：

- phase 线性推进
- phase 环绕 + cycleCount 递增
- 高 vigor 慢推进
- 高 complexity 快推进
- interval 门控（间隔未满不触发）
- phase 门控（encoding 阶段不触发）
- 双重门控同时满足时触发
- completeTheta 重置
- full cycle: advance → tick → complete → advance again
- sensorium 不可用时的降级

测试覆盖充分，无需补充。

---

## 6. Prefix Cache 影响

**无影响**。ThetaState 是运行时内存状态，不注入 prompt。`requestThetaCheck` 的效果是触发额外的工具调用（如 read_file 读取相关文件），但这是通过 effect queue 实现的，不改变 prompt 结构。

---

## 7. 后续方向

| 方向 | 描述 | 优先级 |
|------|------|--------|
| Adaptive Frequency | `interval = base / task_complexity` | 中 |
| Momentum-gated Interruption | momentum 上升时不中断 | 高 |
| Dynamic Output Budget | budget = base × vigor × season_factor | 低 |
| 三层 theta-gamma | Pirazzoli & Ursino 2024 的层级耦合模型 | 远期 |
