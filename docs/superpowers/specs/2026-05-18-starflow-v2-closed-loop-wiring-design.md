# StarFlow v2 闭环接线设计

> 版本：v1.0
> 日期：2026-05-18
> 状态：待审查
> 前置：StarFlow v2 Sensorium 设计文档 (2025-05-17)
> 后续：pressure-control Phase 1

---

## 背景

### 用户需求
"把 StarFlow v2 的已有感知层接成可靠闭环。先把缺口打实，再进入 pressure-control Phase 1。"

### 当前状态
StarFlow v2 的传感器层和策略计算层已完整实现（5 commits, 86 tests, 1513 pass）。但审查发现：**策略→行为的最后一跳大面积断开**。

### 已确认关闭的缺口（无需修复）
| 缺口 | 状态 | 证据 |
|------|------|------|
| reasoningEffort 接线 | ✅ 已关闭 | loop.ts:503 `this.setReasoningEffort(this.strategy.reasoningEffort)` |
| Sensorium 遥测 JSONL | ✅ 已关闭 | loop.ts:528-542 写入 `.rivet/sensorium.jsonl` |

### 真正的缺口（本次修复目标）
| # | 缺口 | 根因类别 | 影响 |
|---|------|---------|------|
| 1 | StigmergyStore.query() 从未调用 | 数据基础设施 | freshness 永远 0.5，衰减公式形同虚设 |
| 2 | StigmergyStore.prune() 从未调用 | 数据基础设施 | 过期 pheromone 无限积累 |
| 3 | Theta-gamma 空体 | 空实现占位 | 节律触发但不执行任何检查 |
| 4 | Kick deadEndPaths 丢弃 | 部分接线 | dead-end 信号不持久化 |
| 5 | Kick alternativeFrameworks 丢弃 | 部分接线 | 替代框架不传达给 LLM |
| 6 | hasEnteredHighComplexity 未设置 | 缺失代码 | contracting 阶段永远不触发 |

### 明确不修复的项（YAGNI）
| 项 | 原因 |
|----|------|
| explorationBreadth 消费者 | 无明确行为目标，无法定义"更广探索"的具体动作 |
| commitThreshold 消费者 | 当前无 auto-commit 机制，阈值无处施加 |
| 1-turn 阻尼 | 6 条遥测无振荡证据，预防性设计无数据支撑 |
| computeStrategy 重写 | 改策略计算不解决消费者缺失问题 |

---

## 调研发现摘要

### 反证 Scout 关键结论
1. **独立接线是系统的成功模式**（PressureMonitor/PredictionAccumulator 证明），不需要收敛层
2. **3 种不同根因不可归并**：数据缺失 / 空实现 / 部分接线，需分层修复
3. **效应器有 3 种自然时机**：turn-start（reasoning effort）、after-tool（cerebellar）、turn-end（telemetry），不可统一

### 外部调研关键发现
- **Theta-gamma 实现**：spawn('tsc') 进程隔离优于 Compiler API（agent 不因 tsc 崩溃而死）
- **DeepSeek reasoning**：只有 high/max 两个有效级别，当前 5 级映射大部分无效（但不影响本次修复）
- **Overthinking 反效果**：benchmark 显示高 reasoning effort 在 agentic 场景反而降低性能

### 生物学启发（保留为 TUI 2.1 候选）
- **TGF 快慢双通道**：未来 pressure-control 可用
- **补体 Factor H 定位域**：未来 pheromone-aware 策略可用
- **气孔 SLAC1 积分器**：未来 computeStrategy 重写可用
- **乙烯动力学阻尼**：等有振荡证据后再引入

---

## 最终方案：4 阶段独立接线

### 设计原则
1. 遵循现有 Pattern B（mutable-class）和 Pattern D（disk persistence）
2. 每个修复独立可验证（TDD）
3. 严格依赖顺序：数据层 → 消费层
4. 不引入新架构层、新依赖、新抽象

### Phase A：Stigmergy 数据层修复（P0）

**目标**：让 freshness 维度从常量 0.5 变为动态值

**修改点：**

1. `src/agent/loop.ts:427` — `load()` → `query()`
```typescript
// Before:
const loadedPheromones = this.stigmergyStore.load()

// After:
const queriedPheromones = this.stigmergyStore.query()
const loadedPheromones = queriedPheromones.map(q => ({
  path: q.path,
  signal: q.signal,
  strength: q.currentStrength,  // decayed value
}))
```

2. `src/agent/loop.ts:762` — 同上替换

3. `src/agent/loop.ts` run() 开始处 — 加 prune
```typescript
this.stigmergyStore.prune()
```

4. `src/agent/sensorium.ts` computeFreshness — 确认使用传入的 strength（已是衰减值）

**成功标准**：运行 2 次 session 后，sensorium.jsonl 中 freshness ≠ 0.5
**退出条件**：query() 性能 > 5ms → 降级回 load() + 手动衰减

---

### Phase B：Theta-Gamma 填充（P1）

**目标**：节律触发时执行实际类型检查

**新文件**：`src/agent/theta-check.ts`
```typescript
import { spawn } from 'node:child_process'

export interface ThetaCheckResult {
  errors: string[]   // file paths with type errors
  durationMs: number
}

export function runThetaCheck(cwd: string): Promise<ThetaCheckResult> {
  // spawn tsc --noEmit --skipLibCheck
  // parse stderr for error file paths
  // timeout 3s → return empty
}
```

**修改点**：`src/agent/loop.ts:719-720`
```typescript
// Before:
if (this.sensorium && this.sensorium.complexity > 0.5 && tickTheta(this.thetaState, turn)) {
  this.thetaState = completeTheta(this.thetaState)
}

// After:
if (this.sensorium && this.sensorium.complexity > 0.5 && tickTheta(this.thetaState, turn)) {
  const thetaResult = await runThetaCheck(this.cwd)
  if (thetaResult.errors.length > 0) {
    this.repairHintTracker.recordFailure(thetaResult.errors[0], 'type-inconsistency')
  }
  this.thetaState = completeTheta(this.thetaState)
}
```

**成功标准**：故意引入类型错误 → theta 触发 → tsc 检测到错误
**退出条件**：tsc 耗时 > 3s → 改为只检查 activeFiles

---

### Phase C：Kick 效应器补齐（P1）

**目标**：耗散踢触发时，dead-end 信号持久化 + 替代框架传达

**修改点**：`src/agent/loop.ts:545-556`
```typescript
// Before:
const kickActions = buildKickActions(this.sensorium, this.cwd)
if (kickActions.injectedMessage) {
  this.session.addUserMessage(kickActions.injectedMessage)
}

// After:
const kickActions = buildKickActions(this.sensorium, this.cwd, this.recentlyFailedFiles)
for (const p of kickActions.deadEndPaths) {
  this.stigmergyStore.deposit({ path: p, signal: 'dead-end', strength: 0.9, halfLife: 7 * 24 * 3600 * 1000 })
}
const fullMessage = kickActions.alternativeFrameworks.length > 0
  ? `${kickActions.injectedMessage}\n\n**替代框架：**\n${kickActions.alternativeFrameworks.map(f => `- ${f}`).join('\n')}`
  : kickActions.injectedMessage
if (fullMessage) {
  this.session.addUserMessage(fullMessage)
}
```

**成功标准**：触发 kick → pheromones.json 出现 dead-end 条目
**退出条件**：无（< 15 行，风险极低）

---

### Phase D：Contracting Trigger（P2）

**目标**：复杂任务后期可进入 tianquan-contracting 阶段

**修改点**：`src/agent/loop.ts`

1. 字段声明：
```typescript
private hasEnteredHighComplexity = false
```

2. run() 开始处重置：
```typescript
this.hasEnteredHighComplexity = false
```

3. per-turn sensorium 计算后：
```typescript
if (this.sensorium && this.sensorium.complexity > 0.5) {
  this.hasEnteredHighComplexity = true
}
```

4. StarPhaseContext 构建时传入：
```typescript
hasEnteredHighComplexity: this.hasEnteredHighComplexity
```

**成功标准**：sensorium.jsonl 中出现 tianquan-contracting phase
**退出条件**：无（< 10 行）

---

## 风险与应对

| 风险 | 概率 | 应对 |
|------|------|------|
| stigmergy deposit 条件太窄，pheromones 积累慢 | 中 | Phase A 后观察 2 session，如果 deposit 频率 < 1/session 则放宽条件 |
| spawn tsc 在大项目中超时 | 低 | 3s timeout + skipLibCheck；超时返回空结果 |
| theta-gamma 在 CI 中无 tsc | 低 | 检测 tsc 是否可用，不可用时跳过 |
| kick 触发频率极低（需要 momentum<0.2 AND stability<0.3） | 中 | 这是设计意图（只在真正停滞时触发），不是 bug |

---

## 依赖关系图

```
Phase A (stigmergy 数据层)
  ↓ freshness 开始变化
Phase B (theta-gamma)     Phase C (kick 效应器)     Phase D (contracting)
  ↓                         ↓                         ↓
  独立，无互相依赖           依赖 Phase A（deposit 需要 stigmergyStore 正常工作）
```

Phase A 必须先完成。B/C/D 可并行。

---

## 代码量估算

| Phase | 新增行数 | 修改行数 | 新文件 |
|-------|---------|---------|--------|
| A | 0 | ~20 | 0 |
| B | ~40 | ~10 | 1 (theta-check.ts) |
| C | 0 | ~15 | 0 |
| D | 0 | ~10 | 0 |
| **总计** | **~40** | **~55** | **1** |

---

## 下一步

Phase A 的第一个具体动作：在 `src/agent/loop.ts:427` 将 `this.stigmergyStore.load()` 替换为 `this.stigmergyStore.query()`，并映射返回值格式。
