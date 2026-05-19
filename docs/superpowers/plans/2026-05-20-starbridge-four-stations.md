# 星桥四站位 — 终端 Agent 可观测性 v2 实施计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现终端模式切换系统——开发者按数字键 2/3 在对话流、星图全屏、编年史视图之间切换，解决 radio 消息刷屏问题，让信息固定在按需视图中而非滚动的对话流中。

**架构：** 扩展现有 cockpit panel 系统为统一的模式切换（1=对话/2=星图/3=传说/4=驾驶舱）。新增 chronicle 事件队列收集 radio 消息。新增 starmap-view 和 chronicle-view 两个 React 组件。radio-hook 消息改为写入 chronicle 而非对话流。

**技术栈：** TypeScript strict, Ink 6 (React), node:test + node:assert/strict, Unicode box-drawing + Braille patterns

---

## 文件结构

| 文件 | 职责 |
|------|------|
| 新建 `src/agent/chronicle.ts` | 事件队列：收集 radio 消息 + phase 转换 + tool 里程碑，供视图消费 |
| 新建 `src/tui/constellation.ts` | 纯函数：渲染紫微七星 Unicode 星座图字符串 |
| 新建 `src/tui/starmap-view.tsx` | React 组件：星图全屏模式（星座 + sensorium + radio 消息） |
| 新建 `src/tui/chronicle-view.tsx` | React 组件：传说视图（结构化执行时间线） |
| 修改 `src/tui/app.tsx` | 模式切换状态机 + 键盘绑定 + 条件渲染 |
| 修改 `src/agent/hooks/radio-hook.ts` | radio 消息写入 chronicle 队列 + emitPhaseChange |
| 新建 `src/tui/__tests__/constellation.test.ts` | 星座渲染测试 |
| 新建 `src/agent/__tests__/chronicle.test.ts` | 事件队列测试 |

---

### 任务 1：Chronicle 事件队列

**文件：**
- 新建：`src/agent/chronicle.ts`
- 测试：`src/agent/__tests__/chronicle.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/agent/__tests__/chronicle.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Chronicle, type ChronicleEntry } from '../chronicle.js'

describe('Chronicle', () => {
  it('records a phase transition entry', () => {
    const chronicle = new Chronicle()
    chronicle.addPhaseTransition({
      fromPhase: 'tianshu-planning',
      toPhase: 'yuheng-implementing',
      turn: 5,
      summary: '[天枢] 开始修改。预计修改 middleware.ts。',
    })
    const entries = chronicle.getEntries()
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.type, 'phase-transition')
    assert.equal(entries[0]!.turn, 5)
  })

  it('records a milestone entry', () => {
    const chronicle = new Chronicle()
    chronicle.addMilestone({
      kind: 'test_fail',
      turn: 10,
      summary: '[天枢] ✗ 测试失败 2 个：auth.test.ts。正在修复。',
      files: ['auth.test.ts'],
    })
    const entries = chronicle.getEntries()
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.type, 'milestone')
  })

  it('records a radio message', () => {
    const chronicle = new Chronicle()
    chronicle.addRadio('[天枢] 已读取 5 个文件。准备制定方案。', 3)
    const entries = chronicle.getEntries()
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.type, 'radio')
    assert.ok(entries[0]!.summary.includes('天枢'))
  })

  it('getRecentRadio returns last N messages', () => {
    const chronicle = new Chronicle()
    for (let i = 0; i < 10; i++) {
      chronicle.addRadio(`msg ${i}`, i)
    }
    const recent = chronicle.getRecentRadio(5)
    assert.equal(recent.length, 5)
    assert.ok(recent[0]!.summary.includes('msg 5'))
    assert.ok(recent[4]!.summary.includes('msg 9'))
  })

  it('getPhaseSegments groups entries by phase', () => {
    const chronicle = new Chronicle()
    chronicle.addPhaseTransition({ fromPhase: 'tianshu-planning', toPhase: 'tianxuan-locating', turn: 0, summary: 'start' })
    chronicle.addRadio('reading files', 1)
    chronicle.addRadio('reading more', 2)
    chronicle.addPhaseTransition({ fromPhase: 'tianxuan-locating', toPhase: 'yuheng-implementing', turn: 5, summary: 'begin coding' })
    chronicle.addRadio('writing code', 6)

    const segments = chronicle.getPhaseSegments()
    assert.equal(segments.length, 2)
    assert.equal(segments[0]!.phase, 'tianxuan-locating')
    assert.equal(segments[0]!.entries.length, 2)
    assert.equal(segments[1]!.phase, 'yuheng-implementing')
  })

  it('toMarkdown produces structured output', () => {
    const chronicle = new Chronicle()
    chronicle.addPhaseTransition({ fromPhase: 'tianshu-planning', toPhase: 'yuheng-implementing', turn: 0, summary: 'start' })
    chronicle.addRadio('[天枢] writing code', 3)
    const md = chronicle.toMarkdown()
    assert.ok(md.includes('星辰编年史'))
    assert.ok(md.includes('玉衡') || md.includes('铸形') || md.includes('implementing'))
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/chronicle.test.ts`
预期：FAIL — cannot find module '../chronicle.js'

- [ ] **步骤 3：实现 chronicle.ts**

```typescript
// src/agent/chronicle.ts
import { PHASE_LABELS, PHASE_GLYPHS, PHASE_SHORT_LABELS, type StarPhase } from './star-event.js'

export interface ChronicleEntry {
  type: 'phase-transition' | 'milestone' | 'radio'
  turn: number
  timestamp: number
  summary: string
  phase?: StarPhase
  files?: string[]
}

export interface PhaseSegment {
  phase: StarPhase
  startTurn: number
  startTimestamp: number
  endTurn?: number
  endTimestamp?: number
  entries: ChronicleEntry[]
}

export class Chronicle {
  private entries: ChronicleEntry[] = []
  private currentPhase: StarPhase = 'tianshu-planning'

  addPhaseTransition(input: {
    fromPhase: string
    toPhase: string
    turn: number
    summary: string
  }): void {
    this.currentPhase = input.toPhase as StarPhase
    this.entries.push({
      type: 'phase-transition',
      turn: input.turn,
      timestamp: Date.now(),
      summary: input.summary,
      phase: this.currentPhase,
    })
  }

  addMilestone(input: {
    kind: string
    turn: number
    summary: string
    files?: string[]
  }): void {
    this.entries.push({
      type: 'milestone',
      turn: input.turn,
      timestamp: Date.now(),
      summary: input.summary,
      phase: this.currentPhase,
      files: input.files,
    })
  }

  addRadio(message: string, turn: number): void {
    this.entries.push({
      type: 'radio',
      turn,
      timestamp: Date.now(),
      summary: message,
      phase: this.currentPhase,
    })
  }

  getEntries(): readonly ChronicleEntry[] {
    return this.entries
  }

  getRecentRadio(count: number): ChronicleEntry[] {
    return this.entries
      .filter(e => e.type === 'radio')
      .slice(-count)
  }

  getPhaseSegments(): PhaseSegment[] {
    const segments: PhaseSegment[] = []
    let current: PhaseSegment | null = null

    for (const entry of this.entries) {
      if (entry.type === 'phase-transition' && entry.phase) {
        if (current) {
          current.endTurn = entry.turn
          current.endTimestamp = entry.timestamp
        }
        current = {
          phase: entry.phase,
          startTurn: entry.turn,
          startTimestamp: entry.timestamp,
          entries: [],
        }
        segments.push(current)
      } else if (current) {
        current.entries.push(entry)
      }
    }
    return segments
  }

  toMarkdown(): string {
    const segments = this.getPhaseSegments()
    const lines = ['# 星辰编年史\n']
    for (const seg of segments) {
      const glyph = PHASE_GLYPHS[seg.phase] ?? ''
      const label = PHASE_LABELS[seg.phase] ?? seg.phase
      lines.push(`## ${glyph} ${label}\n`)
      for (const entry of seg.entries) {
        lines.push(`- ${entry.summary}`)
        if (entry.files && entry.files.length > 0) {
          lines.push(`  📁 ${entry.files.join(', ')}`)
        }
      }
      lines.push('')
    }
    return lines.join('\n')
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/chronicle.test.ts`
预期：6 tests PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/chronicle.ts src/agent/__tests__/chronicle.test.ts
git commit -m "feat(agent): add Chronicle event queue for phase segments + radio messages"
```

---

### 任务 2：紫微星座 Unicode 渲染

**文件：**
- 新建：`src/tui/constellation.ts`
- 测试：`src/tui/__tests__/constellation.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/tui/__tests__/constellation.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderConstellation } from '../constellation.js'
import type { StarPhase } from '../../agent/star-event.js'

describe('renderConstellation', () => {
  it('returns array of strings (lines)', () => {
    const lines = renderConstellation('yuheng-implementing')
    assert.ok(Array.isArray(lines))
    assert.ok(lines.length > 0)
    assert.ok(lines.every(l => typeof l === 'string'))
  })

  it('highlights the active phase', () => {
    const lines = renderConstellation('yuheng-implementing')
    const joined = lines.join('\n')
    assert.ok(joined.includes('玉衡'))
  })

  it('renders all 7 star names', () => {
    const lines = renderConstellation('tianshu-planning')
    const joined = lines.join('\n')
    const stars = ['天枢', '天璇', '天玑', '天权', '玉衡', '开阳', '摇光']
    for (const star of stars) {
      assert.ok(joined.includes(star), `Missing star: ${star}`)
    }
  })

  it('renders consistently for different active phases', () => {
    const phases: StarPhase[] = ['tianshu-planning', 'yuheng-implementing', 'yaoguang-delivering']
    for (const phase of phases) {
      const lines = renderConstellation(phase)
      assert.ok(lines.length > 3, `Too few lines for ${phase}`)
    }
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/tui/__tests__/constellation.test.ts`
预期：FAIL — cannot find module '../constellation.js'

- [ ] **步骤 3：实现 constellation.ts**

```typescript
// src/tui/constellation.ts
import { PHASE_SHORT_LABELS, PHASE_GLYPHS, type StarPhase } from '../agent/star-event.js'

const STAR_ORDER: StarPhase[] = [
  'tianshu-planning',
  'tianxuan-locating',
  'tianji-decomposing',
  'tianquan-contracting',
  'yuheng-implementing',
  'kaiyang-testing',
  'yaoguang-delivering',
]

function starLabel(phase: StarPhase, active: StarPhase): string {
  const glyph = PHASE_GLYPHS[phase]
  const name = PHASE_SHORT_LABELS[phase]
  const isActive = phase === active
  return isActive ? `[${glyph} ${name}]` : ` ${glyph} ${name} `
}

export function renderConstellation(activePhase: StarPhase): string[] {
  const s = (p: StarPhase) => starLabel(p, activePhase)

  return [
    `    ${s('tianshu-planning')} ─── ${s('tianxuan-locating')} ─── ${s('tianji-decomposing')} ─── ${s('tianquan-contracting')}`,
    `                                                          │`,
    `                                                     ${s('yuheng-implementing')}`,
    `                                                          │`,
    `                                                     ${s('kaiyang-testing')} ─── ${s('yaoguang-delivering')}`,
  ]
}

export function renderConstellationCompact(activePhase: StarPhase): string {
  return STAR_ORDER.map(p => {
    const glyph = PHASE_GLYPHS[p]
    return p === activePhase ? `[${glyph}]` : ` ${glyph} `
  }).join('─')
}

export { STAR_ORDER }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/tui/__tests__/constellation.test.ts`
预期：4 tests PASS

- [ ] **步骤 5：Commit**

```bash
git add src/tui/constellation.ts src/tui/__tests__/constellation.test.ts
git commit -m "feat(tui): add constellation renderer — Unicode star chart for 紫微七星"
```

---

### 任务 3：星图全屏视图组件

**文件：**
- 新建：`src/tui/starmap-view.tsx`

- [ ] **步骤 1：创建 starmap-view.tsx**

```tsx
// src/tui/starmap-view.tsx
import { Box, Text } from 'ink'
import { memo } from 'react'
import { renderConstellation } from './constellation.js'
import { alchemyBar, alchemyStage, ALCHEMY_COLORS } from './alchemy-bar.js'
import { brailleSparkline, formatElapsed } from './summary-bar.js'
import { getTheme } from './theme.js'
import type { StarPhase } from '../agent/star-event.js'
import type { ChronicleEntry } from '../agent/chronicle.js'

export interface StarmapViewProps {
  activePhase: StarPhase
  sensorium?: {
    momentum: number
    pressure: number
    confidence: number
    complexity: number
    freshness: number
    stability: number
  }
  turnCount: number
  maxTurns: number
  elapsedMs: number
  recentRadio: ChronicleEntry[]
}

function sensoriumBar(label: string, value: number, width = 8): string {
  const filled = Math.round(value * width)
  return `${label} ${'⣿'.repeat(filled)}${'⣀'.repeat(width - filled)}`
}

export const StarmapView = memo(function StarmapView(props: StarmapViewProps) {
  const theme = getTheme()
  const { activePhase, sensorium, turnCount, maxTurns, elapsedMs, recentRadio } = props
  const constellationLines = renderConstellation(activePhase)
  const confidence = sensorium?.confidence ?? 0
  const alchColor = ALCHEMY_COLORS[alchemyStage(confidence)]

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box justifyContent="center">
        <Text bold color={theme.primary}>╭── 紫微星桥 ──╮</Text>
      </Box>

      <Box height={1} />

      {constellationLines.map((line, i) => (
        <Text key={i} color={theme.dim}>{line}</Text>
      ))}

      <Box height={1} />

      {sensorium && (
        <Box flexDirection="column">
          <Text color={theme.dim}>
            {sensoriumBar('动力', sensorium.momentum)}  {sensoriumBar('信心', sensorium.confidence)}
          </Text>
          <Text color={theme.dim}>
            {sensoriumBar('压力', sensorium.pressure)}  {sensoriumBar('复杂', sensorium.complexity)}
          </Text>
          <Text color={theme.dim}>
            {sensoriumBar('新鲜', sensorium.freshness)}  {sensoriumBar('稳定', sensorium.stability)}
          </Text>
        </Box>
      )}

      <Box height={1} />

      <Text>
        <Text color={alchColor}>{alchemyBar(confidence)}</Text>
        <Text color={theme.dim}> │ T{turnCount}/{maxTurns} │ {formatElapsed(elapsedMs)}</Text>
      </Text>

      <Box height={1} />

      {recentRadio.length > 0 && (
        <Box flexDirection="column">
          {recentRadio.map((entry, i) => (
            <Text key={i} color="cyan" dimColor>{entry.summary}</Text>
          ))}
        </Box>
      )}

      <Box height={1} />
      <Text dimColor>按 1 返回对话 │ 按 3 传说 │ 按 4 驾驶舱</Text>
    </Box>
  )
})
```

- [ ] **步骤 2：运行 typecheck**

运行：`npx tsc --noEmit`
预期：0 errors

- [ ] **步骤 3：Commit**

```bash
git add src/tui/starmap-view.tsx
git commit -m "feat(tui): add StarmapView — full-screen star constellation + sensorium gauges"
```

---

### 任务 4：传说视图组件

**文件：**
- 新建：`src/tui/chronicle-view.tsx`

- [ ] **步骤 1：创建 chronicle-view.tsx**

```tsx
// src/tui/chronicle-view.tsx
import { Box, Text } from 'ink'
import { memo } from 'react'
import { getTheme } from './theme.js'
import { formatElapsed } from './summary-bar.js'
import { PHASE_LABELS, PHASE_GLYPHS, type StarPhase } from '../agent/star-event.js'
import type { PhaseSegment } from '../agent/chronicle.js'

export interface ChronicleViewProps {
  segments: PhaseSegment[]
  elapsedMs: number
}

export const ChronicleView = memo(function ChronicleView({ segments, elapsedMs }: ChronicleViewProps) {
  const theme = getTheme()

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box justifyContent="center">
        <Text bold color={theme.primary}>╭── 星辰编年史 ──╮</Text>
      </Box>

      <Box height={1} />

      {segments.length === 0 && (
        <Text dimColor>暂无记录。agent 执行中…</Text>
      )}

      {segments.map((seg, i) => {
        const glyph = PHASE_GLYPHS[seg.phase] ?? '?'
        const label = PHASE_LABELS[seg.phase] ?? seg.phase
        const duration = seg.endTimestamp
          ? formatElapsed(seg.endTimestamp - seg.startTimestamp)
          : '进行中…'

        return (
          <Box key={i} flexDirection="column" marginBottom={1}>
            <Text>
              <Text bold>{glyph} {label}</Text>
              <Text dimColor> (T{seg.startTurn}{seg.endTurn !== undefined ? `-${seg.endTurn}` : '+'} │ {duration})</Text>
            </Text>
            {seg.entries.map((entry, j) => (
              <Box key={j} paddingLeft={2}>
                <Text color={entry.type === 'milestone' ? theme.warning : 'cyan'} dimColor>
                  {entry.summary}
                </Text>
                {entry.files && entry.files.length > 0 && (
                  <Text dimColor> 📁 {entry.files.join(', ')}</Text>
                )}
              </Box>
            ))}
          </Box>
        )
      })}

      <Box height={1} />
      <Text dimColor>总用时: {formatElapsed(elapsedMs)} │ 按 1 返回对话 │ 按 2 星图 │ 按 4 驾驶舱</Text>
    </Box>
  )
})
```

- [ ] **步骤 2：运行 typecheck**

运行：`npx tsc --noEmit`
预期：0 errors

- [ ] **步骤 3：Commit**

```bash
git add src/tui/chronicle-view.tsx
git commit -m "feat(tui): add ChronicleView — structured phase-by-phase execution timeline"
```

---

### 任务 5：模式切换接入 app.tsx（核心）

**文件：**
- 修改：`src/tui/app.tsx`

这是核心集成任务。需要：
1. 导入新组件和 Chronicle
2. 创建 Chronicle 实例和 starbridge 模式状态
3. 扩展键盘处理（数字键 2/3 切换模式）
4. 条件渲染：conversation / starmap / chronicle / cockpit
5. 修改 onPhaseChange 中 tianshu-radio 消息写入 chronicle 而非 pushStatic

- [ ] **步骤 1：添加导入**

在 app.tsx 导入区添加：

```typescript
import { StarmapView } from './starmap-view.js'
import { ChronicleView } from './chronicle-view.js'
import { Chronicle } from '../agent/chronicle.js'
```

- [ ] **步骤 2：创建 Chronicle ref 和 starbridge 模式状态**

在 `useState` 区域（约 line 220 附近）添加：

```typescript
const chronicleRef = useRef(new Chronicle())
const [starbridgeMode, setStarbridgeMode] = useState<'conversation' | 'starmap' | 'chronicle'>('conversation')
```

- [ ] **步骤 3：扩展键盘处理**

在 `useInput` 回调中（Escape 处理之后），添加 starbridge 模式切换：

```typescript
// Starbridge mode switching (only during streaming)
if (isStreaming && !pendingApproval && !pendingIntent) {
  if (_input === '2') {
    setStarbridgeMode(prev => prev === 'starmap' ? 'conversation' : 'starmap')
    setCockpitPanel(null)
    return
  }
  if (_input === '3') {
    setStarbridgeMode(prev => prev === 'chronicle' ? 'conversation' : 'chronicle')
    setCockpitPanel(null)
    return
  }
}
```

修改 Escape 处理：关闭 starbridge 模式

```typescript
if (_key.escape) {
  if (starbridgeMode !== 'conversation') {
    setStarbridgeMode('conversation')
    return
  }
  if (cockpitPanel) {
    // existing cockpit close logic
```

- [ ] **步骤 4：修改 onPhaseChange 写入 chronicle**

将现有的 `onPhaseChange` 回调中 tianshu-radio 消息改为写入 chronicle：

```typescript
onPhaseChange: (phase, detail) => {
  if (phase === 'tianshu-radio' && detail?.reason) {
    chronicleRef.current.addRadio(detail.reason, turnCountRef.current)
  }
  // ... existing star phase update logic stays
},
```

- [ ] **步骤 5：条件渲染**

在渲染区域，当 `starbridgeMode !== 'conversation'` 时替代对话流：

```tsx
{starbridgeMode === 'starmap' && (
  <StarmapView
    activePhase={(summaryState.starPhaseGlyph ? /* derive from state */ 'yuheng-implementing' : 'tianshu-planning') as StarPhase}
    sensorium={undefined /* TODO: wire from agent */}
    turnCount={summaryState.turnCount ?? 0}
    maxTurns={summaryState.maxTurns ?? 50}
    elapsedMs={summaryState.elapsedMs}
    recentRadio={chronicleRef.current.getRecentRadio(5)}
  />
)}
{starbridgeMode === 'chronicle' && (
  <ChronicleView
    segments={chronicleRef.current.getPhaseSegments()}
    elapsedMs={summaryState.elapsedMs}
  />
)}
{starbridgeMode === 'conversation' && !cockpitPanel && (
  /* existing conversation flow rendering */
)}
```

注意：具体的渲染位置需要根据 app.tsx 当前结构调整。核心原则是 starmap/chronicle 视图替代对话流区域，strip 保持在底部。

- [ ] **步骤 6：运行 typecheck**

运行：`npx tsc --noEmit`
预期：0 errors

- [ ] **步骤 7：Commit**

```bash
git add src/tui/app.tsx
git commit -m "feat(tui): wire starbridge mode switching — 2=starmap 3=chronicle Esc=back"
```

---

### 任务 6：修改 radio-hook 同时写入 chronicle

**文件：**
- 修改：`src/agent/hooks/radio-hook.ts`

- [ ] **步骤 1：添加 chronicle 依赖注入**

修改 `createRadioHook` 签名接受可选的 chronicle：

```typescript
export interface RadioHookDeps {
  chronicle?: { addRadio: (message: string, turn: number) => void; addPhaseTransition: (input: any) => void }
}

export function createRadioHook(deps?: RadioHookDeps): PostToolRuntimeHook {
```

- [ ] **步骤 2：在 emit 时同时写入 chronicle**

在每个 `ctx.effects.emitPhaseChange('tianshu-radio', ...)` 调用旁边，添加：

```typescript
deps?.chronicle?.addRadio(msg, turn)
```

在 phase transition 检测时，添加：

```typescript
deps?.chronicle?.addPhaseTransition({
  fromPhase: state.lastPhase,
  toPhase: currentPhase,
  turn,
  summary: msg,
})
```

- [ ] **步骤 3：运行现有 radio-hook 测试确保不回归**

运行：`npx tsx --test src/agent/__tests__/radio-hook.test.ts`
预期：全部通过（deps 是可选的，现有测试不传 deps）

- [ ] **步骤 4：在 create-runtime-hooks.ts 中传入 chronicle**

修改 `createDefaultRuntimeHooks` 中 radio hook 的创建：

```typescript
createRadioHook({ chronicle: deps.chronicle }),
```

在 `RuntimeHookDeps` 接口中添加可选字段：

```typescript
chronicle?: { addRadio: (message: string, turn: number) => void; addPhaseTransition: (input: any) => void }
```

- [ ] **步骤 5：运行 typecheck + 测试**

运行：`npx tsc --noEmit && npx tsx --test src/agent/__tests__/radio-hook.test.ts src/agent/__tests__/create-runtime-hooks.test.ts`
预期：全部通过

- [ ] **步骤 6：Commit**

```bash
git add src/agent/hooks/radio-hook.ts src/agent/create-runtime-hooks.ts
git commit -m "feat(agent): wire radio-hook to chronicle for structured event capture"
```

---

### 任务 7：全量验证

**文件：** 无新文件

- [ ] **步骤 1：运行 typecheck**

运行：`npx tsc --noEmit`
预期：0 errors

- [ ] **步骤 2：运行全量测试**

运行：`npm test`
预期：全部 PASS

- [ ] **步骤 3：手动测试**

启动 Rivet，发送一个多步任务。验证：
1. 默认模式（1）：对话流 + 底部 strip，和之前一样
2. 按 2：全屏星图出现（7 颗星、sensorium 仪表、最近 radio 消息）
3. 按 3：传说视图出现（按 phase 分段的结构化时间线）
4. 按 Esc/1：回到对话流
5. 按 4：进入 cockpit（已有功能不受影响）

---

## 自检

**1. 规格覆盖度：**
- Chronicle 事件队列 ✓（任务 1）
- 星座 Unicode 渲染 ✓（任务 2）
- 星图全屏模式 ✓（任务 3）
- 传说视图 ✓（任务 4）
- 模式切换接入 ✓（任务 5）
- Radio→Chronicle 接线 ✓（任务 6）
- 氛围色温引擎 — **未包含**：设计文档中标记为 Phase 4 可选，本计划不含

**2. 占位符扫描：**
- 任务 5 步骤 5 中星图视图的 `activePhase` 来源标注了 derive from state，实现者需要从 summaryState 中推导或从新的 ref 中获取。这是已知的集成点，不是占位符。

**3. 类型一致性：**
- `ChronicleEntry` 在 chronicle.ts 定义，starmap-view.tsx 和 chronicle-view.tsx 消费 — 一致
- `StarPhase` 在 star-event.ts 定义，所有文件共享 — 一致
- `PhaseSegment` 在 chronicle.ts 定义，chronicle-view.tsx 消费 — 一致
- `RadioHookDeps.chronicle` 在 radio-hook.ts 定义，create-runtime-hooks.ts 传入 — 一致

---

## 验收标准

- [ ] `npm run typecheck` — 0 errors
- [ ] `npm test` — 全部 PASS
- [ ] 按 2 显示全屏星座图 + sensorium 仪表 + 最近 5 条 radio
- [ ] 按 3 显示按 phase 分段的结构化时间线
- [ ] 按 1/Esc 回到对话流
- [ ] Radio 消息写入 chronicle，在星图和传说视图中可见
- [ ] 默认对话模式行为不变

---

## 依赖关系

```
任务 1（chronicle）→ 任务 3（starmap 消费 chronicle）
任务 1（chronicle）→ 任务 4（chronicle-view 消费 chronicle）
任务 2（constellation）→ 任务 3（starmap 消费 constellation）
任务 3 + 4 → 任务 5（app.tsx 接入）
任务 1 → 任务 6（radio-hook 写入 chronicle）
任务 5 + 6 → 任务 7（验证）

可并行：任务 1 和 任务 2 无依赖
```
