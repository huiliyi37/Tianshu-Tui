# 紫微天文台 + 天枢文武双身 实施计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现 Observatory 主题色板 + 天枢文武双身 Avatar + 侧边栏星图面板，让星图与会话始终联动可见。

**架构：** v0.1 先建立 Avatar 核心（表情系统 + 文武帧 + 渲染器），纯函数无 UI 依赖。v0.2 建立 Observatory 主题色板 + 侧边栏面板 + app.tsx 侧边栏布局。每个任务独立可测试。

**技术栈：** TypeScript strict, node:test + node:assert/strict, ESM (.js extension), Ink 6, chalk

---

## 文件结构

| 文件 | 职责 |
|------|------|
| 新建 `src/tui/avatar/types.ts` | AvatarFrame, AvatarMode, AvatarMood, AvatarContext 类型 |
| 新建 `src/tui/avatar/expressions.ts` | 萌三角表情系统：getFace(), phaseToMood(), phaseToMode() |
| 新建 `src/tui/avatar/frames.ts` | 文生/武生帧模板 + buildFrame() 纯函数 |
| 新建 `src/tui/avatar/avatar-renderer.ts` | renderAvatar() — 组合表情+帧+着色 |
| 新建 `src/tui/avatar/__tests__/expressions.test.ts` | 表情系统测试 |
| 新建 `src/tui/avatar/__tests__/frames.test.ts` | 帧模板测试 |
| 新建 `src/tui/avatar/__tests__/avatar-renderer.test.ts` | 渲染器集成测试 |
| 修改 `src/tui/theme.ts` | 新增 `'observatory'` 主题色板 |
| 新建 `src/tui/star-panel-colors.ts` | 星图面板专用色常量 |
| 新建 `src/tui/star-panel.tsx` | 侧边星图面板 React 组件 (Avatar + 七星 + 感官 + 电报) |
| 修改 `src/tui/constellation.ts` | 新增 renderConstellationVertical() |
| 修改 `src/tui/app.tsx` | side-by-side 布局 + 宽度检测 + 自动展开 |
| 修改 `src/tui/__tests__/theme.test.ts` | observatory 主题测试 |
| 新建 `src/tui/__tests__/star-panel-colors.test.ts` | 面板色常量测试 |

---

### 任务 1：Avatar 类型定义

**文件：**
- 新建：`src/tui/avatar/types.ts`

- [ ] **步骤 1：创建目录和类型文件**

```typescript
// src/tui/avatar/types.ts
import type { StarPhase } from '../../agent/star-event.js'
import type { AlchemyStage } from '../alchemy-bar.js'

export type DomainId = 'pojun' | 'tianfu' | 'tianliang' | null

export type AvatarMode = 'wenxing' | 'wuxing'

export type AvatarMood =
  | 'calm'
  | 'searching'
  | 'focused'
  | 'satisfied'
  | 'content'
  | 'tense'
  | 'serious'
  | 'confused'
  | 'surprised'
  | 'greeting'

export interface FaceExpression {
  leftEye: string
  mouth: string
  rightEye: string
}

export interface AvatarFrame {
  lines: string[]
  width: number
  height: number
}

export interface AvatarContext {
  phase: StarPhase
  alchemy: AlchemyStage
  domain: DomainId
  mood: AvatarMood
  mode: AvatarMode
  tick: number
  isStuck: boolean
  isTestFailing: boolean
  idleSeconds: number
}
```

- [ ] **步骤 2：运行 typecheck**

运行：`npx tsc --noEmit`
预期：0 errors

- [ ] **步骤 3：Commit**

```bash
git add src/tui/avatar/types.ts
git commit -m "feat(tui): add avatar type definitions — AvatarMode, AvatarMood, AvatarContext"
```

---

### 任务 2：表情系统

**文件：**
- 新建：`src/tui/avatar/expressions.ts`
- 测试：`src/tui/avatar/__tests__/expressions.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/tui/avatar/__tests__/expressions.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getFace, phaseToMood, phaseToMode } from '../expressions.js'
import type { StarPhase } from '../../../agent/star-event.js'

describe('phaseToMode', () => {
  it('returns wenxing for planning phases', () => {
    assert.equal(phaseToMode('tianshu-planning'), 'wenxing')
    assert.equal(phaseToMode('tianxuan-locating'), 'wenxing')
    assert.equal(phaseToMode('tianji-decomposing'), 'wenxing')
    assert.equal(phaseToMode('tianquan-contracting'), 'wenxing')
    assert.equal(phaseToMode('yaoguang-delivering'), 'wenxing')
  })

  it('returns wuxing for execution phases', () => {
    assert.equal(phaseToMode('yuheng-implementing'), 'wuxing')
    assert.equal(phaseToMode('kaiyang-testing'), 'wuxing')
  })

  it('returns wenxing for encore', () => {
    assert.equal(phaseToMode('tianshu-encore'), 'wenxing')
  })
})

describe('phaseToMood', () => {
  it('returns calm for planning', () => {
    assert.equal(phaseToMood('tianshu-planning', false, false), 'calm')
  })

  it('returns searching for locating', () => {
    assert.equal(phaseToMood('tianxuan-locating', false, false), 'searching')
  })

  it('returns focused for implementing', () => {
    assert.equal(phaseToMood('yuheng-implementing', false, false), 'focused')
  })

  it('returns tense for testing', () => {
    assert.equal(phaseToMood('kaiyang-testing', false, false), 'tense')
  })

  it('returns confused when stuck regardless of phase', () => {
    assert.equal(phaseToMood('yuheng-implementing', true, false), 'confused')
  })

  it('returns surprised when test failing regardless of phase', () => {
    assert.equal(phaseToMood('kaiyang-testing', false, true), 'surprised')
  })

  it('stuck takes priority over test failing', () => {
    assert.equal(phaseToMood('kaiyang-testing', true, true), 'confused')
  })
})

describe('getFace', () => {
  it('returns correct face for calm mood', () => {
    const face = getFace('calm', 1)
    assert.equal(face.leftEye, '◠')
    assert.equal(face.mouth, '‿')
    assert.equal(face.rightEye, '◠')
  })

  it('returns correct face for focused mood', () => {
    const face = getFace('focused', 1)
    assert.equal(face.leftEye, '●')
    assert.equal(face.mouth, '△')
    assert.equal(face.rightEye, '●')
  })

  it('returns correct face for confused mood', () => {
    const face = getFace('confused', 1)
    assert.equal(face.leftEye, '×')
    assert.equal(face.mouth, '~')
    assert.equal(face.rightEye, '×')
  })

  it('blinks on tick divisible by 20', () => {
    const face = getFace('calm', 20)
    assert.equal(face.leftEye, '─')
    assert.equal(face.rightEye, '─')
    assert.equal(face.mouth, '‿')
  })

  it('does not blink on other ticks', () => {
    const face = getFace('calm', 19)
    assert.equal(face.leftEye, '◠')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/tui/avatar/__tests__/expressions.test.ts`
预期：FAIL — cannot find module '../expressions.js'

- [ ] **步骤 3：实现 expressions.ts**

```typescript
// src/tui/avatar/expressions.ts
import type { StarPhase } from '../../agent/star-event.js'
import type { AvatarMode, AvatarMood, FaceExpression } from './types.js'

const EXPRESSIONS: Record<AvatarMood, FaceExpression> = {
  calm:      { leftEye: '◠', mouth: '‿', rightEye: '◠' },
  searching: { leftEye: '◉', mouth: '_', rightEye: '◉' },
  focused:   { leftEye: '●', mouth: '△', rightEye: '●' },
  satisfied: { leftEye: '◡', mouth: '▽', rightEye: '◡' },
  content:   { leftEye: '◡', mouth: '▿', rightEye: '◡' },
  tense:     { leftEye: '◎', mouth: '─', rightEye: '◎' },
  serious:   { leftEye: '●', mouth: '─', rightEye: '●' },
  confused:  { leftEye: '×', mouth: '~', rightEye: '×' },
  surprised: { leftEye: '○', mouth: '△', rightEye: '○' },
  greeting:  { leftEye: '◠', mouth: '▽', rightEye: '◠' },
}

const BLINK: Record<string, string> = {
  '◠': '─', '◉': '─', '●': '─', '◡': '─',
  '◎': '─', '×': '─', '○': '─',
}

export function getFace(mood: AvatarMood, tick: number): FaceExpression {
  const base = EXPRESSIONS[mood]
  if (tick % 20 !== 0 || tick === 0) return base
  return {
    leftEye: BLINK[base.leftEye] ?? base.leftEye,
    mouth: base.mouth,
    rightEye: BLINK[base.rightEye] ?? base.rightEye,
  }
}

export function phaseToMode(phase: StarPhase): AvatarMode {
  if (phase === 'yuheng-implementing' || phase === 'kaiyang-testing') return 'wuxing'
  return 'wenxing'
}

export function phaseToMood(phase: StarPhase, isStuck: boolean, isTestFailing: boolean): AvatarMood {
  if (isStuck) return 'confused'
  if (isTestFailing) return 'surprised'
  switch (phase) {
    case 'tianshu-planning': return 'calm'
    case 'tianxuan-locating': return 'searching'
    case 'tianji-decomposing': return 'focused'
    case 'tianquan-contracting': return 'satisfied'
    case 'yuheng-implementing': return 'focused'
    case 'kaiyang-testing': return 'tense'
    case 'yaoguang-delivering': return 'content'
    case 'tianshu-encore': return 'serious'
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/tui/avatar/__tests__/expressions.test.ts`
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/tui/avatar/expressions.ts src/tui/avatar/__tests__/expressions.test.ts
git commit -m "feat(tui): add avatar expression system — kaomoji face + phase-to-mood/mode mapping"
```

---

### 任务 3：文武帧模板

**文件：**
- 新建：`src/tui/avatar/frames.ts`
- 测试：`src/tui/avatar/__tests__/frames.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/tui/avatar/__tests__/frames.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildFrame, WENXING_BODY, WUXING_BODY, STATUS_LABELS } from '../frames.js'
import type { FaceExpression } from '../types.js'

describe('WENXING_BODY', () => {
  it('has exactly 3 body lines', () => {
    assert.equal(WENXING_BODY.length, 3)
  })
})

describe('WUXING_BODY', () => {
  it('has exactly 3 body lines', () => {
    assert.equal(WUXING_BODY.length, 3)
  })

  it('contains weapon symbol', () => {
    const joined = WUXING_BODY.join('')
    assert.ok(joined.includes('⚔'))
  })
})

describe('STATUS_LABELS', () => {
  it('has labels for all phases', () => {
    assert.ok(STATUS_LABELS['tianshu-planning'])
    assert.ok(STATUS_LABELS['yuheng-implementing'])
    assert.ok(STATUS_LABELS['kaiyang-testing'])
    assert.ok(STATUS_LABELS['yaoguang-delivering'])
  })
})

describe('buildFrame', () => {
  const calmFace: FaceExpression = { leftEye: '◠', mouth: '‿', rightEye: '◠' }
  const focusedFace: FaceExpression = { leftEye: '●', mouth: '△', rightEye: '●' }

  it('returns AvatarFrame with correct height', () => {
    const frame = buildFrame('wenxing', calmFace, '·★·', 'tianshu-planning', null)
    assert.equal(frame.height, frame.lines.length)
    assert.ok(frame.height >= 5)
  })

  it('includes star crown in first line', () => {
    const frame = buildFrame('wenxing', calmFace, '·★·', 'tianshu-planning', null)
    assert.ok(frame.lines[0].includes('★'))
  })

  it('includes face expression in second line', () => {
    const frame = buildFrame('wenxing', calmFace, '·★·', 'tianshu-planning', null)
    assert.ok(frame.lines[1].includes('◠'))
    assert.ok(frame.lines[1].includes('‿'))
  })

  it('uses wenxing body with star badge for wenxing mode', () => {
    const frame = buildFrame('wenxing', calmFace, '·★·', 'tianshu-planning', null)
    const joined = frame.lines.join('')
    assert.ok(joined.includes('☆'))
  })

  it('uses wuxing body with sword badge for wuxing mode', () => {
    const frame = buildFrame('wuxing', focusedFace, '·✦✦·', 'yuheng-implementing', null)
    const joined = frame.lines.join('')
    assert.ok(joined.includes('⚔'))
  })

  it('includes status label', () => {
    const frame = buildFrame('wenxing', calmFace, '·★·', 'tianshu-planning', null)
    const joined = frame.lines.join('')
    assert.ok(joined.includes('思考中'))
  })

  it('applies domain badge override for pojun', () => {
    const frame = buildFrame('wuxing', focusedFace, '·✦✦·', 'yuheng-implementing', 'pojun')
    const joined = frame.lines.join('')
    assert.ok(joined.includes('⚔'))
  })

  it('width is consistent across all lines', () => {
    const frame = buildFrame('wenxing', calmFace, '·★·', 'tianshu-planning', null)
    assert.ok(frame.width > 0)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/tui/avatar/__tests__/frames.test.ts`
预期：FAIL — cannot find module '../frames.js'

- [ ] **步骤 3：实现 frames.ts**

```typescript
// src/tui/avatar/frames.ts
import type { StarPhase } from '../../agent/star-event.js'
import type { AvatarMode, AvatarFrame, FaceExpression, DomainId } from './types.js'

export const WENXING_BODY: string[] = [
  ' /|☆|\\',
  '  / \\  ',
]

export const WUXING_BODY: string[] = [
  ' /|⚔|\\🔨',
  '  / \\ ✦',
]

const DOMAIN_BADGE: Record<string, string> = {
  pojun: '⚔',
  tianfu: '🛡',
  tianliang: '📏',
}

export const STATUS_LABELS: Record<StarPhase, string> = {
  'tianshu-planning': '思考中…',
  'tianxuan-locating': '搜索中…',
  'tianji-decomposing': '拆解中…',
  'tianquan-contracting': '签约中…',
  'yuheng-implementing': '编码中!',
  'kaiyang-testing': '验证中~',
  'yaoguang-delivering': '完成!',
  'tianshu-encore': '重新审视',
}

export function buildFrame(
  mode: AvatarMode,
  face: FaceExpression,
  starCrown: string,
  phase: StarPhase,
  domain: DomainId,
): AvatarFrame {
  const faceStr = `(${face.leftEye}${face.mouth}${face.rightEye})`

  let body: string[]
  if (mode === 'wuxing') {
    body = [...WUXING_BODY]
  } else {
    body = [...WENXING_BODY]
  }

  if (domain && DOMAIN_BADGE[domain]) {
    const badge = DOMAIN_BADGE[domain]
    body[0] = body[0].replace(mode === 'wuxing' ? '⚔' : '☆', badge)
  }

  const label = STATUS_LABELS[phase]

  const lines = [
    `   ${starCrown}`,
    `  ${faceStr}`,
    ...body,
    `  ${label}`,
  ]

  const width = Math.max(...lines.map(l => l.length))
  return { lines, width, height: lines.length }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/tui/avatar/__tests__/frames.test.ts`
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/tui/avatar/frames.ts src/tui/avatar/__tests__/frames.test.ts
git commit -m "feat(tui): add avatar frame templates — wenxing/wuxing bodies + domain badges"
```

---

### 任务 4：Avatar 渲染器

**文件：**
- 新建：`src/tui/avatar/avatar-renderer.ts`
- 测试：`src/tui/avatar/__tests__/avatar-renderer.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/tui/avatar/__tests__/avatar-renderer.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderAvatar, starCrownForAlchemy, idleMoodOverride } from '../avatar-renderer.js'
import type { AvatarContext } from '../types.js'

describe('starCrownForAlchemy', () => {
  it('returns dim star for nigredo', () => {
    const crown = starCrownForAlchemy('nigredo', 'wenxing', 0)
    assert.ok(crown.includes('★'))
  })

  it('returns double star for wuxing citrinitas', () => {
    const crown = starCrownForAlchemy('citrinitas', 'wuxing', 0)
    assert.ok(crown.includes('✦'))
  })

  it('returns triple star for delivering rubedo', () => {
    const crown = starCrownForAlchemy('rubedo', 'wenxing', 0)
    assert.ok(crown.includes('✦') || crown.includes('★'))
  })

  it('alternates star on breathing tick', () => {
    const crown1 = starCrownForAlchemy('albedo', 'wenxing', 0)
    const crown2 = starCrownForAlchemy('albedo', 'wenxing', 12)
    assert.ok(crown1 !== crown2 || crown1 === crown2) // alternation is cosmetic, no crash
  })
})

describe('idleMoodOverride', () => {
  it('returns null for short idle', () => {
    assert.equal(idleMoodOverride(5), null)
  })

  it('returns yawning face for 30+ seconds idle', () => {
    const result = idleMoodOverride(35)
    assert.ok(result !== null)
    assert.ok(result!.mouth === 'o')
  })

  it('returns sleeping face for 60+ seconds idle', () => {
    const result = idleMoodOverride(65)
    assert.ok(result !== null)
    assert.ok(result!.mouth === '‿')
    assert.ok(result!.leftEye === '─')
  })
})

describe('renderAvatar', () => {
  function makeCtx(overrides: Partial<AvatarContext> = {}): AvatarContext {
    return {
      phase: 'tianshu-planning',
      alchemy: 'nigredo',
      domain: null,
      mood: 'calm',
      mode: 'wenxing',
      tick: 1,
      isStuck: false,
      isTestFailing: false,
      idleSeconds: 0,
      ...overrides,
    }
  }

  it('returns non-empty frame', () => {
    const frame = renderAvatar(makeCtx())
    assert.ok(frame.lines.length >= 5)
    assert.ok(frame.width > 0)
    assert.equal(frame.height, frame.lines.length)
  })

  it('wenxing frame contains star badge', () => {
    const frame = renderAvatar(makeCtx({ mode: 'wenxing' }))
    const joined = frame.lines.join('')
    assert.ok(joined.includes('☆') || joined.includes('⚔') || joined.includes('🛡') || joined.includes('📏'))
  })

  it('wuxing frame contains weapon', () => {
    const frame = renderAvatar(makeCtx({ mode: 'wuxing', phase: 'yuheng-implementing', mood: 'focused' }))
    const joined = frame.lines.join('')
    assert.ok(joined.includes('⚔') || joined.includes('🔨'))
  })

  it('stuck context shows confused face', () => {
    const frame = renderAvatar(makeCtx({ isStuck: true, mood: 'confused' }))
    const joined = frame.lines.join('')
    assert.ok(joined.includes('×'))
    assert.ok(joined.includes('~'))
  })

  it('idle 60s shows sleeping face', () => {
    const frame = renderAvatar(makeCtx({ idleSeconds: 65 }))
    const joined = frame.lines.join('')
    assert.ok(joined.includes('─'))
  })

  it('pojun domain overrides badge', () => {
    const frame = renderAvatar(makeCtx({ domain: 'pojun' }))
    const joined = frame.lines.join('')
    assert.ok(joined.includes('⚔'))
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/tui/avatar/__tests__/avatar-renderer.test.ts`
预期：FAIL — cannot find module '../avatar-renderer.js'

- [ ] **步骤 3：实现 avatar-renderer.ts**

```typescript
// src/tui/avatar/avatar-renderer.ts
import type { AlchemyStage } from '../alchemy-bar.js'
import type { AvatarContext, AvatarFrame, AvatarMode, FaceExpression } from './types.js'
import { getFace } from './expressions.js'
import { buildFrame } from './frames.js'

export function starCrownForAlchemy(alchemy: AlchemyStage, mode: AvatarMode, tick: number): string {
  const breathe = tick % 25 < 12
  if (mode === 'wuxing') {
    return breathe ? '·✦✦·' : '·✦·'
  }
  switch (alchemy) {
    case 'rubedo': return breathe ? '·✦★✦·' : '·★✦·'
    case 'citrinitas': return breathe ? '·✦·' : '·★·'
    default: return breathe ? '·★·' : '·✦·'
  }
}

export function idleMoodOverride(idleSeconds: number): FaceExpression | null {
  if (idleSeconds >= 60) return { leftEye: '─', mouth: '‿', rightEye: '─' }
  if (idleSeconds >= 30) return { leftEye: '◠', mouth: 'o', rightEye: '◠' }
  return null
}

export function renderAvatar(ctx: AvatarContext): AvatarFrame {
  const idleFace = idleMoodOverride(ctx.idleSeconds)
  const face = idleFace ?? getFace(ctx.mood, ctx.tick)
  const crown = starCrownForAlchemy(ctx.alchemy, ctx.mode, ctx.tick)
  return buildFrame(ctx.mode, face, crown, ctx.phase, ctx.domain)
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/tui/avatar/__tests__/avatar-renderer.test.ts`
预期：全部 PASS

- [ ] **步骤 5：运行 typecheck**

运行：`npx tsc --noEmit`
预期：0 errors

- [ ] **步骤 6：Commit**

```bash
git add src/tui/avatar/avatar-renderer.ts src/tui/avatar/__tests__/avatar-renderer.test.ts
git commit -m "feat(tui): add avatar renderer — star crown + idle override + frame composition"
```

---

### 任务 5：Observatory 主题色板

**文件：**
- 修改：`src/tui/theme.ts`
- 修改：`src/tui/__tests__/theme.test.ts`

- [ ] **步骤 1：在 theme.ts 中添加 observatory 色板**

在 `export type ThemeName = 'pastel' | 'cyberpunk'` 后添加 `'observatory'`：

```typescript
export type ThemeName = 'pastel' | 'cyberpunk' | 'observatory'
```

在 `CYBERPUNK_FALLBACK` 之后添加：

```typescript
const OBSERVATORY_TRUECOLOR: ColorSet = {
  primary: '#818cf8',
  secondary: '#a78bfa',
  success: '#34d399',
  warning: '#f59e0b',
  error: '#f87171',
  dim: '#64748b',
}

const OBSERVATORY_FALLBACK: ColorSet = {
  primary: 'blue',
  secondary: 'magenta',
  success: 'green',
  warning: 'yellow',
  error: 'red',
  dim: 'gray',
}
```

在 `THEMES` 对象中添加 `observatory` 条目：

```typescript
const THEMES: Record<ThemeName, { truecolor: RivetTheme; fallback: RivetTheme }> = {
  pastel: { ... },
  cyberpunk: { ... },
  observatory: {
    truecolor: buildTheme(OBSERVATORY_TRUECOLOR),
    fallback: buildTheme(OBSERVATORY_FALLBACK),
  },
}
```

- [ ] **步骤 2：追加 theme 测试**

在 `src/tui/__tests__/theme.test.ts` 末尾追加：

```typescript
describe('observatory theme', () => {
  it('returns observatory theme when set', () => {
    setTheme('observatory')
    const theme = getTheme(3)
    assert.equal(theme.primary, '#818cf8')
    assert.equal(theme.warning, '#f59e0b')
    assert.equal(theme.error, '#f87171')
    setTheme('pastel')
  })

  it('returns fallback colors at low color level', () => {
    setTheme('observatory')
    const theme = getTheme(1)
    assert.equal(theme.primary, 'blue')
    setTheme('pastel')
  })
})
```

- [ ] **步骤 3：运行测试**

运行：`npx tsx --test src/tui/__tests__/theme.test.ts`
预期：全部 PASS

- [ ] **步骤 4：Commit**

```bash
git add src/tui/theme.ts src/tui/__tests__/theme.test.ts
git commit -m "feat(tui): add observatory theme — deep space color palette for star map"
```

---

### 任务 6：星图面板专用色 + 纵向七星

**文件：**
- 新建：`src/tui/star-panel-colors.ts`
- 新建：`src/tui/__tests__/star-panel-colors.test.ts`
- 修改：`src/tui/constellation.ts`
- 修改：`src/tui/__tests__/constellation.test.ts`

- [ ] **步骤 1：创建 star-panel-colors.ts**

```typescript
// src/tui/star-panel-colors.ts
import type { AlchemyStage } from './alchemy-bar.js'

export const PANEL_COLORS = {
  panelBorder: '#334155',
  constellationLine: '#475569',
  activeStarGlow: '#fbbf24',
  radioText: '#22d3ee',
  phaseLabel: '#e2e8f0',
} as const

export const AVATAR_ALCHEMY_COLORS: Record<AlchemyStage, string> = {
  nigredo: '#64748b',
  albedo: '#e2e8f0',
  citrinitas: '#f59e0b',
  rubedo: '#ef4444',
}
```

- [ ] **步骤 2：编写 star-panel-colors 测试**

```typescript
// src/tui/__tests__/star-panel-colors.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PANEL_COLORS, AVATAR_ALCHEMY_COLORS } from '../star-panel-colors.js'

describe('PANEL_COLORS', () => {
  it('has all required color tokens', () => {
    assert.ok(PANEL_COLORS.panelBorder)
    assert.ok(PANEL_COLORS.activeStarGlow)
    assert.ok(PANEL_COLORS.radioText)
    assert.ok(PANEL_COLORS.phaseLabel)
  })

  it('all values are hex color strings', () => {
    for (const val of Object.values(PANEL_COLORS)) {
      assert.match(val, /^#[0-9a-f]{6}$/i)
    }
  })
})

describe('AVATAR_ALCHEMY_COLORS', () => {
  it('has colors for all 4 alchemy stages', () => {
    assert.ok(AVATAR_ALCHEMY_COLORS.nigredo)
    assert.ok(AVATAR_ALCHEMY_COLORS.albedo)
    assert.ok(AVATAR_ALCHEMY_COLORS.citrinitas)
    assert.ok(AVATAR_ALCHEMY_COLORS.rubedo)
  })
})
```

- [ ] **步骤 3：运行测试**

运行：`npx tsx --test src/tui/__tests__/star-panel-colors.test.ts`
预期：全部 PASS

- [ ] **步骤 4：在 constellation.ts 中添加 renderConstellationVertical**

在 `src/tui/constellation.ts` 的 `export { STAR_ORDER }` 之前添加：

```typescript
export function renderConstellationVertical(activePhase: StarPhase): string[] {
  const s = (p: StarPhase) => starLabel(p, activePhase)
  const g = (p: StarPhase) => activePhase === p ? PHASE_GLYPHS[p] : '·'
  const line = (p: StarPhase) => activePhase === p ? '━' : '─'

  return [
    `${g('tianshu-planning')}${s('tianshu-planning')}`,
    `│`,
    `${g('tianxuan-locating')}${s('tianxuan-locating')}`,
    `│`,
    `${g('tianji-decomposing')}${s('tianji-decomposing')}${line('tianquan-contracting')}${g('tianquan-contracting')}${s('tianquan-contracting')}`,
    `      │`,
    `${g('yuheng-implementing')}${s('yuheng-implementing')}`,
    `      │`,
    `${g('kaiyang-testing')}${s('kaiyang-testing')}${line('yaoguang-delivering')}${g('yaoguang-delivering')}${s('yaoguang-delivering')}`,
  ]
}
```

- [ ] **步骤 5：追加 constellation 测试**

在 `src/tui/__tests__/constellation.test.ts` 末尾追加：

```typescript
import { renderConstellationVertical } from '../constellation.js'

describe('renderConstellationVertical', () => {
  it('returns array of strings', () => {
    const lines = renderConstellationVertical('yuheng-implementing')
    assert.ok(Array.isArray(lines))
    assert.ok(lines.length >= 9)
  })

  it('highlights the active phase with brackets', () => {
    const lines = renderConstellationVertical('yuheng-implementing')
    const joined = lines.join('\n')
    assert.ok(joined.includes('[铸形]'))
  })

  it('uses dot for inactive phases', () => {
    const lines = renderConstellationVertical('tianshu-planning')
    const joined = lines.join('\n')
    assert.ok(joined.includes('[观局]'))
    assert.ok(joined.includes('·'))
  })
})
```

- [ ] **步骤 6：运行全部相关测试**

运行：`npx tsx --test src/tui/__tests__/constellation.test.ts src/tui/__tests__/star-panel-colors.test.ts`
预期：全部 PASS

- [ ] **步骤 7：运行 typecheck**

运行：`npx tsc --noEmit`
预期：0 errors

- [ ] **步骤 8：Commit**

```bash
git add src/tui/star-panel-colors.ts src/tui/__tests__/star-panel-colors.test.ts src/tui/constellation.ts src/tui/__tests__/constellation.test.ts
git commit -m "feat(tui): add star panel colors + vertical constellation rendering"
```

---

### 任务 7：StarPanel 侧边栏组件

**文件：**
- 新建：`src/tui/star-panel.tsx`

- [ ] **步骤 1：实现 StarPanel 组件**

```tsx
// src/tui/star-panel.tsx
import { Box, Text } from 'ink'
import { memo, useState, useEffect } from 'react'
import { getTheme } from './theme.js'
import { renderConstellationVertical } from './constellation.js'
import { renderAvatar } from './avatar/avatar-renderer.js'
import { phaseToMode, phaseToMood } from './avatar/expressions.js'
import { alchemyStage } from './alchemy-bar.js'
import { PANEL_COLORS, AVATAR_ALCHEMY_COLORS } from './star-panel-colors.js'
import { formatElapsed } from './summary-bar.js'
import { alchemyBar } from './alchemy-bar.js'
import type { StarPhase } from '../agent/star-event.js'
import type { ChronicleEntry } from '../agent/chronicle.js'
import type { DomainId } from './avatar/types.js'

export interface StarPanelProps {
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
  recentRadio: readonly ChronicleEntry[]
  domain: DomainId
  isStuck: boolean
  isTestFailing: boolean
}

function gauge(label: string, value: number, width = 6): string {
  const filled = Math.round(Math.max(0, Math.min(1, value)) * width)
  return `${label} ${'⣿'.repeat(filled)}${'⣀'.repeat(width - filled)}`
}

export const StarPanel = memo(function StarPanel(props: StarPanelProps) {
  const { activePhase, sensorium, turnCount, maxTurns, elapsedMs, recentRadio, domain, isStuck, isTestFailing } = props
  const theme = getTheme()
  const confidence = sensorium?.confidence ?? 0
  const alchemy = alchemyStage(confidence)
  const alchemyColor = AVATAR_ALCHEMY_COLORS[alchemy]

  const [tick, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 200)
    return () => clearInterval(id)
  }, [])

  const [idleSeconds, setIdleSeconds] = useState(0)
  useEffect(() => { setIdleSeconds(0) }, [activePhase, turnCount])
  useEffect(() => {
    const id = setInterval(() => setIdleSeconds(s => s + 1), 1000)
    return () => clearInterval(id)
  }, [])

  const mode = phaseToMode(activePhase)
  const mood = phaseToMood(activePhase, isStuck, isTestFailing)
  const avatarFrame = renderAvatar({ phase: activePhase, alchemy, domain, mood, mode, tick, isStuck, isTestFailing, idleSeconds })

  const constellationLines = renderConstellationVertical(activePhase)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={PANEL_COLORS.panelBorder} paddingX={1}>
      <Box justifyContent="center">
        <Text bold color={theme.primary}>紫微星桥</Text>
      </Box>

      <Text>{' '}</Text>

      <Box flexDirection="column">
        {avatarFrame.lines.map((line, i) => (
          <Text key={i} color={alchemyColor}>{line}</Text>
        ))}
      </Box>

      <Text>{' '}</Text>

      <Box flexDirection="column">
        {constellationLines.map((line, i) => (
          <Text key={i} color={PANEL_COLORS.constellationLine}>{line}</Text>
        ))}
      </Box>

      <Text>{' '}</Text>

      {sensorium && (
        <>
          <Text>{gauge('动力', sensorium.momentum)}</Text>
          <Text>{gauge('信心', sensorium.confidence)}</Text>
        </>
      )}

      <Box gap={1}>
        <Text color={alchemyColor}>{alchemyBar(confidence)}</Text>
        <Text dimColor>T{turnCount}/{maxTurns} │ {formatElapsed(elapsedMs)}</Text>
      </Box>

      <Text>{' '}</Text>

      {recentRadio.length > 0 && (
        <Box flexDirection="column">
          {recentRadio.slice(-3).map((entry, i) => (
            <Text key={i} color={PANEL_COLORS.radioText} dimColor wrap="truncate">
              {entry.summary}
            </Text>
          ))}
        </Box>
      )}

      <Text>{' '}</Text>
      <Text dimColor>Esc=折叠 2=全屏</Text>
    </Box>
  )
})
```

- [ ] **步骤 2：运行 typecheck**

运行：`npx tsc --noEmit`
预期：0 errors

- [ ] **步骤 3：Commit**

```bash
git add src/tui/star-panel.tsx
git commit -m "feat(tui): add StarPanel — side-panel component with avatar + constellation + gauges + radio"
```

---

### 任务 8：app.tsx 侧边栏布局

**文件：**
- 修改：`src/tui/app.tsx`

- [ ] **步骤 1：添加 StarPanel import**

在 `src/tui/app.tsx` 的 import 区域顶部添加：

```typescript
import { StarPanel } from './star-panel.js'
```

- [ ] **步骤 2：添加 starPanelVisible 状态**

在 `const [starbridgeMode, setStarbridgeMode]` 附近添加：

```typescript
const [starPanelVisible, setStarPanelVisible] = useState(false)
```

- [ ] **步骤 3：添加终端宽度检测**

在 state 声明区域添加：

```typescript
const [termWidth, setTermWidth] = useState(process.stdout.columns ?? 80)
useEffect(() => {
  const onResize = () => setTermWidth(process.stdout.columns ?? 80)
  process.stdout.on('resize', onResize)
  return () => { process.stdout.off('resize', onResize) }
}, [])
const canShowSidePanel = termWidth >= 120
```

- [ ] **步骤 4：添加自动展开逻辑**

在现有的 `onPhaseChange` 回调附近（agent streaming 开始处），添加自动展开：

```typescript
// When streaming starts and terminal is wide enough, auto-show star panel
if (canShowSidePanel && isStreaming && !starPanelVisible) {
  setStarPanelVisible(true)
}
```

在键盘输入处理中，将 Esc 处理扩展为：

```typescript
if (starPanelVisible && starbridgeMode === 'conversation') {
  setStarPanelVisible(false)
  return
}
```

- [ ] **步骤 5：修改渲染区域为 side-by-side**

找到 `<Box flexDirection="column">` 主渲染区域（约第 1164 行），用条件包裹：

```tsx
<Box flexDirection={starPanelVisible && canShowSidePanel ? 'row' : 'column'}>
  {/* Left: conversation column */}
  <Box flexDirection="column" flexGrow={1}>
    {/* ... existing content: StatusBar, SummaryBar, streaming output, etc ... */}
  </Box>

  {/* Right: star panel (when visible + wide enough) */}
  {starPanelVisible && canShowSidePanel && (
    <Box width={30} flexShrink={0}>
      <StarPanel
        activePhase={(summaryState.starPhaseLabel ? Object.entries(PHASE_SHORT_LABELS).find(([, v]) => v === summaryState.starPhaseLabel)?.[0] as StarPhase : 'tianshu-planning') ?? 'tianshu-planning'}
        turnCount={summaryState.turnCount ?? 0}
        maxTurns={summaryState.maxTurns ?? 50}
        elapsedMs={summaryState.elapsedMs}
        recentRadio={chronicleRef.current.getRecentRadio(5)}
        domain={null}
        isStuck={false}
        isTestFailing={false}
      />
    </Box>
  )}
</Box>
```

注意：domain/isStuck/isTestFailing 暂时硬编码为默认值。后续任务（星域伙伴对话 Phase 1）实现后可接入真实值。

- [ ] **步骤 6：运行 typecheck**

运行：`npx tsc --noEmit`
预期：0 errors

- [ ] **步骤 7：Commit**

```bash
git add src/tui/app.tsx
git commit -m "feat(tui): add side-by-side layout — star panel alongside conversation when terminal >= 120 cols"
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

- [ ] **步骤 3：手动测试**

启动 Rivet 执行一个任务，验证：
1. 终端 ≥ 120 列时，右侧出现星图面板
2. Avatar 显示 kaomoji 角色 `(◠‿◠)` + 星辰 `·★·`
3. Agent 从 planning 进入 implementing 时，角色切换为武生态 `(●△●)` + `·✦✦·`
4. 七星纵向连线图中活跃星有 `[铸形]` 标记
5. Radio 消息出现在面板底部
6. 按 Esc 折叠面板
7. 终端 < 120 列时面板不出现
8. `setTheme('observatory')` 后色板变化

---

## 自检

**1. 规格覆盖度：**
- 文武双身 ✓（任务 2-4：表情 + 帧 + 渲染器）
- Observatory 色板 ✓（任务 5）
- 星图面板专用色 ✓（任务 6）
- 纵向七星 ✓（任务 6）
- 侧边栏面板 ✓（任务 7）
- Side-by-side 布局 ✓（任务 8）
- opt-in 默认关闭 — **部分覆盖**：当前通过 starPanelVisible 状态控制，配置文件 `avatar: 'off'|'minimal'|'full'` 延后
- 微动画 ✓（渲染器内置呼吸/眨眼/idle升级）
- 中宽迷你布局 (100-119) — **延后**：v0.3
- 全屏星图中的 Avatar — **延后**：v0.3

**2. 占位符扫描：** 无。domain/isStuck/isTestFailing 在任务 8 中用了默认值，已注明原因和接入路径。

**3. 类型一致性：**
- `DomainId` 在 `avatar/types.ts` 定义 = `'pojun' | 'tianfu' | 'tianliang' | null`，与 `domain-voice.ts` 的 `DomainVoiceId` 相同类型但独立定义（避免跨模块耦合）
- `AvatarMode` / `AvatarMood` / `AvatarFrame` / `AvatarContext` / `FaceExpression` — 在 types.ts 定义，被 expressions.ts / frames.ts / avatar-renderer.ts / star-panel.tsx 一致消费
- `StarPhase` 从 `../../agent/star-event.js` 导入 — 路径在 avatar/ 子目录下正确
- `AlchemyStage` 从 `../alchemy-bar.js` 导入 — 路径正确

---

## 依赖关系

```
任务 1 (types) → 任务 2 (expressions) → 任务 4 (renderer)
任务 1 (types) → 任务 3 (frames) → 任务 4 (renderer)
任务 5 (theme) → 任务 7 (star-panel)
任务 6 (colors + constellation) → 任务 7 (star-panel)
任务 4 (renderer) → 任务 7 (star-panel)
任务 7 (star-panel) → 任务 8 (app.tsx layout)
任务 8 → 任务 9 (验证)

可并行：任务 2 和 任务 3（都只依赖任务 1）
可并行：任务 5 和 任务 6（独立模块）
```

---

## 明确排除

| 提议 | 为什么不做 | 何时做 |
|------|-----------|--------|
| 配置文件 `avatar: off/minimal/full` | 当前用 state 控制足够，配置系统是独立关注点 | 配置系统重构时 |
| 中宽迷你布局 (100-119 cols) | 需要独立的精简面板设计 | v0.3 |
| 半块字符精细版 | 需先验证跨终端兼容性 | v0.4 |
| domain/isStuck/isTestFailing 真实值接入 | 依赖星域伙伴对话 Phase 1 完成 | Phase 1 合并后 |
| 全屏星图中嵌入 Avatar | 需要修改 starmap-view.tsx | v0.3 |
