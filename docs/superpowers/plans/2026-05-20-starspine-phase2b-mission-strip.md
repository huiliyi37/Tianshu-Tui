# StarSpine Phase 2B-1：Mission Snapshot + Mission Strip Formatter

> 日期：2026-05-20  
> 类型：小步实施计划 / 用户可见任务态势  
> 状态：执行中  
> 前置：Phase 1 TaskContract + CognitiveLedger，Phase 2A Verification Gap Projection

---

## 目标

让 TaskContract 从 prompt 内部锚点变成 runtime/TUI 可见的 Mission Snapshot。

> 先让用户看见天枢“以为自己在做什么”。

Phase 2B-1 不接 `src/tui/app.tsx`，避免与并行 TUI/avatar 工作冲突。只完成数据源、getter、纯 formatter 与轻量组件。

---

## 设计原则

1. **不继续往 prompt 里加东西**：本阶段是 TUI Projection，不是 Prompt Projection。
2. **scope 控制为 count**：snapshot 只暴露 `scopeFileCount`，不把完整文件数组塞给 TUI，避免大任务溢出。
3. **getter 先行，事件后置**：AgentLoop 先提供 `getCognitiveSnapshot()`；React 更新可在 2B-2 复用现有 summaryState/useInterval。
4. **app wiring 延后**：`src/tui/app.tsx` 属于高冲突文件，2B-1 只新增组件和 formatter。

---

## 修改范围

```text
src/context/cognitive-ledger.ts
src/context/__tests__/cognitive-ledger.test.ts
src/agent/loop.ts
src/tui/mission-strip.tsx
src/tui/__tests__/mission-strip.test.ts
```

---

## Snapshot 扩展

`CognitivePhaseSnapshot` 新增：

```ts
scopeFileCount: number
isActionableTask: boolean
hasVerificationGap: boolean
```

明确不新增：

```ts
scopeFiles: string[]
```

完整 scope 仍留在 TaskContract 中，TUI 默认只展示 count。

---

## Mission Strip Formatter

新增纯函数：

```ts
formatMissionStrip(snapshot?: CognitivePhaseSnapshot): string | null
```

示例输出：

```text
天契 行 · fix auth bug in src/auth.ts · 1 file · 未验
```

显示规则：

- 无 snapshot → null
- non-actionable task → null
- 无 objective → null
- long objective → truncate
- verification gap → `未验`

状态映射：

```text
exploring → 探
planning → 策
executing → 行
verifying → 验
ready_to_deliver → 成
blocked → 阻
```

---

## AgentLoop 数据源

AgentLoop 每轮构建 CognitiveLedger 后保存：

```ts
this.latestCognitiveSnapshot = getCognitivePhaseSnapshot(cognitiveLedger)
```

并暴露：

```ts
getCognitiveSnapshot(): CognitivePhaseSnapshot | undefined
```

2B-2 可由 TUI 读取这个 getter 并接入 SummaryBar / Starbridge。

---

## 非目标

- 不接入 `src/tui/app.tsx`
- 不做 Contract Patch
- 不增加 prompt projection
- 不引入新 callback/event channel
- 不让 avatar 成为 Mission 的唯一信息载体

---

## 后续

Phase 2B-2：Mission Strip app wiring。  
Phase 2C：Contract Patch 用户纠偏。
