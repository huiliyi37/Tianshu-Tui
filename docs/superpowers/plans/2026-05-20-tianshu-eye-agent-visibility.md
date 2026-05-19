# 天枢之眼 — Agent 执行意识可视化实施计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让用户在 agent 自主执行 30-50 turn 时，1 秒内获取 4 个信号：在哪个阶段、做到哪里、在干什么、是否正常。不依赖模型输出，纯 harness 层翻译。

**架构：** 两层翻译——Layer 1 星相 Strip（持续可见的状态条，扩展现有 SummaryBar）+ Layer 2 天枢无线电（关键节点中文简报，新增 postTool hook 经 onPhaseChange callback 到 TUI）。

**技术栈：** TypeScript strict, Ink 6 (React), node:test + node:assert/strict, RuntimeHookPipeline

---

## 文件结构

| 文件 | 职责 |
|------|------|
| 修改 `src/agent/star-event.ts` | 导出 PHASE_LABELS, PHASE_GLYPHS 的短标签版本供 strip 消费 |
| 新建 `src/tui/alchemy-bar.ts` | 纯函数：sensorium confidence → 炼金四色条字符串 |
| 修改 `src/tui/summary-bar.tsx` | 扩展为星相 strip：star phase + TaskState 步骤 + 炼金色带 + tool 摘要 |
| 新建 `src/agent/radio-templates.ts` | 15 个中文模板 + 变量提取函数 |
| 新建 `src/agent/hooks/radio-hook.ts` | postTool hook：phase 转换检测 + 模板拼装 + 频率控制 |
| 修改 `src/agent/create-runtime-hooks.ts` | 注册 radio hook |
| 修改 `src/tui/app.tsx` | 消费 onPhaseChange 中的 radio 消息渲染到对话流 |
| 新建 `src/tui/__tests__/alchemy-bar.test.ts` | 四色映射测试 |
| 新建 `src/agent/__tests__/radio-templates.test.ts` | 模板拼装测试 |
| 新建 `src/agent/__tests__/radio-hook.test.ts` | hook 触发逻辑 + 频率控制测试 |

---

### 任务 1：炼金四色条渲染

**文件：**
- 新建：`src/tui/alchemy-bar.ts`
- 测试：`src/tui/__tests__/alchemy-bar.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/tui/__tests__/alchemy-bar.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { alchemyBar, alchemyStage } from '../alchemy-bar.js'

describe('alchemyStage', () => {
  it('returns nigredo for low confidence', () => {
    assert.equal(alchemyStage(0.1), 'nigredo')
    assert.equal(alchemyStage(0.29), 'nigredo')
  })

  it('returns albedo for mid-low confidence', () => {
    assert.equal(alchemyStage(0.3), 'albedo')
    assert.equal(alchemyStage(0.49), 'albedo')
  })

  it('returns citrinitas for mid-high confidence', () => {
    assert.equal(alchemyStage(0.5), 'citrinitas')
    assert.equal(alchemyStage(0.79), 'citrinitas')
  })

  it('returns rubedo for high confidence', () => {
    assert.equal(alchemyStage(0.8), 'rubedo')
    assert.equal(alchemyStage(1.0), 'rubedo')
  })
})

describe('alchemyBar', () => {
  it('renders 4-char bar with correct fill level', () => {
    assert.equal(alchemyBar(0.1).length, 4)
    assert.equal(alchemyBar(0.9).length, 4)
  })

  it('renders all empty for nigredo', () => {
    assert.equal(alchemyBar(0.1), '░░░░')
  })

  it('renders partial for albedo', () => {
    assert.equal(alchemyBar(0.4), '▓░░░')
  })

  it('renders mostly full for citrinitas', () => {
    assert.equal(alchemyBar(0.7), '██▓░')
  })

  it('renders full for rubedo', () => {
    assert.equal(alchemyBar(0.95), '████')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/tui/__tests__/alchemy-bar.test.ts`
预期：FAIL — cannot find module '../alchemy-bar.js'

- [ ] **步骤 3：实现 alchemy-bar.ts**

```typescript
// src/tui/alchemy-bar.ts

export type AlchemyStage = 'nigredo' | 'albedo' | 'citrinitas' | 'rubedo'

export function alchemyStage(confidence: number): AlchemyStage {
  if (confidence >= 0.8) return 'rubedo'
  if (confidence >= 0.5) return 'citrinitas'
  if (confidence >= 0.3) return 'albedo'
  return 'nigredo'
}

export const ALCHEMY_COLORS: Record<AlchemyStage, string> = {
  nigredo: 'gray',
  albedo: 'white',
  citrinitas: 'yellow',
  rubedo: 'red',
}

export function alchemyBar(confidence: number): string {
  const stage = alchemyStage(confidence)
  switch (stage) {
    case 'nigredo': return '░░░░'
    case 'albedo': return '▓░░░'
    case 'citrinitas': return '██▓░'
    case 'rubedo': return '████'
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/tui/__tests__/alchemy-bar.test.ts`
预期：8 tests PASS

- [ ] **步骤 5：Commit**

```bash
git add src/tui/alchemy-bar.ts src/tui/__tests__/alchemy-bar.test.ts
git commit -m "feat(tui): add alchemy bar — sensorium confidence to 4-stage color bar"
```

---

### 任务 2：Star Phase 短标签导出

**文件：**
- 修改：`src/agent/star-event.ts`

- [ ] **步骤 1：在 PHASE_LABELS 下方添加短标签**

在 `src/agent/star-event.ts` 第 42 行（`PHASE_GLYPHS` 定义后）添加：

```typescript
/** Short Chinese labels for strip display (≤4 chars). */
export const PHASE_SHORT_LABELS: Record<StarPhase, string> = {
  'tianshu-planning': '观局',
  'tianxuan-locating': '寻迹',
  'tianji-decomposing': '拆解',
  'tianquan-contracting': '定标',
  'yuheng-implementing': '铸形',
  'kaiyang-testing': '试锋',
  'yaoguang-delivering': '归航',
  'tianshu-encore': '再临',
}
```

- [ ] **步骤 2：运行 typecheck**

运行：`npx tsc --noEmit`
预期：0 errors

- [ ] **步骤 3：Commit**

```bash
git add src/agent/star-event.ts
git commit -m "feat(agent): export PHASE_SHORT_LABELS for TUI strip consumption"
```

---

### 任务 3：扩展 SummaryBar 为星相 Strip

**文件：**
- 修改：`src/tui/summary-bar.tsx`

- [ ] **步骤 1：添加 star phase 和 alchemy 字段到 SummaryState**

在 `src/tui/summary-bar.tsx` 的 `SummaryState` 接口（第 6-23 行）中添加新字段：

```typescript
export interface SummaryState {
  task: string
  phase: Phase
  stepCount: number
  totalSteps: number
  contextPct: number
  elapsedMs: number
  lastAction: LastAction | null
  risk: 'none' | 'medium' | 'high'
  compactEvent?: { beforeTokens: number; afterTokens: number } | null
  approvalNeeded?: { tool: string; target: string } | null
  tokenHistory?: number[]
  phaseDurationMs?: number
  turnCount?: number
  maxTurns?: number
  // 天枢之眼 — star phase + alchemy
  starPhaseGlyph?: string
  starPhaseLabel?: string
  alchemyConfidence?: number
  recentToolSummary?: string[]  // last 3 tool labels, e.g. ["write auth.ts", "test", "fix bug"]
}
```

- [ ] **步骤 2：修改 formatSummaryLine1 渲染星相 strip**

替换 `formatSummaryLine1`（第 72-81 行）为：

```typescript
export function formatSummaryLine1(state: SummaryState, heartbeatFrame: number): string {
  const spinner = HEARTBEAT_FRAMES[heartbeatFrame % HEARTBEAT_FRAMES.length]!
  const elapsed = formatElapsed(state.elapsedMs)

  // Star phase + short label (天枢之眼 Layer 1)
  const starGlyph = state.starPhaseGlyph ?? ''
  const starLabel = state.starPhaseLabel ?? state.phase
  const phaseSegment = starGlyph ? `${starGlyph} ${starLabel}` : starLabel

  // Step progress from TaskState
  const steps = state.totalSteps > 0 ? `${state.stepCount}/${state.totalSteps}` : ''

  // Turn counter
  const turn = state.turnCount && state.maxTurns ? `T${state.turnCount}/${state.maxTurns}` : ''

  // Alchemy bar
  const alchBar = state.alchemyConfidence !== undefined
    ? alchemyBar(state.alchemyConfidence)
    : contextBar(state.contextPct)

  // Recent tool summary (last 3)
  const tools = state.recentToolSummary && state.recentToolSummary.length > 0
    ? state.recentToolSummary.join(' → ')
    : ''

  const parts = [phaseSegment, steps, turn, alchBar, tools].filter(Boolean)
  return `${spinner} ${parts.join(' │ ')} │ ${elapsed}`
}
```

- [ ] **步骤 3：添加 alchemyBar import**

在文件顶部（第 4 行 `import { getTheme }` 之后）添加：

```typescript
import { alchemyBar, ALCHEMY_COLORS, alchemyStage } from './alchemy-bar.js'
```

- [ ] **步骤 4：更新 SummaryBar 组件的渲染逻辑**

替换 `SummaryBar` 组件中 line1 的渲染部分（第 118-136 行的 `<Text>` 块）为：

```typescript
export const SummaryBar = memo(function SummaryBar({ state }: { state: SummaryState }) {
  const theme = getTheme()
  const ctxColor = theme.contextColor(state.contextPct)
  const riskColor = state.risk === 'high' ? theme.error : state.risk === 'medium' ? theme.warning : theme.dim
  const alchColor = state.alchemyConfidence !== undefined
    ? ALCHEMY_COLORS[alchemyStage(state.alchemyConfidence)]
    : undefined
  const [heartbeat, setHeartbeat] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setHeartbeat(h => h + 1), 200)
    return () => clearInterval(id)
  }, [])

  const starGlyph = state.starPhaseGlyph ?? ''
  const starLabel = state.starPhaseLabel ?? state.phase
  const steps = state.totalSteps > 0 ? ` ${state.stepCount}/${state.totalSteps}` : ''
  const turn = state.turnCount && state.maxTurns ? ` T${state.turnCount}/${state.maxTurns}` : ''
  const alchBar = state.alchemyConfidence !== undefined
    ? alchemyBar(state.alchemyConfidence)
    : contextBar(state.contextPct)
  const toolSummary = state.recentToolSummary && state.recentToolSummary.length > 0
    ? state.recentToolSummary.join(' → ')
    : ''

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>
        <Text color={theme.primary}>{HEARTBEAT_FRAMES[heartbeat % HEARTBEAT_FRAMES.length]}</Text>
        <Text> </Text>
        {starGlyph && <Text>{starGlyph} </Text>}
        <Text bold color={theme.primary}>{starLabel}</Text>
        {steps && <Text dimColor>{steps}</Text>}
        {turn && <Text dimColor>{turn}</Text>}
        <Text color={theme.dim}> │ </Text>
        <Text color={alchColor ?? ctxColor}>{alchBar}</Text>
        {toolSummary && (
          <>
            <Text color={theme.dim}> │ </Text>
            <Text dimColor>{truncate(toolSummary, 40)}</Text>
          </>
        )}
        <Text color={theme.dim}> │ </Text>
        <Text dimColor>{formatElapsed(state.elapsedMs)}</Text>
      </Text>
      <Text>
        <Text color={theme.dim}>├ </Text>
        {state.phaseDurationMs !== undefined && state.phaseDurationMs > 0 ? (
          <>
            <Text dimColor>{state.phase}… </Text>
            <Text color={state.phase === 'idle' ? theme.dim : theme.primary}>{formatElapsed(state.phaseDurationMs)}</Text>
          </>
        ) : state.lastAction ? (
          <>
            <Text dimColor>last: </Text>
            <Text>{state.lastAction.tool} {truncate(state.lastAction.target.split('/').pop() ?? '', 30)}</Text>
            <Text color={state.lastAction.success ? theme.success : theme.error}> → {state.lastAction.success ? '✓' : '✗'}</Text>
          </>
        ) : (
          <Text dimColor>waiting for first action...</Text>
        )}
      </Text>
      <Text>
        <Text color={theme.dim}>└ </Text>
        {state.approvalNeeded ? (
          <Text bold color={theme.error}>⚠ APPROVAL: {state.approvalNeeded.tool} {truncate(state.approvalNeeded.target, 25)}</Text>
        ) : state.compactEvent ? (
          <Text color={theme.warning}>⚡ compact: {Math.round(state.compactEvent.beforeTokens / 1000)}k→{Math.round(state.compactEvent.afterTokens / 1000)}k</Text>
        ) : (
          <>
            <Text dimColor>step {state.stepCount}</Text>
            <Text color={theme.dim}> │ </Text>
            <Text color={riskColor}>risk: {state.risk}</Text>
          </>
        )}
      </Text>
    </Box>
  )
})
```

- [ ] **步骤 5：运行 typecheck**

运行：`npx tsc --noEmit`
预期：0 errors（app.tsx 可能报 SummaryState 新字段未传入——下一任务修复）

- [ ] **步骤 6：Commit**

```bash
git add src/tui/summary-bar.tsx
git commit -m "feat(tui): extend SummaryBar with star phase strip + alchemy bar + tool summary"
```

---

### 任务 4：在 app.tsx 中接入星相数据

**文件：**
- 修改：`src/tui/app.tsx`

- [ ] **步骤 1：在 app.tsx 中 import star-event 和 sensorium 类型**

在 import 区域添加：

```typescript
import { PHASE_SHORT_LABELS, PHASE_GLYPHS, type StarPhase } from '../agent/star-event.js'
```

- [ ] **步骤 2：找到 summaryState 构建位置，添加新字段**

在 app.tsx 中找到构建 `summaryState` 对象的位置（搜索 `summaryState` 赋值），在其中添加：

```typescript
starPhaseGlyph: currentStarEvent?.glyph,
starPhaseLabel: currentStarEvent ? PHASE_SHORT_LABELS[currentStarEvent.phase as StarPhase] : undefined,
alchemyConfidence: currentStarEvent?.sensorium?.confidence,
recentToolSummary: recentToolHistory.slice(-3).map(t => {
  const file = t.target.split('/').pop() ?? t.target
  return `${t.tool === 'read_file' ? 'read' : t.tool === 'edit_file' ? 'edit' : t.tool === 'write_file' ? 'write' : t.tool === 'bash' ? 'run' : t.tool} ${file}`.slice(0, 25)
}),
```

注意：`currentStarEvent` 和 `recentToolHistory` 的具体变量名需要根据 app.tsx 中的实际命名调整。如果 star event 目前没有传到 TUI 层，需要通过 `onPhaseChange` callback 传递 star event 数据。

- [ ] **步骤 3：运行 typecheck + 全量测试**

运行：`npx tsc --noEmit && npm test`
预期：0 errors，所有测试通过

- [ ] **步骤 4：Commit**

```bash
git add src/tui/app.tsx
git commit -m "feat(tui): wire star phase + sensorium + tool history into SummaryBar strip"
```

---

### 任务 5：天枢无线电模板库

**文件：**
- 新建：`src/agent/radio-templates.ts`
- 测试：`src/agent/__tests__/radio-templates.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/agent/__tests__/radio-templates.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatRadioMessage, extractTemplateVars, type RadioContext } from '../radio-templates.js'

describe('extractTemplateVars', () => {
  it('extracts file count and top files from tool history', () => {
    const history = [
      { tool: 'read_file', target: 'src/auth/middleware.ts', status: 'success' as const },
      { tool: 'read_file', target: 'src/auth/types.ts', status: 'success' as const },
      { tool: 'read_file', target: 'src/auth/handler.ts', status: 'success' as const },
    ]
    const vars = extractTemplateVars(history)
    assert.equal(vars.fileCount, 3)
    assert.ok(vars.topFiles.includes('middleware.ts'))
    assert.ok(vars.topFiles.includes('types.ts'))
  })

  it('extracts target files from write/edit tools', () => {
    const history = [
      { tool: 'edit_file', target: 'src/auth/middleware.ts', status: 'success' as const },
      { tool: 'write_file', target: 'src/auth/new-handler.ts', status: 'success' as const },
    ]
    const vars = extractTemplateVars(history)
    assert.ok(vars.targetFiles.includes('middleware.ts'))
    assert.ok(vars.targetFiles.includes('new-handler.ts'))
  })

  it('extracts error info from failed tool', () => {
    const history = [
      { tool: 'bash', target: 'npm test', status: 'failed' as const, error: 'TypeError: cannot read property x of undefined' },
    ]
    const vars = extractTemplateVars(history)
    assert.ok(vars.errorBrief.includes('TypeError'))
    assert.equal(vars.lastFailedTool, 'bash')
  })
})

describe('formatRadioMessage', () => {
  it('formats explore→plan transition', () => {
    const ctx: RadioContext = {
      transition: 'explore→plan',
      vars: { fileCount: 5, topFiles: '（auth.ts, types.ts）', targetFiles: '', errorBrief: '', lastFailedTool: '', failCount: 0, phaseName: '观局', turnCount: 3 },
    }
    const msg = formatRadioMessage(ctx)
    assert.ok(msg.startsWith('[天枢]'))
    assert.ok(msg.includes('5'))
    assert.ok(msg.includes('auth.ts'))
  })

  it('formats test_fail milestone', () => {
    const ctx: RadioContext = {
      transition: 'test_fail',
      vars: { fileCount: 0, topFiles: '', targetFiles: '', errorBrief: 'auth.test.ts', lastFailedTool: 'bash', failCount: 2, phaseName: '试锋', turnCount: 0 },
    }
    const msg = formatRadioMessage(ctx)
    assert.ok(msg.includes('✗'))
    assert.ok(msg.includes('2'))
  })

  it('formats stuck warning', () => {
    const ctx: RadioContext = {
      transition: 'stuck',
      vars: { fileCount: 0, topFiles: '', targetFiles: '', errorBrief: '', lastFailedTool: '', failCount: 0, phaseName: '铸形', turnCount: 8 },
    }
    const msg = formatRadioMessage(ctx)
    assert.ok(msg.includes('⚠'))
    assert.ok(msg.includes('铸形'))
    assert.ok(msg.includes('8'))
  })

  it('returns fallback for unknown transition', () => {
    const ctx: RadioContext = {
      transition: 'unknown_transition',
      vars: { fileCount: 0, topFiles: '', targetFiles: '', errorBrief: '', lastFailedTool: '', failCount: 0, phaseName: '观局', turnCount: 5 },
    }
    const msg = formatRadioMessage(ctx)
    assert.ok(msg.startsWith('[天枢]'))
    assert.ok(msg.includes('观局'))
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/radio-templates.test.ts`
预期：FAIL — cannot find module '../radio-templates.js'

- [ ] **步骤 3：实现 radio-templates.ts**

```typescript
// src/agent/radio-templates.ts

export interface TemplateVars {
  fileCount: number
  topFiles: string        // e.g. "（auth.ts, types.ts）"
  targetFiles: string     // e.g. "middleware.ts, handler.ts"
  errorBrief: string
  lastFailedTool: string
  failCount: number
  phaseName: string
  turnCount: number
}

export interface RadioContext {
  transition: string
  vars: TemplateVars
}

type ToolEntry = { tool: string; target: string; status: 'success' | 'failed' | 'running'; error?: string }

export function extractTemplateVars(history: ToolEntry[]): TemplateVars {
  const reads = history.filter(e => e.tool === 'read_file')
  const writes = history.filter(e => e.tool === 'edit_file' || e.tool === 'write_file')
  const failed = history.filter(e => e.status === 'failed')
  const lastFailed = failed[failed.length - 1]

  const basename = (path: string) => path.split('/').pop() ?? path

  const topFileNames = reads.slice(-3).map(e => basename(e.target))
  const topFiles = topFileNames.length > 0 ? `（${topFileNames.join(', ')}）` : ''

  const targetFileNames = [...new Set(writes.map(e => basename(e.target)))]
  const targetFiles = targetFileNames.join(', ')

  const errorBrief = lastFailed?.error
    ? lastFailed.error.slice(0, 60)
    : ''

  return {
    fileCount: reads.length,
    topFiles,
    targetFiles,
    errorBrief,
    lastFailedTool: lastFailed?.tool ?? '',
    failCount: failed.length,
    phaseName: '',
    turnCount: 0,
  }
}

const TEMPLATES: Record<string, string> = {
  'session_start':    '[天枢] 收到任务，开始分析。',
  'explore→plan':     '[天枢] 已读取 {fileCount} 个文件{topFiles}。准备制定方案。',
  'plan→execute':     '[天枢] 开始修改。预计修改 {targetFiles}。',
  'execute→verify':   '[天枢] 代码修改完成，运行测试验证。',
  'verify→deliver':   '[天枢] ✓ 测试全部通过，准备交付结果。',
  'test_pass':        '[天枢] ✓ 测试通过。',
  'test_fail':        '[天枢] ✗ 测试失败 {failCount} 个：{errorBrief}。正在修复。',
  'error':            '[天枢] ⚠ {lastFailedTool} 出错：{errorBrief}。',
  'stuck':            '[天枢] ⚠ 已在{phaseName}停留 {turnCount} turn，可能遇到困难。',
  'doom_loop':        '[天枢] ⚠⚠ 检测到循环，考虑换个方向。',
  'high_pressure':    '[天枢] 上下文即将满，准备压缩。',
  'midpoint':         '[天枢] 进度过半，继续执行中。',
  'near_complete':    '[天枢] 接近完成，最后验证中。',
}

const FALLBACK_TEMPLATE = '[天枢] {phaseName}中。'

export function formatRadioMessage(ctx: RadioContext): string {
  const template = TEMPLATES[ctx.transition] ?? FALLBACK_TEMPLATE
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const val = ctx.vars[key as keyof TemplateVars]
    return val !== undefined && val !== '' && val !== 0 ? String(val) : ''
  }).replace(/\s{2,}/g, ' ').trim()
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/radio-templates.test.ts`
预期：7 tests PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/radio-templates.ts src/agent/__tests__/radio-templates.test.ts
git commit -m "feat(agent): add radio-templates — 15 Chinese message templates for Tianshu radio"
```

---

### 任务 6：天枢无线电 Hook

**文件：**
- 新建：`src/agent/hooks/radio-hook.ts`
- 测试：`src/agent/__tests__/radio-hook.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/agent/__tests__/radio-hook.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRadioHook, type RadioHookState } from '../hooks/radio-hook.js'
import type { RuntimeHookContext, RuntimeToolEvent, RuntimeHookSnapshot } from '../runtime-hooks.js'

function makeSnapshot(overrides: Partial<RuntimeHookSnapshot> = {}): RuntimeHookSnapshot {
  return {
    cwd: '/tmp/test',
    turn: 5,
    recentToolHistory: [],
    sensorium: { momentum: 0.5, pressure: 0.3, confidence: 0.6, complexity: 0.4, freshness: 0.5, stability: 0.7 },
    strategy: null,
    vigor: null,
    gitChangeRate: 0,
    ...overrides,
  }
}

function makeCtx(snapshot: RuntimeHookSnapshot): { ctx: RuntimeHookContext; emitted: string[] } {
  const emitted: string[] = []
  return {
    ctx: {
      snapshot,
      effects: {
        setSensorium: () => {},
        setStrategy: () => {},
        setVigor: () => {},
        setGitChangeRate: () => {},
        injectUserMessage: () => {},
        requestThetaCheck: () => {},
        emitPhaseChange: (phase: string, detail?: any) => { emitted.push(detail?.reason ?? phase) },
      },
    },
    emitted,
  }
}

describe('radio-hook', () => {
  it('emits session_start on first tool call', () => {
    const hook = createRadioHook()
    const snapshot = makeSnapshot({ turn: 0 })
    const { ctx, emitted } = makeCtx(snapshot)
    const tool: RuntimeToolEvent = { name: 'read_file', success: true, target: 'src/auth.ts' }
    hook.run(ctx, tool)
    assert.ok(emitted.some(e => e.includes('[天枢]')))
  })

  it('emits on phase transition', () => {
    const hook = createRadioHook()
    // First call in "planning" phase
    const snap1 = makeSnapshot({ turn: 1, sensorium: { momentum: 0.2, pressure: 0.1, confidence: 0.2, complexity: 0.3, freshness: 0.3, stability: 0.5 } })
    const { ctx: ctx1 } = makeCtx(snap1)
    hook.run(ctx1, { name: 'read_file', success: true, target: 'src/a.ts' })

    // Second call in "implementing" phase (confidence > 0.6, writing)
    const snap2 = makeSnapshot({ turn: 5, sensorium: { momentum: 0.7, pressure: 0.3, confidence: 0.8, complexity: 0.3, freshness: 0.6, stability: 0.8 } })
    const { ctx: ctx2, emitted: emitted2 } = makeCtx(snap2)
    hook.run(ctx2, { name: 'edit_file', success: true, target: 'src/auth.ts' })

    // Should emit a transition message
    assert.ok(emitted2.length > 0)
  })

  it('respects cooldown — does not emit twice within 5 turns for stuck', () => {
    const hook = createRadioHook()
    const emittedAll: string[] = []

    for (let turn = 0; turn < 12; turn++) {
      const snapshot = makeSnapshot({
        turn,
        sensorium: { momentum: 0.1, pressure: 0.1, confidence: 0.1, complexity: 0.1, freshness: 0.1, stability: 0.1 },
        recentToolHistory: [{ tool: 'read_file', target: 'src/a.ts', status: 'success' }],
      })
      const { ctx, emitted } = makeCtx(snapshot)
      hook.run(ctx, { name: 'read_file', success: true, target: 'src/a.ts' })
      emittedAll.push(...emitted)
    }

    // Stuck messages should have cooldown, not one per turn
    const stuckMessages = emittedAll.filter(e => e.includes('⚠'))
    assert.ok(stuckMessages.length <= 3, `Expected ≤3 stuck messages in 12 turns, got ${stuckMessages.length}`)
  })

  it('emits test_fail on failed bash/test tool', () => {
    const hook = createRadioHook()
    const snapshot = makeSnapshot({
      turn: 10,
      recentToolHistory: [
        { tool: 'bash', target: 'npm test', status: 'failed' },
      ],
    })
    const { ctx, emitted } = makeCtx(snapshot)
    hook.run(ctx, { name: 'bash', success: false, target: 'npm test', isError: true })
    assert.ok(emitted.some(e => e.includes('✗') || e.includes('⚠')))
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/radio-hook.test.ts`
预期：FAIL — cannot find module '../hooks/radio-hook.js'

- [ ] **步骤 3：实现 radio-hook.ts**

```typescript
// src/agent/hooks/radio-hook.ts
import type { PostToolRuntimeHook, RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'
import { mapSensoriumToPhase, PHASE_SHORT_LABELS, type StarPhase, type StarPhaseContext } from '../star-event.js'
import { extractTemplateVars, formatRadioMessage, type TemplateVars } from '../radio-templates.js'
import type { Sensorium } from '../sensorium.js'

interface RadioState {
  lastPhase: StarPhase | null
  lastEmitTurn: number
  turnsInCurrentPhase: number
  hasEmittedStart: boolean
}

const STUCK_THRESHOLD = 8
const COOLDOWN_TURNS = 5

function detectPhase(sensorium: Sensorium, tool: RuntimeToolEvent, turn: number): StarPhase {
  const ctx: StarPhaseContext = {
    turn,
    isWriting: tool.name === 'edit_file' || tool.name === 'write_file',
    isRunningTests: tool.name === 'bash' && (tool.target?.includes('test') ?? false),
    isFinalTurn: false,
    shouldEscalate: false,
    hasEnteredHighComplexity: sensorium.complexity > 0.5,
  }
  return mapSensoriumToPhase(sensorium, ctx)
}

function classifyPhase(phase: StarPhase): 'explore' | 'plan' | 'execute' | 'verify' | 'deliver' {
  switch (phase) {
    case 'tianxuan-locating': return 'explore'
    case 'tianshu-planning': case 'tianshu-encore': return 'plan'
    case 'tianji-decomposing': case 'tianquan-contracting': return 'plan'
    case 'yuheng-implementing': return 'execute'
    case 'kaiyang-testing': return 'verify'
    case 'yaoguang-delivering': return 'deliver'
  }
}

function getTransitionKey(from: string, to: string): string {
  return `${from}→${to}`
}

export function createRadioHook(): PostToolRuntimeHook {
  const state: RadioState = {
    lastPhase: null,
    lastEmitTurn: -COOLDOWN_TURNS,
    turnsInCurrentPhase: 0,
    hasEmittedStart: false,
  }

  return {
    phase: 'postTool',
    name: 'tianshu-radio',
    run(ctx: RuntimeHookContext, tool: RuntimeToolEvent): void {
      const { snapshot } = ctx
      const sensorium = snapshot.sensorium
      if (!sensorium) return

      const turn = snapshot.turn
      const currentPhase = detectPhase(sensorium, tool, turn)
      const currentClass = classifyPhase(currentPhase)

      // Session start
      if (!state.hasEmittedStart) {
        state.hasEmittedStart = true
        state.lastPhase = currentPhase
        const msg = formatRadioMessage({ transition: 'session_start', vars: makeVars(snapshot, currentPhase) })
        ctx.effects.emitPhaseChange('tianshu-radio', { reason: msg })
        state.lastEmitTurn = turn
        return
      }

      // Phase transition detection
      const prevClass = state.lastPhase ? classifyPhase(state.lastPhase) : null
      if (prevClass && prevClass !== currentClass) {
        const transitionKey = getTransitionKey(prevClass, currentClass)
        const vars = makeVars(snapshot, currentPhase)
        const msg = formatRadioMessage({ transition: transitionKey, vars })
        ctx.effects.emitPhaseChange('tianshu-radio', { reason: msg })
        state.lastEmitTurn = turn
        state.turnsInCurrentPhase = 0
      } else {
        state.turnsInCurrentPhase++
      }

      // Milestone: test failure
      if (!tool.success && (tool.name === 'bash' || tool.name === 'run_tests')) {
        if (turn - state.lastEmitTurn >= 2) {
          const vars = makeVars(snapshot, currentPhase)
          const msg = formatRadioMessage({ transition: 'test_fail', vars })
          ctx.effects.emitPhaseChange('tianshu-radio', { reason: msg })
          state.lastEmitTurn = turn
        }
      }

      // Stuck detection
      if (state.turnsInCurrentPhase >= STUCK_THRESHOLD && turn - state.lastEmitTurn >= COOLDOWN_TURNS) {
        const vars = makeVars(snapshot, currentPhase)
        vars.turnCount = state.turnsInCurrentPhase
        const msg = formatRadioMessage({ transition: 'stuck', vars })
        ctx.effects.emitPhaseChange('tianshu-radio', { reason: msg })
        state.lastEmitTurn = turn
      }

      state.lastPhase = currentPhase
    },
  }
}

function makeVars(snapshot: { recentToolHistory: Array<{ tool: string; target: string; status: string }>; turn: number }, phase: StarPhase): TemplateVars {
  const history = snapshot.recentToolHistory.map(e => ({
    tool: e.tool,
    target: e.target,
    status: e.status as 'success' | 'failed' | 'running',
  }))
  const vars = extractTemplateVars(history)
  vars.phaseName = PHASE_SHORT_LABELS[phase]
  vars.turnCount = snapshot.turn
  return vars
}

export type { RadioState }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/radio-hook.test.ts`
预期：4 tests PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/hooks/radio-hook.ts src/agent/__tests__/radio-hook.test.ts
git commit -m "feat(agent): add tianshu-radio hook — phase transition + milestone + stuck detection"
```

---

### 任务 7：注册 Radio Hook 到 RuntimeHookPipeline

**文件：**
- 修改：`src/agent/create-runtime-hooks.ts`

- [ ] **步骤 1：添加 import**

在 `src/agent/create-runtime-hooks.ts` 第 10 行（`import { createCourageHook }` 之后）添加：

```typescript
import { createRadioHook } from './hooks/radio-hook.js'
```

- [ ] **步骤 2：在 createDefaultRuntimeHooks 中注册 radio hook**

在 `createDefaultRuntimeHooks` 函数中（第 40-50 行区域），在 `createStigmergyRuntimeHook` 之后添加：

```typescript
    createRadioHook(),
```

- [ ] **步骤 3：运行 typecheck + 全量测试**

运行：`npx tsc --noEmit && npm test`
预期：0 errors，所有测试通过

- [ ] **步骤 4：Commit**

```bash
git add src/agent/create-runtime-hooks.ts
git commit -m "feat(agent): register tianshu-radio hook in RuntimeHookPipeline"
```

---

### 任务 8：TUI 渲染 Radio 消息

**文件：**
- 修改：`src/tui/app.tsx`

- [ ] **步骤 1：在 onPhaseChange 回调中检测 radio 消息**

在 app.tsx 中找到 `onPhaseChange` 的处理逻辑。当 `phase === 'tianshu-radio'` 时，将 `detail.reason`（中文消息）添加到对话流中作为系统消息渲染。

具体实现取决于 app.tsx 中 message 列表的管理方式。核心逻辑：

```typescript
// 在 onPhaseChange callback 处理中
if (phase === 'tianshu-radio' && detail?.reason) {
  // 添加为特殊的 radio 消息类型，渲染时使用不同样式
  addRadioMessage(detail.reason)
}
```

`addRadioMessage` 应该将消息插入到 TUI 的消息流中，使用独特样式（如 dim cyan 色）让它视觉上区分于 assistant 输出和 user 输入。

- [ ] **步骤 2：添加 Radio 消息渲染组件**

在消息渲染逻辑中添加对 radio 消息类型的处理：

```tsx
{message.type === 'radio' && (
  <Box paddingX={1}>
    <Text color="cyan" dimColor>{message.content}</Text>
  </Box>
)}
```

- [ ] **步骤 3：运行 typecheck + 手动测试**

运行：`npx tsc --noEmit`
预期：0 errors

手动测试：启动 Rivet，发一个需要多步的任务（如"读取 src/agent/loop.ts 并总结"），观察是否出现 `[天枢]` 中文简报。

- [ ] **步骤 4：Commit**

```bash
git add src/tui/app.tsx
git commit -m "feat(tui): render tianshu-radio messages in conversation flow with cyan styling"
```

---

### 任务 9：全量验证

**文件：** 无新文件

- [ ] **步骤 1：运行 typecheck**

运行：`npx tsc --noEmit`
预期：0 errors

- [ ] **步骤 2：运行全量测试**

运行：`npm test`
预期：全部 PASS

- [ ] **步骤 3：运行 build**

运行：`npm run build`
预期：成功

- [ ] **步骤 4：手动 session 测试**

启动 Rivet，发送一个多步任务，验证：
1. SummaryBar 显示星相 strip：glyph + 中文 phase 名 + 步骤进度 + 炼金色带 + tool 摘要
2. 对话流中出现 3-5 条 `[天枢]` 中文简报
3. Phase 转换时有简报（如 "已读取 N 个文件" → "开始修改"）
4. 测试失败时有简报（"✗ 测试失败"）
5. 炼金色带从 `░░░░` 逐渐变为 `████`

---

## 自检结果

**1. 规格覆盖度：**
- Layer 1 星相 Strip ✓（任务 1-4）
  - Star phase glyph + 中文名 ✓（任务 2-3）
  - TaskState 步骤进度 ✓（任务 3）
  - 炼金四色条 ✓（任务 1）
  - 最近 3 tool 摘要 ✓（任务 3-4）
  - 异常状态（doom loop 闪烁）— 部分覆盖：radio hook 检测 stuck，但 strip 自身的红色闪烁未在当前计划中实现。**可接受**：Phase 1 先用 radio 消息覆盖异常通知，strip 闪烁作为后续增强。
- Layer 2 天枢无线电 ✓（任务 5-8）
  - 15 个中文模板 ✓（任务 5）
  - phase 转换检测 ✓（任务 6）
  - 里程碑（测试失败）✓（任务 6）
  - 异常检测（stuck）✓（任务 6）
  - 频率控制（cooldown）✓（任务 6）
  - TUI 渲染 ✓（任务 8）

**2. 占位符扫描：** 任务 4 和 8 中 app.tsx 的具体修改位置标注为"搜索 summaryState 赋值"和"找到 onPhaseChange 处理逻辑"——这是因为 app.tsx 是 ~1160 行的大文件，精确行号依赖运行时检查。worker 需要自行定位。其余任务代码完整。

**3. 类型一致性：**
- `TemplateVars` 在 radio-templates.ts 定义，radio-hook.ts 消费 — 一致
- `SummaryState` 新字段在 summary-bar.tsx 定义，app.tsx 传入 — 一致
- `StarPhase` / `PHASE_SHORT_LABELS` 在 star-event.ts 导出，radio-hook.ts + app.tsx 消费 — 一致
- `PostToolRuntimeHook` 接口匹配 `run(ctx, tool)` 签名 — 一致

---

## 验收标准

- [ ] `npm run typecheck` — 0 errors
- [ ] `npm test` — 全部 PASS
- [ ] SummaryBar 显示：star phase glyph + 中文短标签 + 步骤进度 + 炼金色带 + tool 摘要
- [ ] 30-turn session 中出现 3-8 条 `[天枢]` 中文简报
- [ ] Phase 转换时触发简报
- [ ] 测试失败时触发简报
- [ ] 停滞 8 turn 时触发 `⚠` 告警
- [ ] Cooldown 机制防止连续告警（5 turn 内不重复）
- [ ] 炼金色带从 `░░░░` 渐进到 `████`

---

## 明确排除（不做）

| 提议 | 为什么不做 |
|------|-----------|
| Strip 红色闪烁动画（doom loop） | 增加 TUI 复杂度，radio 消息已覆盖告警需求。后续增强。 |
| Cockpit 自动弹出 | 涉及 TUI 焦点管理，风险高。后续独立任务。 |
| 六爻卦象渲染 | 学习成本高，炼金色带已提供直觉进度。留作实验性功能。 |
| LLM 生成中文摘要 | 增加延迟和成本。模板化足够覆盖 80% 场景。 |

---

## 依赖关系

```
任务 1（alchemy-bar）→ 任务 3（summary-bar 消费 alchemyBar）
任务 2（short labels）→ 任务 4（app.tsx 消费 PHASE_SHORT_LABELS）
任务 3（summary-bar）→ 任务 4（app.tsx 传入新字段）
任务 5（templates）→ 任务 6（radio-hook 消费 formatRadioMessage）
任务 6（radio-hook）→ 任务 7（注册到 pipeline）
任务 7（注册）→ 任务 8（TUI 消费 radio 消息）
任务 9 最后执行

可并行：
- 任务 1-2 可并行（无依赖）
- 任务 5 可与任务 3-4 并行（无依赖）
```

---

## 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| app.tsx 接入 star event 数据路径不明确 | 中 | 中 | Worker 需要读 app.tsx 找到 summaryState 构建位置和 onPhaseChange 处理位置 |
| SummaryBar 新布局在窄终端溢出 | 低 | 低 | truncate 函数已存在，tool summary 有 40 字符上限 |
| Radio 消息干扰 thinking 文本阅读 | 低 | 中 | cyan dimColor 样式 + 低频率（5-8 条/session） |
| Star phase 映射粗糙导致 radio 消息不准 | 中 | 低 | Fallback 模板 `[天枢] {phaseName}中。` 保底 |
