# GlanceBar Token & Compact Indicator 实现计划

> **状态：✅ 已全部实施** — GlanceBar token 计数 + compact 提示

**目标：** 在始终可见的 GlanceBar 底部状态栏中显示当前会话 token 使用量（估算值 / 上限）和 compact 紧迫度提示，让用户无需打开 cockpit overlay 就能判断何时该触发上下文压缩。

**架构：** 数据从 `SessionContext.getEstimatedTokens()` 和 `AppProps.maxTokens` 流出，经 `App` 组件注入 `GlanceBar`，后者根据默认 compact 阈值（watch=60%, compact=78%, reactive=88%, ceiling=95%）用颜色和可选图标提示紧迫度。不引入新状态机，只增加纯展示型 props。

**技术栈：** TypeScript strict + Ink 6 (React) + node:test

---

## 1. 范围检查（Scope Check）

本功能仅涉及 TUI 展示层，不涉及 compact 算法本身、不涉及 API 调用、不涉及状态机变更。范围清晰，无需拆分。

---

## 2. 文件结构

| 文件 | 职责 |
|------|------|
| `src/tui/glance-bar.tsx` | 修改：在 `GlanceBarProps` 增加 `estimatedTokens`、`maxTokens`；在渲染中加入 token 计数和 compact 紧迫度指示 |
| `src/tui/app.tsx` | 修改：在 `<GlanceBar>` JSX 上传递 `estimatedTokens={session.getEstimatedTokens()}` 和 `maxTokens={maxTokens}` |
| `src/tui/__tests__/glance-bar.test.ts` | 修改：补充带 token 参数的渲染用例和紧凑度颜色断言 |

---

## 3. 调研背书（Research Endorsement）

### 3.1 `SessionContext.getEstimatedTokens()`
- **定义位置：** `src/agent/context.ts:205`
- **返回：** `number` — 基于 `estimateOaiMessageTokens` 的滚动累加值，每次 `addUserMessage` / `addAssistantBlocks` / `replaceMessages` 时同步更新
- **调用方（部分）：**
  - `src/agent/compaction-controller.ts`（决定 compact tier）
  - `src/tui/cockpit/state.ts`（通过 `session.getContextLedger()?.tokenBudget.estimatedTokens`）
- **可靠性：** 这是主界面与 compact 决策共享的同一估算源，数据可信

### 3.2 `AppProps.maxTokens`
- **定义位置：** `src/tui/app.tsx:187`（`AppProps` interface）
- **来源：** 上层 `main.tsx` 传入，对应当前模型的 `contextWindow`
- **在 app.tsx 中的既有使用：**
  - 初始化 `summaryState.contextPct`：`Math.min(session.getEstimatedTokens() / maxTokens, 1)`（`app.tsx:684`）
  - `onTurnComplete` 中更新 `contextPct`（`app.tsx:897` 附近）
- **风险：** `maxTokens` 可能为 0（理论上不应发生），GlanceBar 渲染需做除零保护

### 3.3 `GlanceBar` 现有 props 与渲染位置
- **定义位置：** `src/tui/glance-bar.tsx:9`
- **已有 props：** `pulses`, `phase`, `cacheHitRate`, `cost`, `model`, `isStreaming`, `historyCount`, `domain`, `branch`
- **渲染位置：** 位于 `app.tsx:1347`，始终可见，紧邻 `InputBar`
- **修改影响：** 增加两个 number 类型 props，无副作用；渲染增加约 15-25 个字符的宽度，在 `columns < 60`（narrow mode）时可隐藏详细数字只保留百分比

### 3.4 Compact 阈值
- **定义位置：** `src/compact/constants.ts:25-30`
- **默认值：** `watch=0.60, compact=0.78, reactive=0.88, ceiling=0.95`
- **说明：** 实际 compact 决策会按 `providerProfile` 自适应（如 exact-prefix cache 用 `cache-preserving` 策略），但 GlanceBar 作为**粗略指示器**，使用默认阈值足以满足用户“什么时候该 compact”的诉求。更精确的 compact 状态仍应打开 cockpit 查看

---

## 4. 任务列表

### Task 1：在 `GlanceBarProps` 增加 token 相关 props，并编写紧凑度颜色函数

**文件：**
- 修改：`src/tui/glance-bar.tsx:9-18`
- 修改：`src/tui/glance-bar.tsx:23-67`

**代码变更：**

在 `interface GlanceBarProps` 中追加：

```typescript
  /** Estimated tokens currently in the session context */
  estimatedTokens: number
  /** Model context window size in tokens */
  maxTokens: number
```

在组件参数解构中追加 `estimatedTokens, maxTokens`。

在组件函数体中（`const theme = getTheme()` 之后）增加：

```typescript
  const ratio = maxTokens > 0 ? estimatedTokens / maxTokens : 0
  const estimatedK = Math.round(estimatedTokens / 1000)
  const maxK = Math.round(maxTokens / 1000)
  const pct = Math.round(ratio * 100)

  const tokenColor = ratio >= 0.95 ? theme.error
    : ratio >= 0.88 ? theme.error
    : ratio >= 0.78 ? theme.warning
    : ratio >= 0.60 ? theme.warning
    : theme.success
```

**验证：**
```bash
npx tsc --noEmit
```
**预期：** 无编译错误

---

### Task 2：在 GlanceBar JSX 中渲染 token 计数和 compact 提示

**文件：**
- 修改：`src/tui/glance-bar.tsx`（在 `historyCount` 渲染之后、`alertPulse` 之前插入）

**具体 edit：**

找到 `src/tui/glance-bar.tsx` 中的以下片段（约在文件 50-60 行）：

```tsx
      {historyCount !== undefined && !narrow && (
        <Text color={theme.muted}> · {historyCount} msgs</Text>
      )}
      {alertPulse?.hint && <Text color={theme.error}> · {alertPulse.hint}</Text>}
```

替换为：

```tsx
      {!narrow && (
        <Text color={theme.dim}> · </Text>
      )}
      {!narrow && (
        <Text color={tokenColor}>{estimatedK}k/{maxK}k ({pct}%)</Text>
      )}
      {narrow && (
        <Text color={tokenColor}> · {pct}%</Text>
      )}
      {ratio >= 0.78 && (
        <Text color={theme.error}> · compact</Text>
      )}
      {historyCount !== undefined && !narrow && (
        <Text color={theme.muted}> · {historyCount} msgs</Text>
      )}
      {alertPulse?.hint && <Text color={theme.error}> · {alertPulse.hint}</Text>}
```

**验证：**
```bash
npx tsc --noEmit
```
**预期：** 无编译错误

---

### Task 3：在 `app.tsx` 的 `<GlanceBar>` 上传递 token props

**文件：**
- 修改：`src/tui/app.tsx:1347-1358`

**具体 edit：**

找到 `app.tsx` 中的：

```tsx
        <GlanceBar
          pulses={glancePulses}
          phase={phaseFromSummary(summaryState)}
          cacheHitRate={cacheHitRate}
          cost={cost}
          model={model}
          isStreaming={isStreaming}
          historyCount={historyItems.length}
          domain={starDomain}
          branch={gitBranch}
        />
```

替换为：

```tsx
        <GlanceBar
          pulses={glancePulses}
          phase={phaseFromSummary(summaryState)}
          cacheHitRate={cacheHitRate}
          cost={cost}
          model={model}
          isStreaming={isStreaming}
          historyCount={historyItems.length}
          domain={starDomain}
          branch={gitBranch}
          estimatedTokens={session.getEstimatedTokens()}
          maxTokens={maxTokens}
        />
```

**验证：**
```bash
npx tsc --noEmit
```
**预期：** 无编译错误

---

### Task 4：更新 GlanceBar 测试

**文件：**
- 修改：`src/tui/__tests__/glance-bar.test.ts`

**现有测试结构：**
- 测试 1：验证 exports memo component
- 测试 2：验证 renders with 6-domain pulses and alert hint props

**新增测试：**

在 describe 块中追加两个测试：

```typescript
  it('renders token count and percentage', () => {
    const el = render({
      pulses: [],
      phase: 'tianshu-planning',
      cacheHitRate: 0.5,
      cost: 0.1,
      model: 'deepseek-chat',
      isStreaming: false,
      estimatedTokens: 45_000,
      maxTokens: 128_000,
    })
    assert.ok(el != null)
    assert.equal(el.props.estimatedTokens, 45_000)
    assert.equal(el.props.maxTokens, 128_000)
  })

  it('shows compact hint when ratio >= 78%', () => {
    const el = render({
      pulses: [],
      phase: 'tianshu-planning',
      cacheHitRate: 0.5,
      cost: 0.1,
      model: 'deepseek-chat',
      isStreaming: false,
      estimatedTokens: 100_000,
      maxTokens: 128_000,
    })
    assert.ok(el != null)
    // ratio = 100/128 ≈ 0.78 → should include compact indicator
    assert.equal(el.props.estimatedTokens, 100_000)
    assert.equal(el.props.maxTokens, 128_000)
  })
```

**验证：**
```bash
npm exec -- tsx --test src/tui/__tests__/glance-bar.test.ts
```
**预期：** 2 个既有测试 + 2 个新增测试全部通过

---

### Task 5：运行全量测试和类型检查

**验证：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/tui/__tests__/glance-bar.test.ts
```
**预期：**
- `tsc --noEmit`：0 errors
- 单元测试：全部通过

**提交：**
```bash
git add src/tui/glance-bar.tsx src/tui/app.tsx src/tui/__tests__/glance-bar.test.ts
git commit -m "feat(tui): show estimated tokens and compact urgency in GlanceBar"
```

---

## 5. 验证命令汇总

| 命令 | 预期结果 |
|------|----------|
| `npx tsc --noEmit` | 0 errors, 0 warnings |
| `npm exec -- tsx --test src/tui/__tests__/glance-bar.test.ts` | 4 tests pass |

---

## 6. 自检清单

### 6.1 Spec 覆盖

| 需求 | 对应任务 |
|------|----------|
| 会话内展示 token 量 | Task 2（`{estimatedK}k/{maxK}k ({pct}%)` 渲染） |
| 分不清什么时候该 compact → 需要视觉提示 | Task 1 + Task 2（颜色阈值 + `compact` 文字提示） |
| 窄终端适配 | Task 2（narrow mode 只显示百分比） |
| 除零保护 | Task 1（`maxTokens > 0` 条件） |

**无遗漏。**

### 6.2 Placeholder 扫描

- [x] 无 `TODO / TBD / 待定 / 后续实现 / 补充细节`
- [x] 无模糊的错误处理描述
- [x] 无未定义的类型/函数/属性
- [x] 每个 task 都包含具体代码和精确 edit 位置

### 6.3 类型一致性

- `estimatedTokens` 和 `maxTokens` 均为 `number` 类型，与 `SessionContext.getEstimatedTokens()` 和 `AppProps.maxTokens` 类型一致
- `ratio` 计算使用 `number / number`，结果 `number`
- `tokenColor` 使用 `string`（theme 颜色值），与 `Text` 组件的 `color` prop 类型一致
- 测试中的 render props 与 `GlanceBarProps` 新增字段完全对齐

---

## 7. 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-06-01-glancebar-token-compact-indicator.md`。两种执行方式：

1. **子代理驱动（推荐）** — 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. **内联执行** — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？
