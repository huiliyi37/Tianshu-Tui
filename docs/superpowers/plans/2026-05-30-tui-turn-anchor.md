# 会话 TUI turn 折叠锚点 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 每个用户请求（一个完整的 final turn）结束时，在 Static 历史里注入一条 git-log 风格的折叠锚点：相位轨迹（`⭐→🔨→⚔️`）+ 读改文件数 + 验证数 + 时长。让回看的用户像翻 git log 一样定位「哪个 turn 做了什么」。

**架构：** 新增纯函数模块 `src/tui/turn-summary.ts` 负责把 `PhaseSegment[]` + evidence 数字格式化为一行字符串。`LogEntryType` 加 `'turn_summary'`；`render-entry.tsx` 加对应渲染器（单行，复用 gutter 字形）。app.tsx 在 `onTurnComplete` 的 **final 分支**（`isFinal !== false`）用 TUI 已持有的 `chronicleRef.current.getPhaseSegments()` + `agent.getEvidenceState()` 聚合后 `pushStatic` 一条。

**技术栈：** TypeScript strict · Ink 6 · node:test + node:assert/strict · ESM（导入带 `.js`）。

**设计来源：** `docs/superpowers/specs/2026-05-30-tui-session-relayout-design.md`（Phase 2 / V3）。

---

## 前置门槛已验证（脆弱点② 消解）

设计文档脆弱点②要求「先验证 LogEntry 不污染 API messages 破坏 prefix cache」。已读真实代码确认这是**事实级安全**：

- `pushStatic`（`app.tsx:236-237`）只 `historyBufferRef.current.push(entry)` —— `historyBufferRef` 是 `RingBuffer<LogEntry>`（`app.tsx:180`），纯 TUI 状态。
- API messages 走 `session.getMessages()`，与 `historyBufferRef` 是**两套完全独立的数据流**。现有所有 `pushStatic`（system/thinking/assistant/折叠提示）都从不进入 API messages。
- turn_summary 数据源 `chronicleRef.current`（`app.tsx:217`，TUI 层已实例化，`onPhaseChange` 已在往里写）+ `agent.getEvidenceState()`（`app.tsx:661` 已用过）——全部 TUI 侧可达，无需改 `onTurnComplete` 回调签名或 main.tsx 装配。

**结论**：注入 turn_summary 零触碰 prefix cache。

## 已确认的真实接口（已读代码）

- `PhaseSegment`（`src/agent/chronicle.ts:14`）：`{ phase: StarPhase; startTurn; startTimestamp; endTurn?; endTimestamp?; entries: ChronicleEntry[] }`。
- `Chronicle.getPhaseSegments(): PhaseSegment[]`（`chronicle.ts:118`）。
- `PHASE_GLYPHS: Record<StarPhase, string>`（`star-event.ts:33`，已导出）。
- `agent.getEvidenceState()` 返回 `{ filesRead: Set<string>; filesModified: Set<string>; verifications: {status}[] }`（`evidence.ts:9-10`，`app.tsx:661` 已调用）。
- `onTurnComplete: (_usage, turnNumber, isFinal) => {...}`（`app.tsx:897`）；final 分支为 `isFinal !== false`，注入点在 `app.tsx:1031` 附近（已有多处 `pushStatic`）。
- `createLogEntry({ type, content })`（`log-state.ts:27`）。

## 文件结构

| 文件 | 职责 |
|---|---|
| 创建 `src/tui/turn-summary.ts` | 纯函数 `formatTurnSummary(input)` → 一行锚点字符串。无 React。 |
| 创建 `src/tui/__tests__/turn-summary.test.ts` | 单元测试：相位轨迹拼接、空 segments 回退、文件/验证数格式。 |
| 修改 `src/tui/log-state.ts:1` | `LogEntryType` 联合加 `'turn_summary'`。 |
| 修改 `src/tui/render-entry.tsx:15` | `RENDER_MAP` 加 `turn_summary` 渲染器（单行，gutter 风格）。 |
| 修改 `src/tui/app.tsx` `onTurnComplete` final 分支（约 `:1031`） | 聚合 chronicle + evidence，`pushStatic` 一条 turn_summary。 |

---

## 任务 1：turn-summary 格式化纯函数

**文件：**
- 创建：`src/tui/turn-summary.ts`
- 测试：`src/tui/__tests__/turn-summary.test.ts`

- [ ] **步骤 1：编写失败的测试**

写入 `src/tui/__tests__/turn-summary.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatTurnSummary } from '../turn-summary.js'
import type { PhaseSegment } from '../../agent/chronicle.js'

function seg(phase: PhaseSegment['phase']): PhaseSegment {
  return { phase, startTurn: 0, startTimestamp: 0, entries: [] }
}

describe('formatTurnSummary', () => {
  it('joins phase glyphs with arrows', () => {
    const out = formatTurnSummary({
      segments: [seg('tianshu-planning'), seg('yuheng-implementing'), seg('kaiyang-testing')],
      filesRead: 5, filesModified: 3, verifiedCount: 1, elapsedMs: 134_000,
    })
    assert.match(out, /⭐.*→.*🔨.*→.*⚔️/)
    assert.match(out, /读5 改3/)
    assert.match(out, /✓1/)
    assert.match(out, /2m14s/)
  })

  it('falls back to a marker when no segments', () => {
    const out = formatTurnSummary({ segments: [], filesRead: 0, filesModified: 0, verifiedCount: 0, elapsedMs: 1500 })
    assert.match(out, /·/) // still a single-line anchor, no crash
    assert.match(out, /1s/)
  })

  it('omits the verify token when verifiedCount is 0', () => {
    const out = formatTurnSummary({ segments: [seg('tianshu-planning')], filesRead: 1, filesModified: 0, verifiedCount: 0, elapsedMs: 2000 })
    assert.ok(!out.includes('✓'))
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/tui/__tests__/turn-summary.test.ts`
预期：FAIL，无法解析 `../turn-summary.js`。

- [ ] **步骤 3：编写最少实现代码**

写入 `src/tui/turn-summary.ts`：

```typescript
import type { PhaseSegment } from '../agent/chronicle.js'
import { PHASE_GLYPHS } from '../agent/star-event.js'

export interface TurnSummaryInput {
  segments: PhaseSegment[]
  filesRead: number
  filesModified: number
  verifiedCount: number
  elapsedMs: number
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${s % 60}s`
}

/** One-line git-log-style anchor: phase trail · files · verify · duration. */
export function formatTurnSummary(input: TurnSummaryInput): string {
  const trail = input.segments.map(s => PHASE_GLYPHS[s.phase]).join(' → ')
  const parts: string[] = []
  if (trail) parts.push(trail)
  parts.push(`读${input.filesRead} 改${input.filesModified}`)
  if (input.verifiedCount > 0) parts.push(`✓${input.verifiedCount}`)
  parts.push(fmtDuration(input.elapsedMs))
  return parts.join(' · ')
}
```

- [ ] **步骤 4：运行测试 + typecheck 验证通过**

运行：`npx tsx --test src/tui/__tests__/turn-summary.test.ts && npm run typecheck`
预期：3 个 it PASS，typecheck 无错误。

- [ ] **步骤 5：Commit**

```bash
git add src/tui/turn-summary.ts src/tui/__tests__/turn-summary.test.ts
git commit -m "feat(tui): add turn-summary formatter (phase trail + files + duration)"
```

---

## 任务 2：LogEntryType 加 turn_summary + 渲染器

**文件：**
- 修改：`src/tui/log-state.ts:1-9`
- 修改：`src/tui/render-entry.tsx:15-29`
- 测试：`src/tui/__tests__/render-entry.test.ts`（已存在，追加 memo key 断言）

- [ ] **步骤 1：编写失败的测试**

在 `src/tui/__tests__/render-entry.test.ts` 的 `describe('renderMemoKey', ...)` 块内追加：

```typescript
  it('supports turn_summary entries', () => {
    const a = createLogEntry({ type: 'turn_summary', content: '⭐ → 🔨 · 读5 改3 · 2m14s' })
    assert.ok(typeof renderMemoKey(a) === 'string')
    assert.match(renderMemoKey(a), /^turn_summary:/)
  })
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/tui/__tests__/render-entry.test.ts && npm run typecheck`
预期：typecheck FAIL —— `'turn_summary'` 不在 `LogEntryType` 联合中（`createLogEntry` 的 type 参数报错）。

- [ ] **步骤 3：编写最少实现代码**

`src/tui/log-state.ts` 第 1-9 行的联合类型加一行：

```typescript
export type LogEntryType =
  | 'user_message'
  | 'assistant_message'
  | 'thinking_message'
  | 'tool'
  | 'tool_group'
  | 'checkpoint'
  | 'evidence'
  | 'system'
  | 'turn_summary'
```

`src/tui/render-entry.tsx` 在 `RENDER_MAP`（第 15-29 行对象）的 `system` 条目后加一行（紧跟 `checkpoint` 风格，单行折叠锚点，dim+bold）：

```typescript
  turn_summary: (e) => <Box key={e.id} paddingX={2}><Text color={getTheme().dim} bold>⎯ {e.content}</Text></Box>,
```

（`Box`/`Text`/`getTheme` 已在 `render-entry.tsx:1,3` import。）

- [ ] **步骤 4：运行测试 + typecheck 验证通过**

运行：`npx tsx --test src/tui/__tests__/render-entry.test.ts && npm run typecheck`
预期：PASS，typecheck 无错误。

- [ ] **步骤 5：Commit**

```bash
git add src/tui/log-state.ts src/tui/render-entry.tsx src/tui/__tests__/render-entry.test.ts
git commit -m "feat(tui): render turn_summary anchor entries in history"
```

---

## 任务 3：onTurnComplete final 分支注入 turn_summary

**文件：**
- 修改：`src/tui/app.tsx`（`onTurnComplete` final 分支，约 `:1031` 之后、`:1039` 之前）
- 修改：`src/tui/app.tsx` 顶部 import 区

- [ ] **步骤 1：加 import**

在 `src/tui/app.tsx` 顶部 import 区（与其它 `./` 导入并列）加：

```typescript
import { formatTurnSummary } from './turn-summary.js'
```

- [ ] **步骤 2：在 final 分支注入**

在 `src/tui/app.tsx` `onTurnComplete` 内、`setCost(estimatedCost)`（约 `:1036`）之后、闭合 `}`（`:1039`）之前插入：

```typescript
        const evidence = agent.getEvidenceState()
        const turnSummary = formatTurnSummary({
          segments: chronicleRef.current.getPhaseSegments(),
          filesRead: evidence.filesRead.size,
          filesModified: evidence.filesModified.size,
          verifiedCount: evidence.verifications.filter(v => v.status === 'passed').length,
          elapsedMs: Date.now() - streamStartRef.current,
        })
        pushStatic(createLogEntry({ type: 'turn_summary', content: turnSummary }))
```

（`agent`=prop `app.tsx:84`；`chronicleRef` `:217`；`streamStartRef` 已在同分支 `:1031` 使用；`pushStatic`/`createLogEntry` 已在作用域。`evidence.verifications` 的 `status==='passed'` 判定与 `app.tsx:675` 现有用法一致。）

- [ ] **步骤 3：typecheck + 构建验证**

运行：`npm run typecheck && npm run build`
预期：typecheck 无错误，tsup 构建成功。

- [ ] **步骤 4：Commit**

```bash
git add src/tui/app.tsx
git commit -m "feat(tui): inject turn_summary anchor at final turn boundary"
```

---

## 任务 4：全量回归

**文件：** 无（仅验证）

- [ ] **步骤 1：TUI 全部测试**

运行：`npx tsx --test $(find src/tui -name '*.test.ts') > /tmp/p2-tui.txt 2>&1; grep -c "✖" /tmp/p2-tui.txt`
预期：输出 `0`（无失败标记）。注：`activity-status` 的 "transitions to testing after 2 consecutive run_tests" 是已知 flaky，与本改动无关；若它单独闪红，复跑确认。

- [ ] **步骤 2：typecheck**

运行：`npm run typecheck`
预期：无错误。

---

## 自检

**1. 设计 Phase 2 覆盖度：**
- 「每 turn 注入 git-log 式折叠锚点」→ 任务 2（渲染器）+ 任务 3（注入），且限定在 **final turn**（`isFinal !== false` 分支），避免中间 turn 淹没历史。
- 「相位轨迹 + 读改文件数 + 验证结果」→ 任务 1 `formatTurnSummary`。
- 「数据取自 chronicle.getPhaseSegments() + evidence」→ 任务 3 用 `chronicleRef.current` + `agent.getEvidenceState()`。
- 「不污染 API messages」→ 前置门槛已验证：`pushStatic` 只进 `historyBufferRef`（纯 TUI），不进 `session.getMessages()`。

**2. 占位符扫描：** 无「待定/TODO/类似任务 N」。每个代码步骤含完整代码 + 精确行号。

**3. 类型一致性：** `formatTurnSummary`/`TurnSummaryInput` 在任务 1 定义，任务 3 一致调用其字段（segments/filesRead/filesModified/verifiedCount/elapsedMs）；`'turn_summary'` 在任务 2 加入 `LogEntryType` 后，任务 2 渲染器与任务 3 `createLogEntry({ type: 'turn_summary' })` 一致引用。`PhaseSegment`/`PHASE_GLYPHS`/`getEvidenceState` 均为已读确认的现有接口。

---

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-05-30-tui-turn-anchor.md`。


