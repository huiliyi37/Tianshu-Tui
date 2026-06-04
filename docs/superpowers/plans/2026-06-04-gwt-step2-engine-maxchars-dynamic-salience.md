# GWT Step 2：Engine 层接入 maxChars + 动态 Salience

> 日期：2026-06-04
> 关联：#4 全局工作空间竞争（跨系统联动创意文档 §4）
> 设计文档：`docs/superpowers/specs/2026-06-04-gwt-salience-design.md`
> 状态：待实施

---

## 1. 任务概述

**目标**：将 GWT（全局工作空间理论）Step 1 的 salience 评分 + Top-K 预算选择机制接入 engine 层，实现动态上下文预算控制。

**背景**：
- Step 1 已实现：`assignSalience()` 评分函数 + `selectTopKBlocks()` Top-K 选择算法
- Step 2 需要：从 engine 层传入 `maxChars` 预算值，启用 GWT 选择机制

**价值**：
1. **Token 预算控制**：避免 context-update 子块无限膨胀
2. **优先级排序**：高 salience 信息（star-domain、repair-hint）优先保留
3. **Prefix Cache 安全**：仅影响 `<context-update>` 块，frozen prefix 字节完全不变

---

## 2. 现状分析

### 2.1 已实现的基础设施

**位置**：`src/prompt/volatile.ts`

| 函数 | 状态 | 用途 |
|------|------|------|
| `assignSalience(blockContent)` | ✅ 已实现 | 基于标签前缀的硬编码评分（0.3-1.0） |
| `selectTopKBlocks(blocks, maxChars)` | ✅ 已实现 | 按 salience 降序选择，预算内 Top-K |
| `buildDynamicAppendix(ctx, maxChars?)` | ✅ 已实现 | 带 GWT 的动态上下文渲染（maxChars 可选） |

**评分规则**（硬编码）：
```
<star-domain>       → 1.0  （身份锚定，最高优先级）
<repair-hint>       → 0.8  （直接可执行的修复指令）
<historical-lessons>→ 0.8  （历史教训，直接影响行为）
<task-progress>     → 0.7  （任务状态，工作记忆核心）
<decisions>         → 0.7  （决策记录，保持一致性）
<worktree-warning>  → 0.7  （异常告警）
<git-status>        → 0.6  （环境感知）
<recent-commits>    → 0.6  （上下文背景）
<tool-history>      → 0.5  （操作日志）
<session-state>     → 0.4  （会话元数据）
<cross-session>     → 0.4  （跨会话事件）
<read-file-dedup-hint> → 0.3  （去重提示，最低信息密度）
```

### 2.2 调用点分析

**位置**：`src/prompt/engine.ts`

```typescript
// 调用点 1：actionableTurn 为 true 时
const activeAppendix = this.actionableTurn ? buildDynamicAppendix(activeCtx) : ''

// 调用点 2：非 tracker 模式
if (this.actionableTurn) {
  const appendix = buildDynamicAppendix(dynamicCtx)
  ...
}
```

**问题**：两个调用点均未传 `maxChars`，GWT 选择机制未启用。

### 2.3 上下文窗口信息

**位置**：`src/agent/loop.ts:1002`

```typescript
const request = this.config.promptEngine.buildOaiRequest(
  this.session.getMessages(),
  this.recentToolHistory,
  this.config.contextWindow,  // ← 已有 contextWindow 参数
)
```

**位置**：`src/agent/loop-types.ts:28`

```typescript
export interface AgentConfig {
  contextWindow: number  // ← 已定义
  ...
}
```

---

## 3. 实施计划

### 3.1 Phase 1：Engine 层接入 maxChars（低复杂度）

**目标**：从 `contextWindow` 计算 `maxChars`，传给 `buildDynamicAppendix`

**改动点**：

1. **`src/prompt/engine.ts`**
   - 在 `buildOaiRequest` 方法中，从 `contextWindow` 计算 `maxChars`
   - 将 `maxChars` 传给两个 `buildDynamicAppendix` 调用点

**计算公式**（参考 `src/tools/model-read-cap.ts`）：
```typescript
// 基于 contextWindow 的百分比，上限 200K chars
const maxChars = Math.min(
  Math.floor(contextWindow * 0.05 * 4 * 1.3),  // 5% of context window, 4 chars/token, 1.3x buffer
  200_000  // 绝对上限
)
```

**向后兼容**：
- `maxChars` 参数可选，未传时行为不变（全量输出）
- 现有调用点不传 `maxChars`，行为不变

**Prefix Cache 安全**：
- GWT 选择仅影响 `<context-update>` 块（每轮动态重渲染）
- Frozen block（`buildVolatileBlockInternal`）和 stable block（`buildStableVolatileBlock`）不受影响
- Top-K 丢弃某些块不会破坏 prefix cache——frozen prefix 字节完全不变

### 3.2 Phase 2：动态 Salience 评分（中复杂度）

**目标**：基于 goal-alignment × freshness 动态调整 salience

**设计**：
```
salience = base_salience × goal_alignment × freshness - staleness_penalty
```

**因素**：
1. **base_salience**：硬编码的标签前缀评分（已有）
2. **goal_alignment**：与当前任务目标的对齐度（0.0-1.0）
   - 可从 `taskProgress`、`activeDomain` 等推断
3. **freshness**：信息新鲜度（0.0-1.0）
   - 基于时间衰减或轮次衰减
4. **staleness_penalty**：过期信息惩罚（0.0-0.5）
   - 过期的 git-status、session-state 等

**改动点**：

1. **`src/prompt/volatile.ts`**
   - 扩展 `assignSalience()` 函数，接受上下文参数
   - 实现动态评分逻辑

2. **`src/prompt/engine.ts`**
   - 传递上下文信息给 `buildDynamicAppendix`

**风险评估**：
- 动态评分可能引入不稳定性（每轮 salience 变化导致缓存失效）
- 建议：Phase 1 稳定后再实施 Phase 2

---

## 4. 测试计划

### 4.1 单元测试（必须）

**位置**：`src/prompt/__tests__/volatile.test.ts`

**测试用例**：

1. **assignSalience 评分正确性**
   - 每种标签前缀的评分值
   - 未知标签的默认评分（0.5）

2. **selectTopKBlocks 裁剪行为**
   - 预算充足时全量保留
   - 预算不足时按 salience 降序裁剪
   - 保底机制：至少保留一个块（最高 salience）

3. **buildDynamicAppendix GWT 选择**
   - 未传 maxChars：全量输出（向后兼容）
   - 传入 maxChars：启用 Top-K 选择
   - 空输入边界条件

4. **边界条件**
   - maxChars = 0：全量输出（向后兼容）
   - maxChars < 0：全量输出（向后兼容）
   - 空 parts 数组

### 4.2 集成测试（可选）

**位置**：`src/prompt/__tests__/engine.test.ts`

**测试用例**：

1. **buildOaiRequest 传入 maxChars**
   - 验证 `contextWindow` 正确转换为 `maxChars`
   - 验证 `buildDynamicAppendix` 收到正确的 `maxChars`

2. **Prefix Cache 稳定性**
   - 多轮调用后，frozen prefix 字节不变
   - GWT 选择仅影响 `<context-update>` 块

---

## 5. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| maxChars 计算公式不合理 | 信息丢失或浪费 | 参考 `model-read-cap.ts` 的成熟公式 |
| 动态 salience 引入不稳定性 | 缓存失效 | Phase 1 稳定后再实施 Phase 2 |
| 测试覆盖不足 | 回归风险 | 必须通过单元测试 + typecheck |
| Prefix Cache 破坏 | 缓存命中率下降 | 仅修改 `<context-update>` 块，frozen prefix 不变 |

---

## 6. 验收标准

### 6.1 功能验收

- [ ] `buildDynamicAppendix` 接受 `maxChars` 参数
- [ ] `buildOaiRequest` 从 `contextWindow` 计算 `maxChars` 并传入
- [ ] GWT Top-K 选择机制生效（高 salience 块优先保留）
- [ ] 向后兼容：未传 `maxChars` 时行为不变

### 6.2 质量验收

- [ ] 单元测试通过（`src/prompt/__tests__/volatile.test.ts`）
- [ ] typecheck 通过（`npx tsc --noEmit`）
- [ ] 现有测试不回归（`npm exec -- tsx --test src/**/__tests__/*.test.ts`）
- [ ] Prefix Cache 稳定性验证（frozen prefix 字节不变）

### 6.3 文档验收

- [ ] 设计文档更新（`docs/superpowers/specs/2026-06-04-gwt-salience-design.md`）
- [ ] 代码注释清晰（函数签名、参数说明）

---

## 7. 实施顺序

1. **Phase 1**：Engine 层接入 maxChars（1-2 小时）
   - 修改 `src/prompt/engine.ts`
   - 补充单元测试
   - typecheck + 测试验证

2. **Phase 2**：动态 Salience 评分（2-4 小时，可选）
   - 修改 `src/prompt/volatile.ts`
   - 补充单元测试
   - typecheck + 测试验证

---

## 8. 参考资料

- 设计文档：`docs/superpowers/specs/2026-06-04-gwt-salience-design.md`
- 现有实现：`src/prompt/volatile.ts`（assignSalience、selectTopKBlocks、buildDynamicAppendix）
- maxChars 计算参考：`src/tools/model-read-cap.ts`
- Prefix Cache 设计：`src/prompt/engine.ts`（frozenBase、cachedAppendix）

---

## 9. 附录：关键代码片段

### 9.1 buildDynamicAppendix 函数签名

```typescript
export function buildDynamicAppendix(ctx: VolatileContext, maxChars?: number): string
```

### 9.2 selectTopKBlocks 函数签名

```typescript
export function selectTopKBlocks(blocks: SalientBlock[], maxChars: number): string[]
```

### 9.3 SalientBlock 接口

```typescript
export interface SalientBlock {
  content: string
  salience: number
}
```

### 9.4 assignSalience 函数签名

```typescript
export function assignSalience(blockContent: string): number
```
