# Midnight 主题对比度优化 实现计划

> **面向 AI 代理：** 使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 提升 Midnight 主题的可读性——将"标签类灰色文本"从过暗的 `#6e7681` 提升到可辨识的 `#9aa2b1`，新增 `muted` 颜色层级区分"需阅读的次要文本"和"纯装饰性元素"，重点修复 Thinking 内容全部灰色导致几乎不可读的问题。

**架构：** 两阶段：(1) 在 theme.ts 中为 Midnight 主题新增 `muted` 颜色（`#9aa2b1`），调整 `dim` 从 `#6e7681` 到 `#6e7681`（保持不变，仅用于分割线和装饰），同时微调 `secondary` 从 `#8b949e` 到 `#b0b8c4` 提升标签可读性；(2) 在 cockpit 面板标签、GlanceBar 数据字段、ThinkingMessage 内容中将 `theme.dim` → `theme.muted`，将 `dimColor`（Ink 内建暗化）→ 显式 `color={theme.muted}` 以消除终端差异。

**技术栈：** TypeScript strict, Ink 6, node:test + assert/strict

---

## 1. Scope Check

本计划仅涉及 `src/tui/theme.ts` 颜色值调整和 TUI 组件中 `theme.dim` / `dimColor` 的重新分配。不改动组件结构、逻辑或行为。

| 子系统 | 涉及 | 原因 |
|--------|------|------|
| `src/tui/theme.ts` | ✅ | Midnight 颜色值调整 + 新增 muted |
| `src/tui/thinking-message.tsx` | ✅ | dimColor → theme.muted |
| `src/tui/glance-bar.tsx` | ✅ | theme.dim → theme.muted（数据字段） |
| `src/tui/cockpit/*.tsx` | ✅ | 标签 text theme.dim → theme.muted |
| `src/tui/assistant-message.tsx` | ✅ | 截断指示器 dimColor → theme.muted |
| `src/tui/stream.tsx` | ✅ | 截断指示器 + 等待文字 |
| `src/tui/app.tsx` | ✅ | heartbeat/fluency 文字 |
| 其他 TUI 组件 | ❌ | 装饰性/占位符 dimColor 保持不变 |

---

## 2. File Structure

### 2.1 新建文件

无。

### 2.2 修改文件

| 文件 | 改动 |
|------|------|
| `src/tui/theme.ts` | (a) `RivetTheme` 接口新增 `muted: string`；(b) Midnight truecolor: `secondary` `#8b949e`→`#b0b8c4`，新增 `muted: '#9aa2b1'`；(c) `buildTheme` 中 `systemColor` 改用 `muted` |
| `src/tui/thinking-message.tsx` | 全部 `dimColor` → `color={theme.muted}`（getTheme + 显式颜色） |
| `src/tui/glance-bar.tsx` | model/cost/msgs 字段 `theme.dim` → `theme.muted`；分隔符 `·` 保留 `theme.dim` |
| `src/tui/cockpit/context-panel.tsx` | 标签行 "Rounds:" / "Compaction:" 等 `theme.dim` → `theme.muted` |
| `src/tui/cockpit/model-panel.tsx` | 标签行 "Cache:" / "Tokens:" / "Est. cost:" 等 `theme.dim` → `theme.muted` |
| `src/tui/cockpit/verification-panel.tsx` | 标签行 "Files read:" / "Modified:" / "Delivery:" / "Impacts:" `theme.dim` → `theme.muted` |
| `src/tui/cockpit/safety-panel.tsx` | 标签行 "Doom loop:" / "Risk:" / "Fingerprint:" `theme.dim` → `theme.muted` |
| `src/tui/cockpit/mcp-panel.tsx` | 标签行 "Servers:" / "Tools:" `theme.dim` → `theme.muted` |
| `src/tui/cockpit/trace-panel.tsx` | turn 标签 `theme.dim` → `theme.muted` |
| `src/tui/assistant-message.tsx` | 截断省略指示器 `dimColor` → `color={theme.muted}` |
| `src/tui/stream.tsx` | 等待文字 + 截断指示器 `theme.dim` / `dimColor` → `theme.muted` |
| `src/tui/app.tsx` | fluency stale / heartbeat 文字 `dimColor` → 显式 color |
| `src/tui/__tests__/theme.test.ts` | 新增测试：`theme.muted` 存在且为预期值 |

---

## 3. Research Endorsement（调研背书）

### 3.1 theme.ts `dim` 颜色值与 `dimColor` 的区别

**现状：**

- `theme.dim = '#6e7681'`（Midnight）— 显式 hex 颜色，Ink 渲染为确切的灰色
- `dimColor` prop — Ink 内建属性，由终端自行决定如何"暗化"文字。在部分终端上等于降低亮度 50%，可能导致文字几乎消失

**`dimColor` 使用场景调研：**

| 组件 | 使用方式 | 场景 | 是否需改 |
|------|---------|------|---------|
| `thinking-message.tsx` | 全部 thinking 内容 | **需要阅读的文本** | ✅ → `theme.muted` |
| `thinking.tsx` | live thinking 内容 | 流式 thinking 预览 | ✅ → `theme.muted` |
| `tool-card.tsx` | 行数、展开提示 | 辅助信息，可读即可 | ⚠️ 保留评估 |
| `diff-render.tsx` | 未变更行 | diff 上下文，装饰性 | ❌ 保留 |
| `markdown-render.tsx` | 代码注释、引文 | 次要内容 | ⚠️ 保留评估 |
| `system-message.tsx` | 系统消息（非错误） | 系统级提示 | ❌ 保留 |
| `render-entry.tsx` | checkpoint 文字 | 特殊标记 | ❌ 保留 |
| `assistant-message.tsx` | 截断省略指示器 | 辅助信息 | ✅ → `theme.muted` |
| `stream.tsx` | 截断省略指示器 | 辅助信息 | ✅ → `theme.muted` |

- **调用方**：`dimColor` 是 Ink 的 `Text` 组件 prop，不是函数，无外部调用方
- **变更风险**：低。`dimColor` → `color={theme.muted}` 是视觉等价替换，行为不变
- **边界风险**：需确保使用 `getTheme()` 获取 theme 对象后再传 `theme.muted`

### 3.2 `theme.dim` 用作标签文字（cockpit 面板）

**现状：**

cockpit 面板中大量使用 `theme.dim` 作为数据标签的颜色：
```tsx
// context-panel.tsx:57
<Text color={theme.dim}>Rounds: </Text>
// model-panel.tsx:42
<Text color={theme.dim}>Cache: </Text>
```

这些是**标签**，需要被阅读。`#6e7681` 在深色终端背景上对比度不足（WCAG 对比度约 4.2:1，勉强达到 AA 级但视觉上偏暗）。

- **调用方**：仅各 cockpit 面板组件内部使用，无外部调用方
- **存在原因**：主题初设时只有 `primary/secondary/dim` 三层，`dim` 被同时用于"装饰性分隔"和"标签文字"两种不同语义
- **变更风险**：低。纯颜色替换
- **边界风险**：需保持 cockpit 面板的视觉层次——标题 bold primary，数值 secondary/muted，标签 muted

### 3.3 `systemColor` = `theme.dim`

**现状（theme.ts:183-185）：**
```typescript
systemColor: colors.dim,
```

系统消息使用 `dim` 颜色。改为 `muted` 后系统消息会更可读。

- **调用方**：`system-message.tsx` 使用 `theme.systemColor`（非 isError 时）
- **变更风险**：低

---

## 4. Tasks

### 任务 1：theme.ts 新增 muted 颜色，调整 Midnight 色值

**目标**：在 `RivetTheme` 接口和 Midnight 主题中新增 `muted` 颜色；微调 `secondary` 提升标签对比度。

**步骤：**

- [ ] **1.1** 修改 `src/tui/__tests__/theme.test.ts` — 新增 muted 颜色断言：

在 `getTheme` describe 块末尾添加：
```typescript
  it('exposes muted color for secondary readable text', () => {
    const theme = getTheme(3)
    assert.equal(typeof theme.muted, 'string')
    assert.ok(theme.muted.length > 0)
    // muted should be distinguishable from dim
    assert.notEqual(theme.muted, theme.dim)
  })
```

- [ ] **1.2** 运行测试确认失败：`npm exec -- tsx --test src/tui/__tests__/theme.test.ts` → **预期失败**（`theme.muted` 不存在）

- [ ] **1.3** 修改 `src/tui/theme.ts` — `RivetTheme` 接口添加 `muted`：

```typescript
export interface RivetTheme {
  primary: string
  secondary: string
  success: string
  warning: string
  error: string
  dim: string
  muted: string       // ← 新增
  pulseQuiet: string
  pulseActive: string
  pulseAlert: string
  userColor: string
  assistantColor: string
  systemColor: string
  toolColor: (toolName: string) => string
  contextColor: (pct: number) => string
}
```

- [ ] **1.4** 修改 `src/tui/theme.ts` — Midnight truecolor 色值调整：

```typescript
const MIDNIGHT_TRUECOLOR: ColorSet = {
  primary: '#58a6ff',
  secondary: '#b0b8c4',   // was '#8b949e' — 提升标签可读性
  success: '#3fb950',
  warning: '#d29922',
  error: '#f85149',
  dim: '#6e7681',          // 不变 — 仅用于分隔线和纯装饰
  pulseQuiet: '#3d4450',
  pulseActive: '#58a6ff',
  pulseAlert: '#f85149',
}
```

- [ ] **1.5** 修改 `src/tui/theme.ts` — `buildTheme` 函数：

```typescript
function buildTheme(colors: ColorSet, overrides?: { userColor?: string; assistantColor?: string }): RivetTheme {
  return {
    ...colors,
    muted: '#9aa2b1',     // 介于 secondary 和 dim 之间
    userColor: overrides?.userColor ?? colors.primary,
    assistantColor: overrides?.assistantColor ?? colors.secondary,
    systemColor: '#9aa2b1', // was colors.dim — 系统消息改用 muted
    toolColor: makeToolColor(colors),
    contextColor: makeContextColor(colors),
  }
}
```

- [ ] **1.6** 运行测试确认通过：`npm exec -- tsx --test src/tui/__tests__/theme.test.ts` → **预期通过**（含新增 muted 测试）

- [ ] **1.7** typecheck：`npx tsc --noEmit` → **预期通过**

- [ ] **1.8** 提交：`git add src/tui/theme.ts src/tui/__tests__/theme.test.ts && git commit -m "feat(theme): add muted color tier to Midnight, bump secondary contrast"`

---

### 任务 2：ThinkingMessage — dimColor → theme.muted

**目标**：将 thinking 内容从 Ink 内建 `dimColor`（终端依赖）改为显式 `theme.muted` 颜色，确保在所有终端上可读。

**步骤：**

- [ ] **2.1** 修改 `src/tui/thinking-message.tsx`：

将 import 和组件改为使用 `getTheme()` + 显式 color：

```typescript
import { Box, Text } from 'ink'
import { memo } from 'react'
import { formatThinkingSize } from './thinking.js'
import { useViewportLines } from './viewport.js'
import { getTheme } from './theme.js'

// ...

export const ThinkingMessage = memo(function ThinkingMessage({ content }: ThinkingMessageProps) {
  const theme = getTheme()
  const maxLines = useViewportLines(0.4, 3)
  const lines = content.split('\n')
  const totalLines = lines.length

  if (totalLines <= maxLines) {
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text color={theme.muted}>▸ Thinking ({formatThinkingSize(content.length)})</Text>
        <Box paddingLeft={2} flexDirection="column">
          {lines.map((line, i) => (
            <Text key={i} color={theme.muted}>{line}</Text>
          ))}
        </Box>
      </Box>
    )
  }

  const omitted = totalLines - maxLines
  const visibleLines = lines.slice(-maxLines)
  return (
    <Box flexDirection="column" paddingX={2}>
      <Text color={theme.muted}>▸ Thinking ({formatThinkingSize(content.length)}, {omitted} earlier lines omitted)</Text>
      <Box paddingLeft={2} flexDirection="column">
        <Text color={theme.muted}>…</Text>
        {visibleLines.map((line, i) => (
          <Text key={i} color={theme.muted}>{line}</Text>
        ))}
      </Box>
    </Box>
  )
})
```

即：所有 `dimColor` → `color={theme.muted}`，新增 `import { getTheme } from './theme.js'`，函数体首行加 `const theme = getTheme()`。

- [ ] **2.2** typecheck：`npx tsc --noEmit` → **预期通过**

- [ ] **2.3** 运行 thinking 相关测试：`npm exec -- tsx --test src/tui/__tests__/thinking.test.tsx` → **预期通过**

- [ ] **2.4** 提交：`git add src/tui/thinking-message.tsx && git commit -m "fix(theme): replace dimColor with theme.muted in ThinkingMessage for readability"`

---

### 任务 3：GlanceBar + cockpit 标签 — theme.dim → theme.muted

**目标**：把 cockpit 面板中的数据标签和 GlanceBar 中的数据字段从 `theme.dim` 改为 `theme.muted`，分隔符保持 `theme.dim`。

**步骤：**

- [ ] **3.1** 修改 `src/tui/glance-bar.tsx` — 数据字段改 muted，分隔符保持 dim：

```typescript
// 第 34 行：model 名称
{!narrow && <Text color={theme.muted}>{model.slice(0, 20)}</Text>}
// 第 40 行：cost
<Text color={theme.muted}>${cost.toFixed(2)}</Text>
// 第 43 行：history count
<><Text color={theme.dim}> · </Text><Text color={theme.muted}>{historyCount} msgs</Text></>
```

保留 `theme.dim` 的：第 35、38 行的 `·` 分隔符，第 41 行不变（已是 `theme.dim`）。

- [ ] **3.2** 修改 `src/tui/cockpit/context-panel.tsx` — 标签行：

```typescript
<Text color={theme.muted}>Rounds: </Text>
<Text color={theme.muted}>Compaction: </Text>
// 保留 data 值颜色不变（theme.secondary）
// 保留 token bar + pct 颜色不变
```

- [ ] **3.3** 修改 `src/tui/cockpit/model-panel.tsx` — 标签行：

```typescript
<Text color={theme.muted}>Cache: </Text>
<Text color={theme.muted}>Tokens ─ in: </Text>
<Text color={theme.muted}> out: </Text>
<Text color={theme.muted}>Cache  ─ read: </Text>
<Text color={theme.muted}> write: </Text>
<Text color={theme.muted}>Turn cache: </Text>
<Text color={theme.muted}>Est. cost: </Text>
```

- [ ] **3.4** 修改 `src/tui/cockpit/verification-panel.tsx` — 标签行：

```typescript
<Text color={theme.muted}>Files read: </Text>
<Text color={theme.muted}> │ Modified: </Text>
<Text color={theme.muted}>Delivery: </Text>
<Text color={theme.muted}>Impacts: </Text>
```

- [ ] **3.5** 修改 `src/tui/cockpit/safety-panel.tsx` — 标签行：

```typescript
<Text color={theme.muted}>Doom loop: </Text>
<Text color={theme.muted}>Risk: </Text>
<Text color={theme.muted}>Fingerprint diversity: </Text>
```

- [ ] **3.6** 修改 `src/tui/cockpit/mcp-panel.tsx` — 标签行：

```typescript
<Text color={theme.muted}>Servers: </Text>
<Text color={theme.muted}> │ Tools: </Text>
```

- [ ] **3.7** 修改 `src/tui/cockpit/trace-panel.tsx` — turn 标签：

```typescript
<Text color={theme.muted}>turn {e.turn} │ </Text>
```

- [ ] **3.8** typecheck：`npx tsc --noEmit` → **预期通过**

- [ ] **3.9** 运行 cockpit 测试：`npm exec -- tsx --test src/tui/cockpit/__tests__/*.test.ts` → **预期通过**

- [ ] **3.10** 提交：`git add src/tui/glance-bar.tsx src/tui/cockpit/context-panel.tsx src/tui/cockpit/model-panel.tsx src/tui/cockpit/verification-panel.tsx src/tui/cockpit/safety-panel.tsx src/tui/cockpit/mcp-panel.tsx src/tui/cockpit/trace-panel.tsx && git commit -m "fix(theme): use theme.muted for cockpit labels and GlanceBar data, keep dim for separators"`

---

### 任务 4：助理消息截断指示器 + stream 等待文字

**目标**：assistant-message 和 stream 中的截断省略指示器从 `dimColor` → `theme.muted`，提升可读性。

**步骤：**

- [ ] **4.1** 修改 `src/tui/assistant-message.tsx` — 截断指示器：

```typescript
// 第 41 行：将 dimColor 改为显式 color
<Text color={theme.muted}>… {omittedLines} earlier lines omitted</Text>
```

即：`<Text dimColor>` → `<Text color={theme.muted}>`

- [ ] **4.2** 修改 `src/tui/stream.tsx` — 等待文字和截断指示器：

```typescript
// 等待文字：
<Text color={theme.muted}>◌ Waiting for model…</Text>
// 截断指示器：
<Text color={theme.muted}>(… {omittedLines} earlier lines)</Text>
```

即：`color={theme.dim}` → `color={theme.muted}`，`dimColor` → `color={theme.muted}`

- [ ] **4.3** typecheck：`npx tsc --noEmit` → **预期通过**

- [ ] **4.4** 运行消息组件测试：`npm exec -- tsx --test src/tui/__tests__/assistant-message.test.ts src/tui/__tests__/stream.test.tsx` → **预期通过**

- [ ] **4.5** 提交：`git add src/tui/assistant-message.tsx src/tui/stream.tsx && git commit -m "fix(theme): use theme.muted for truncation indicators and stream placeholder"`

---

### 任务 5：app.tsx fluency/heartbeat 文字

**目标**：fluency stale 和 heartbeat 状态文字从 `dimColor` → 显式 color，确保可读。

**步骤：**

- [ ] **5.1** 修改 `src/tui/app.tsx` — 找到 fluency stale 和 heartbeat 渲染行（约 1216-1221 行）：

```tsx
// fluency stale:
<Text dimColor color="yellow">⚠ {fluencyStale}</Text>
// 改为：
<Text color="yellow">⚠ {fluencyStale}</Text>

// heartbeat:
<Text dimColor>◌ {heartbeatStatus}</Text>
// 改为：
<Text color={theme.dim}>◌ {heartbeatStatus}</Text>
```

- [ ] **5.2** typecheck：`npx tsc --noEmit` → **预期通过**

- [ ] **5.3** 提交：`git add src/tui/app.tsx && git commit -m "fix(theme): remove dimColor from fluency/heartbeat status for readability"`

---

## 5. Verification

### 5.1 自动化验证

```bash
# 全量 typecheck
npx tsc --noEmit
# 预期：0 errors

# 全量 TUI 测试
npm exec -- tsx --test src/tui/__tests__/*.test.ts src/tui/__tests__/*.test.tsx src/tui/**/__tests__/*.test.ts src/tui/**/__tests__/*.test.tsx
# 预期：全部通过（已存在的失败不计入）

# 主题专项测试
npm exec -- tsx --test src/tui/__tests__/theme.test.ts
# 预期：7 项测试全部通过（含新增 muted 测试）
```

### 5.2 手动验证清单

- [ ] 启动 `node dist/main.js`，确认当前主题为 Midnight（`/theme midnight`）
- [ ] 输入任意 prompt，观察流式输出期间：
  - Assistant 文本使用 `#e6edf3`（白色），清晰可读
  - Thinking 文本使用 `#9aa2b1`（muted gray），明显比之前亮
- [ ] 输入 `/cockpit` 查看面板：
  - 标签文字（"Cache:", "Tokens:", "Rounds:" 等）使用 `#9aa2b1`，可辨识
  - 数值文字使用 `#b0b8c4`（secondary）或语义颜色，清晰
  - 分隔符 `·` 保持 `#6e7681`（dim），低调
- [ ] GlanceBar 中 model 名称、cost、消息数可读
- [ ] 截断时 `… N earlier lines omitted` 指示器可读
- [ ] 切换到其他主题（`/theme pastel`）确认不受影响

---

## 6. Self-Check

### 6.1 Spec Coverage

| 需求 | 覆盖任务 |
|------|---------|
| Midnight dim 太暗，字体浅 | 任务 1（新增 muted，调 secondary），任务 2-5（重新分配颜色） |
| Thinking 内容完全灰色不可读 | 任务 2（dimColor → theme.muted） |
| Cockpit 面板标签灰色太浅 | 任务 3（theme.dim → theme.muted） |
| GlanceBar 数据字段灰色 | 任务 3 |
| 不影响其他主题 | 任务 1（仅改 Midnight + buildTheme 通用 muted） |
| 不影响现有功能 | 全部任务 typecheck + 测试通过 |

### 6.2 Placeholder Scan

- ✅ 无 TODO / TBD / 待定 / 后续实现 / 补充细节
- ✅ 所有代码片段均为可执行的具体实现
- ✅ 所有命令均包含预期结果

### 6.3 Type Consistency

- ✅ `RivetTheme.muted: string` — 在 theme.ts 接口定义，所有组件通过 `getTheme().muted` 访问
- ✅ `MIDNIGHT_TRUECOLOR.secondary` `#8b949e`→`#b0b8c4` — 与 `buildTheme({ muted: '#9aa2b1' })` 形成 `secondary > muted > dim` 亮度梯度
- ✅ `systemColor` 从 `colors.dim` 改为 `'#9aa2b1'` — 与 `theme.muted` 同值，语义一致

---

## 7. Execution Handoff

计划已完成并保存到 `docs/superpowers/plans/2026-05-29-midnight-theme-contrast.md`。两种执行方式：

1. **子代理驱动（推荐）** — 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. **内联执行** — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？
