# 会话 TUI 历史区 gutter 编码 实现计划

> **状态：✅ 已全部实施** — gutter glyph 渲染

**目标：** 给 Static 历史区每类条目（user/assistant/thinking/tool/system）建立一套统一语义的单字符 gutter 字形体系，让用户上下扫历史时靠最左列符号+颜色一眼分清内容类型，无需读内容。

**架构：** 新增一个纯函数模块 `src/tui/gutter.ts`，把当前分散在各 message 组件里的 header 符号（`❯`/`●`/`▸`/`⌁`）收敛为一张 `GUTTER` 映射表（字形 + 语义色 key）。先让无边框盒的 `ThinkingMessage` 与 `SystemMessage` 消费统一字形，建立可扫的左列。不碰 user/assistant 的 round 边框盒结构，不碰 markdown 渲染（规避换行/string-width 冲突）。

**技术栈：** TypeScript strict · Ink 6 · node:test + node:assert/strict · ESM（导入带 `.js` 扩展）。

**设计来源：** `docs/superpowers/specs/2026-05-30-tui-session-relayout-design.md`（Phase 1）。本计划只覆盖该设计的 Phase 1（V2 历史内容编码的最小验证）。Phase 2（turn 锚点）/ Phase 3（底部双行状态条）见文末「后续计划」。

---

## 现状（已读真实代码）

各条目当前的 header 符号分散、不成体系（`src/tui/`）：

| 条目 | 组件 | 当前符号 | 形态 |
|---|---|---|---|
| user | `user-message.tsx:15` | `❯` + `You` | round 边框盒 + header |
| assistant | `assistant-message.tsx:36` | `●` + `Assistant` | round 边框盒 + header |
| thinking | `thinking-message.tsx:57,82` | `▸ Thinking` | 无盒，`theme.muted` |
| system | `system-message.tsx:15` | `⌁` + content | 无盒，`theme.muted`/`error` |
| tool | `tool-card.tsx:56` | 加粗工具名（无前缀字形） | 无盒，`theme.toolColor` |

`getTheme()`（`theme.ts:199`）返回函数式主题，语义色字段：`primary/secondary/success/warning/error/dim/muted/userColor/assistantColor/systemColor/toolColor(name)`。

`render-entry.tsx` 的 `RENDER_MAP` 按 `LogEntry.type` 分发；已有测试 `src/tui/__tests__/render-entry.test.ts` 只测 `renderMemoKey`。

## 文件结构

| 文件 | 职责 |
|---|---|
| 创建 `src/tui/gutter.ts` | 单一职责：导出 `GutterKind` 类型、`GUTTER` 字形+色 key 映射表、`gutterGlyph(kind)` 纯函数。无 React、无副作用。 |
| 创建 `src/tui/__tests__/gutter.test.ts` | 单元测试 `gutterGlyph` 对每个 kind 返回正确字形，未知 kind 返回回退。 |
| 修改 `src/tui/thinking-message.tsx:57,82` | 用 `gutterGlyph('thinking')` 替换硬编码 `▸`，建立统一左列。 |
| 修改 `src/tui/system-message.tsx:15` | 用 `gutterGlyph('system')` 替换硬编码 `⌁`。 |

---

## 任务 1：gutter 字形模块

**文件：**
- 创建：`src/tui/gutter.ts`
- 测试：`src/tui/__tests__/gutter.test.ts`

- [ ] **步骤 1：编写失败的测试**

写入 `src/tui/__tests__/gutter.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { gutterGlyph, GUTTER, type GutterKind } from '../gutter.js'

describe('gutterGlyph', () => {
  it('returns a distinct glyph for each known kind', () => {
    const kinds: GutterKind[] = ['user', 'assistant', 'thinking', 'tool', 'system']
    const glyphs = kinds.map(gutterGlyph)
    assert.equal(new Set(glyphs).size, glyphs.length) // all distinct
  })

  it('maps known kinds to their table entry', () => {
    assert.equal(gutterGlyph('user'), GUTTER.user.glyph)
    assert.equal(gutterGlyph('thinking'), GUTTER.thinking.glyph)
    assert.equal(gutterGlyph('system'), GUTTER.system.glyph)
  })

  it('falls back to the system glyph for an unknown kind', () => {
    assert.equal(gutterGlyph('nope' as GutterKind), GUTTER.system.glyph)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/tui/__tests__/gutter.test.ts`
预期：FAIL，报错无法解析 `../gutter.js`（模块不存在）。

- [ ] **步骤 3：编写最少实现代码**

写入 `src/tui/gutter.ts`：

```typescript
import type { RivetTheme } from './theme.js'

export type GutterKind = 'user' | 'assistant' | 'thinking' | 'tool' | 'system'

/** Single-char gutter glyph + the theme color key used to render it. */
export const GUTTER: Record<GutterKind, { glyph: string; colorKey: keyof RivetTheme }> = {
  user: { glyph: '❯', colorKey: 'userColor' },
  assistant: { glyph: '●', colorKey: 'assistantColor' },
  thinking: { glyph: '◦', colorKey: 'muted' },
  tool: { glyph: '▸', colorKey: 'primary' },
  system: { glyph: '⌁', colorKey: 'systemColor' },
}

export function gutterGlyph(kind: GutterKind): string {
  return (GUTTER[kind] ?? GUTTER.system).glyph
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/tui/__tests__/gutter.test.ts`
预期：PASS（3 个 it 全过）。

- [ ] **步骤 5：typecheck**

运行：`npm run typecheck`
预期：无错误（`keyof RivetTheme` 约束 `colorKey` 合法）。

- [ ] **步骤 6：Commit**

```bash
git add src/tui/gutter.ts src/tui/__tests__/gutter.test.ts
git commit -m "feat(tui): add unified gutter glyph table for history entries"
```

---

## 任务 2：thinking 条目消费统一 gutter

**文件：**
- 修改：`src/tui/thinking-message.tsx:57` 与 `:82`（两处 `▸ Thinking` header）
- 测试：`src/tui/__tests__/gutter.test.ts`（同文件追加断言，验证 thinking glyph 不再是旧的 `▸`）

- [ ] **步骤 1：编写失败的测试**

在 `src/tui/__tests__/gutter.test.ts` 的 `describe('gutterGlyph', ...)` 块内追加：

```typescript
  it('thinking uses ◦ (distinct from the legacy ▸ now owned by tool)', () => {
    assert.equal(gutterGlyph('thinking'), '◦')
    assert.equal(gutterGlyph('tool'), '▸')
  })
```

- [ ] **步骤 2：运行测试验证通过（回归基线）**

运行：`npx tsx --test src/tui/__tests__/gutter.test.ts`
预期：PASS（任务 1 的 GUTTER 表已满足此断言；此步锁定字形契约，确保任务 2 改组件时不改字形）。

- [ ] **步骤 3：编写最少实现代码**

在 `src/tui/thinking-message.tsx` 顶部 import 区加：

```typescript
import { gutterGlyph } from './gutter.js'
```

将 `:57` 行：

```typescript
        <Text color={theme.muted}>▸ Thinking ({formatThinkingSize(content.length)})</Text>
```

改为：

```typescript
        <Text color={theme.muted}>{gutterGlyph('thinking')} Thinking ({formatThinkingSize(content.length)})</Text>
```

将 `:82` 行：

```typescript
        <Text color={theme.muted}>▸ Thinking ({formatThinkingSize(content.length)}, {omitted} earlier lines omitted)</Text>
```

改为：

```typescript
        <Text color={theme.muted}>{gutterGlyph('thinking')} Thinking ({formatThinkingSize(content.length)}, {omitted} earlier lines omitted)</Text>
```

- [ ] **步骤 4：运行测试 + typecheck 验证通过**

运行：`npx tsx --test src/tui/__tests__/gutter.test.ts && npm run typecheck`
预期：测试 PASS，typecheck 无错误。

- [ ] **步骤 5：Commit**

```bash
git add src/tui/thinking-message.tsx src/tui/__tests__/gutter.test.ts
git commit -m "feat(tui): thinking entries consume unified gutter glyph"
```

---

## 任务 3：system 条目消费统一 gutter

**文件：**
- 修改：`src/tui/system-message.tsx:15`
- 测试：`src/tui/__tests__/system-message.test.ts`（已存在，追加一条断言其使用 GUTTER.system.glyph）

- [ ] **步骤 1：读现有测试确认约定**

运行：`npx tsx --test src/tui/__tests__/system-message.test.ts`
预期：PASS（建立基线，确认现有 system-message 测试通过后再改）。

- [ ] **步骤 2：编写最少实现代码**

在 `src/tui/system-message.tsx` 顶部 import 区加：

```typescript
import { gutterGlyph } from './gutter.js'
```

将 `:15` 行：

```typescript
      <Text color={!isError ? theme.muted : color}>{'⌁'} {content}</Text>
```

改为：

```typescript
      <Text color={!isError ? theme.muted : color}>{gutterGlyph('system')} {content}</Text>
```

- [ ] **步骤 3：运行测试 + typecheck 验证通过**

运行：`npx tsx --test src/tui/__tests__/system-message.test.ts && npm run typecheck`
预期：PASS（`gutterGlyph('system')` 返回 `⌁`，渲染输出不变；typecheck 无错误）。

- [ ] **步骤 4：Commit**

```bash
git add src/tui/system-message.tsx
git commit -m "refactor(tui): system entries consume unified gutter glyph"
```

---

## 任务 4：全量回归

**文件：** 无（仅验证）

- [ ] **步骤 1：跑 TUI 全部测试**

运行：`npx tsx --test $(find src/tui -name '*.test.ts')`
预期：全 PASS（确认 gutter 改动未回归 render-entry / thinking / system / glance-bar 等）。

- [ ] **步骤 2：跑全量 typecheck**

运行：`npm run typecheck`
预期：无错误。

- [ ] **步骤 3：构建确认**

运行：`npm run build`
预期：tsup 构建成功，无报错。

---

## 后续计划（不在本计划范围）

本计划只交付设计文档 Phase 1 的最小验证：建立统一 gutter 字形体系 + 让无边框盒条目（thinking/system）消费它。user/assistant 已有 round 边框盒+header（`❯ You`/`● Assistant`），其字形已纳入 `GUTTER` 表作为单一字形源，但本计划不改其盒结构——是否进一步统一留待视觉验证后决定。

- **Phase 2（V3 turn 结构锚点）** — 独立计划：在 `loop.ts` turn 边界 `pushStatic` 一条 `type='turn_summary'` 的 `LogEntry`，数据取自 `chronicle.getPhaseSegments()`（`src/agent/chronicle.ts:118`）+ evidence。**前置门槛**：必须先验证 `LogEntry` 严格停留在 TUI 层、不进入 `session.getMessages()`（即不污染 API messages 破坏 prefix cache）——这是它自己的脆弱点，故单开计划。
- **Phase 3（V1 底部双行状态条）** — 独立计划：`glance-bar.tsx` 下加第二行 contextual footer，接 `fluency-policy.ts` 的 `PHASE_STALE_TIERS`（info/warn/action 三级）+ 按终端 rows 降级。

## 自检

**1. 设计 Phase 1 覆盖度：**
- 「gutter 前缀列 + 语义色」→ 任务 1（`GUTTER` 表 + `gutterGlyph`）。
- 「thinking 改 gutter」→ 任务 2。「system 改 gutter」→ 任务 3。
- 「不碰 markdown 渲染、规避换行/string-width 冲突」→ 本计划只改 header 行的单字符，不进入 `Markdown` 组件或 `countPhysicalLines` 路径，已规避脆弱点①。
- 「窄终端不挤断」→ 单字符替换不增加宽度（`▸`→`◦`、`⌁`→`⌁` 均为单 cell），任务 4 全量回归覆盖。

**2. 占位符扫描：** 无「待定/TODO/类似任务 N」。每个代码步骤均有完整代码块与精确行号。

**3. 类型一致性：** `GutterKind`、`GUTTER`、`gutterGlyph` 在任务 1 定义，任务 2/3 一致引用 `gutterGlyph('thinking')`/`gutterGlyph('system')`；`colorKey` 用 `keyof RivetTheme` 与 `theme.ts:3` 的 `RivetTheme` 接口对齐。`createLogEntry` 等未改动，无新增类型引用悬空。

---

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-05-30-tui-history-gutter.md`。


