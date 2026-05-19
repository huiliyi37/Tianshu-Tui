# 星域伙伴对话 Phase 1 实施计划 — Layer 2（在场心跳）+ Layer 4（星域之声）

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 升级天枢无线电的两个维度——(1) phase 内心跳从纯状态简报变为带上下文的思考过程信息 (2) 所有消息根据当前星域（破军/天府/天梁）做语气适配。

**架构：** 新建 `domain-voice.ts` 提供纯函数语气转换。扩展 `radio-templates.ts` 增加 5 个 phase-aware 心跳模板。修改 `radio-hook.ts` 增加心跳触发（phase 内每 6 turn）+ 语气转换管线。通过 `RadioHookDeps` 注入 domain getter。

**技术栈：** TypeScript strict, node:test + node:assert/strict, ESM

**范围约束：** 仅 Layer 2 + Layer 4。Layer 1（勇气阈值调整）和 Layer 3（主动对话）延后——前者等数据，后者等暂停机制。

---

## 文件结构

| 文件 | 职责 |
|------|------|
| 新建 `src/agent/domain-voice.ts` | 纯函数：语气转换表 + `applyDomainVoice(message, domainId)` |
| 修改 `src/agent/radio-templates.ts` | 新增 5 个 HEARTBEAT_TEMPLATES（按 phaseClass 区分） |
| 修改 `src/agent/hooks/radio-hook.ts` | 新增心跳触发 + 语气转换管线 + deps 扩展 |
| 修改 `src/agent/create-runtime-hooks.ts` | 传入 domain getter |
| 新建 `src/agent/__tests__/domain-voice.test.ts` | 语气转换测试 |
| 修改 `src/agent/__tests__/radio-templates.test.ts` | 心跳模板测试 |

---

### 任务 1：星域语气转换器

**文件：**
- 新建：`src/agent/domain-voice.ts`
- 测试：`src/agent/__tests__/domain-voice.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/agent/__tests__/domain-voice.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyDomainVoice, type DomainVoiceId } from '../domain-voice.js'

describe('applyDomainVoice', () => {
  it('transforms message for pojun domain', () => {
    const msg = '[天枢] 开始修改。预计修改 middleware.ts。'
    const result = applyDomainVoice(msg, 'pojun')
    assert.ok(result.includes('开干'))
    assert.ok(!result.includes('开始修改'))
  })

  it('transforms message for tianfu domain', () => {
    const msg = '[天枢] 开始修改。预计修改 middleware.ts。'
    const result = applyDomainVoice(msg, 'tianfu')
    assert.ok(result.includes('审慎'))
  })

  it('transforms message for tianliang domain', () => {
    const msg = '[天枢] 测试全部通过，准备交付结果。'
    const result = applyDomainVoice(msg, 'tianliang')
    assert.ok(result.includes('验收通过'))
  })

  it('returns message unchanged when no domain', () => {
    const msg = '[天枢] 收到任务，开始分析。'
    const result = applyDomainVoice(msg, null)
    assert.equal(result, msg)
  })

  it('returns message unchanged when no matching phrase', () => {
    const msg = '[天枢] 上下文即将满，准备压缩。'
    const result = applyDomainVoice(msg, 'pojun')
    assert.equal(result, msg)
  })

  it('replaces [天枢] prefix with domain prefix', () => {
    const msg = '[天枢] 收到任务，开始分析。'
    const result = applyDomainVoice(msg, 'pojun')
    assert.ok(result.startsWith('[天枢·破军]'))
  })

  it('replaces prefix for tianfu', () => {
    const msg = '[天枢] 收到任务。'
    const result = applyDomainVoice(msg, 'tianfu')
    assert.ok(result.startsWith('[天枢·天府]'))
  })

  it('replaces prefix for tianliang', () => {
    const msg = '[天枢] 收到任务。'
    const result = applyDomainVoice(msg, 'tianliang')
    assert.ok(result.startsWith('[天枢·天梁]'))
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/domain-voice.test.ts`
预期：FAIL — cannot find module '../domain-voice.js'

- [ ] **步骤 3：实现 domain-voice.ts**

```typescript
// src/agent/domain-voice.ts

export type DomainVoiceId = 'pojun' | 'tianfu' | 'tianliang' | null

const DOMAIN_NAMES: Record<string, string> = {
  pojun: '破军',
  tianfu: '天府',
  tianliang: '天梁',
}

const DOMAIN_TONE: Record<string, Array<[string, string]>> = {
  pojun: [
    ['开始修改', '开干了'],
    ['正在修复', '修它'],
    ['准备制定方案', '脑子已经热了，在想方案'],
    ['测试全部通过', '过了！'],
    ['可能遇到困难', '卡了一下，但没关系'],
    ['代码修改完成', '改完了'],
    ['运行测试验证', '跑个测试看看'],
    ['准备交付结果', '搞定，准备交货'],
    ['收到任务，开始分析', '收到，开搞'],
    ['接近完成', '快了'],
  ],
  tianfu: [
    ['开始修改', '开始审慎修改'],
    ['正在修复', '正在排查修复'],
    ['准备制定方案', '评估完毕，制定稳妥方案'],
    ['测试全部通过', '验证通过，风险可控'],
    ['可能遇到困难', '遇到了边界情况，正在评估影响'],
    ['代码修改完成', '修改已完成，准备验证'],
    ['运行测试验证', '开始全面验证'],
    ['准备交付结果', '验证通过，准备安全交付'],
    ['收到任务，开始分析', '收到任务，先评估风险'],
    ['接近完成', '接近完成，做最后检查'],
  ],
  tianliang: [
    ['开始修改', '按计划逐步实现'],
    ['正在修复', '定位根因，逐项修复'],
    ['准备制定方案', '方案已对齐 spec，开始推进'],
    ['测试全部通过', '全部验收通过 ✓'],
    ['可能遇到困难', '当前步骤复杂度超过预期，重新评估'],
    ['代码修改完成', '实现完毕，进入验收'],
    ['运行测试验证', '按验收标准逐项检查'],
    ['准备交付结果', '交付准备就绪，质量达标'],
    ['收到任务，开始分析', '收到任务，对齐需求中'],
    ['接近完成', '最后验收项'],
  ],
}

export function applyDomainVoice(message: string, domainId: DomainVoiceId): string {
  if (!domainId) return message

  let result = message

  // Replace [天枢] prefix with domain-specific prefix
  const domainName = DOMAIN_NAMES[domainId]
  if (domainName) {
    result = result.replace('[天枢]', `[天枢·${domainName}]`)
  }

  // Apply tone substitutions
  const toneTable = DOMAIN_TONE[domainId]
  if (toneTable) {
    for (const [from, to] of toneTable) {
      result = result.replace(from, to)
    }
  }

  return result
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/domain-voice.test.ts`
预期：8 tests PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/domain-voice.ts src/agent/__tests__/domain-voice.test.ts
git commit -m "feat(agent): add domain-voice — star domain tone adaptation for radio messages"
```

---

### 任务 2：心跳模板

**文件：**
- 修改：`src/agent/radio-templates.ts`
- 测试：`src/agent/__tests__/radio-templates.test.ts`（追加）

- [ ] **步骤 1：在 TEMPLATES 对象后新增 HEARTBEAT_TEMPLATES**

在 `src/agent/radio-templates.ts` 的 `const FALLBACK_TEMPLATE` 定义之后（第 55 行后）添加：

```typescript
export const HEARTBEAT_TEMPLATES: Record<string, string> = {
  'explore':  '[天枢] 还在了解代码结构{topFiles}。',
  'plan':     '[天枢] 方案在成形，第 {turnCount} 轮思考。',
  'execute':  '[天枢] 正在修改{targetFiles}，进展顺利。',
  'verify':   '[天枢] 验证中{errorBrief}。',
  'deliver':  '[天枢] 最后检查，马上好。',
}

export function formatHeartbeatMessage(phaseClass: string, vars: TemplateVars): string {
  const template = HEARTBEAT_TEMPLATES[phaseClass] ?? FALLBACK_TEMPLATE
  let msg = template
  const entries = Object.entries(vars) as [string, string | number][]
  for (const [key, val] of entries) {
    if (val === '' || val === 0) {
      msg = msg.replace(new RegExp(`\\s*\\{${key}\\}`, 'g'), '')
    } else {
      msg = msg.replace(new RegExp(`\\{${key}\\}`, 'g'), String(val))
    }
  }
  return msg.replace(/ {2,}/g, ' ')
}
```

- [ ] **步骤 2：追加心跳模板测试**

在 `src/agent/__tests__/radio-templates.test.ts` 末尾追加：

```typescript
import { formatHeartbeatMessage } from '../radio-templates.js'

describe('formatHeartbeatMessage', () => {
  it('formats explore heartbeat with file names', () => {
    const vars: TemplateVars = { fileCount: 8, topFiles: '（auth.ts, types.ts）', targetFiles: '', errorBrief: '', lastFailedTool: '', failCount: 0, phaseName: '寻迹', turnCount: 5 }
    const msg = formatHeartbeatMessage('explore', vars)
    assert.ok(msg.includes('天枢'))
    assert.ok(msg.includes('代码结构'))
    assert.ok(msg.includes('auth.ts'))
  })

  it('formats execute heartbeat with target files', () => {
    const vars: TemplateVars = { fileCount: 0, topFiles: '', targetFiles: 'middleware.ts, handler.ts', errorBrief: '', lastFailedTool: '', failCount: 0, phaseName: '铸形', turnCount: 15 }
    const msg = formatHeartbeatMessage('execute', vars)
    assert.ok(msg.includes('修改'))
    assert.ok(msg.includes('middleware.ts'))
  })

  it('formats verify heartbeat with error brief', () => {
    const vars: TemplateVars = { fileCount: 0, topFiles: '', targetFiles: '', errorBrief: '1 个失败', lastFailedTool: '', failCount: 1, phaseName: '试锋', turnCount: 20 }
    const msg = formatHeartbeatMessage('verify', vars)
    assert.ok(msg.includes('验证'))
  })

  it('uses fallback for unknown phase class', () => {
    const vars: TemplateVars = { fileCount: 0, topFiles: '', targetFiles: '', errorBrief: '', lastFailedTool: '', failCount: 0, phaseName: '未知', turnCount: 10 }
    const msg = formatHeartbeatMessage('unknown', vars)
    assert.ok(msg.includes('天枢'))
  })
})
```

- [ ] **步骤 3：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/radio-templates.test.ts`
预期：11 tests PASS（原有 7 + 新增 4）

- [ ] **步骤 4：Commit**

```bash
git add src/agent/radio-templates.ts src/agent/__tests__/radio-templates.test.ts
git commit -m "feat(agent): add heartbeat templates — phase-aware presence signals for radio"
```

---

### 任务 3：Radio hook 心跳触发 + 语气管线

**文件：**
- 修改：`src/agent/hooks/radio-hook.ts`
- 修改：`src/agent/__tests__/radio-hook.test.ts`（追加）

- [ ] **步骤 1：扩展 RadioHookDeps 接入 domain**

在 `src/agent/hooks/radio-hook.ts` 的 `RadioHookDeps` 接口（第 92-97 行）中新增：

```typescript
export interface RadioHookDeps {
  chronicle?: {
    addRadio: (message: string, turn: number) => void
    addPhaseTransition: (input: { fromPhase: string; toPhase: string; turn: number; summary: string }) => void
  }
  getDomainId?: () => 'pojun' | 'tianfu' | 'tianliang' | null
}
```

- [ ] **步骤 2：新增 import**

在文件顶部 import 区域添加：

```typescript
import { formatHeartbeatMessage } from '../radio-templates.js'
import { applyDomainVoice } from '../domain-voice.js'
```

- [ ] **步骤 3：新增心跳状态和常量**

在内部状态区域（`let lastPhase` 附近，约第 101 行）新增：

```typescript
const HEARTBEAT_INTERVAL = 6
let turnsInCurrentPhase = 0
let lastHeartbeatTurn = -Infinity
```

- [ ] **步骤 4：新增 emit 包装函数（语气管线）**

在 `run()` 函数内部开头添加一个 helper：

```typescript
function emit(message: string, turn: number): void {
  const voiced = applyDomainVoice(message, deps?.getDomainId?.() ?? null)
  effects.emitPhaseChange('tianshu-radio', { reason: voiced })
  deps?.chronicle?.addRadio(voiced, turn)
}
```

然后将所有现有的 `effects.emitPhaseChange('tianshu-radio', { reason: message })` + `deps?.chronicle?.addRadio(message, turn)` 替换为 `emit(message, turn)`。注意 session_start 那个硬编码消息也需要走 emit。

- [ ] **步骤 5：新增心跳逻辑**

在 stuck detection 之前（约第 193 行之前），添加心跳检测：

```typescript
// 7.5 Heartbeat — presence signal within a phase (every HEARTBEAT_INTERVAL turns)
turnsInCurrentPhase++
if (lastPhase !== null && currentPhase === lastPhase) {
  if (turnsInCurrentPhase >= HEARTBEAT_INTERVAL && turn - lastHeartbeatTurn >= HEARTBEAT_INTERVAL) {
    const toolHistory = snapshot.recentToolHistory.map(e => ({
      tool: e.tool, target: e.target ?? '', status: e.status,
    }))
    const vars = extractTemplateVars(toolHistory)
    vars.phaseName = PHASE_SHORT_LABELS[starPhase]
    vars.turnCount = turnsInCurrentPhase
    const message = formatHeartbeatMessage(currentPhase, vars)
    emit(message, turn)
    lastHeartbeatTurn = turn
  }
}
```

在 phase transition 处重置计数器：

```typescript
// 在 phase 变化后
turnsInCurrentPhase = 0
lastHeartbeatTurn = turn
```

- [ ] **步骤 6：追加测试**

在 `src/agent/__tests__/radio-hook.test.ts` 末尾追加：

```typescript
describe('heartbeat', () => {
  it('emits heartbeat after 6 turns in same phase', () => {
    const hook = createRadioHook()
    const emittedAll: string[] = []

    for (let turn = 0; turn < 10; turn++) {
      const snapshot = makeSnapshot({
        turn,
        sensorium: { momentum: 0.7, pressure: 0.3, confidence: 0.8, complexity: 0.3, freshness: 0.6, stability: 0.8 },
        recentToolHistory: [{ tool: 'edit_file', target: 'src/auth.ts', status: 'success' }],
      })
      const { ctx, emitted } = makeCtx(snapshot)
      hook.run(ctx, { name: 'edit_file', success: true, target: 'src/auth.ts' })
      emittedAll.push(...emitted)
    }

    // Should have session_start + at least 1 heartbeat
    const heartbeats = emittedAll.filter(e => e.includes('修改') || e.includes('进展'))
    assert.ok(heartbeats.length >= 1, `Expected heartbeat, got: ${emittedAll.join('; ')}`)
  })
})

describe('domain voice', () => {
  it('applies domain tone when getDomainId is provided', () => {
    const hook = createRadioHook({ getDomainId: () => 'pojun' })
    const snapshot = makeSnapshot({ turn: 0 })
    const { ctx, emitted } = makeCtx(snapshot)
    hook.run(ctx, { name: 'read_file', success: true, target: 'src/a.ts' })
    assert.ok(emitted.some(e => e.includes('破军')), `Expected 破军 prefix, got: ${emitted.join('; ')}`)
  })
})
```

- [ ] **步骤 7：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/radio-hook.test.ts`
预期：全部通过（原有 + 新增 2）

- [ ] **步骤 8：运行 typecheck**

运行：`npx tsc --noEmit`
预期：0 errors

- [ ] **步骤 9：Commit**

```bash
git add src/agent/hooks/radio-hook.ts src/agent/__tests__/radio-hook.test.ts
git commit -m "feat(agent): add heartbeat presence + domain voice pipeline to radio hook"
```

---

### 任务 4：注入 domain getter 到 hook pipeline

**文件：**
- 修改：`src/agent/create-runtime-hooks.ts`

- [ ] **步骤 1：扩展 RuntimeHookDeps**

在 `RuntimeHookDeps` 接口中的 `chronicle` 字段之后添加：

```typescript
getDomainId?: () => 'pojun' | 'tianfu' | 'tianliang' | null
```

- [ ] **步骤 2：传入 getDomainId 到 createRadioHook**

将现有的 `createRadioHook({ chronicle: deps.chronicle })` 改为：

```typescript
createRadioHook({ chronicle: deps.chronicle, getDomainId: deps.getDomainId }),
```

- [ ] **步骤 3：运行 typecheck + 测试**

运行：`npx tsc --noEmit && npx tsx --test src/agent/__tests__/create-runtime-hooks.test.ts`
预期：全部通过

- [ ] **步骤 4：Commit**

```bash
git add src/agent/create-runtime-hooks.ts
git commit -m "feat(agent): pass getDomainId to radio hook for star domain voice"
```

---

### 任务 5：在 AgentLoop 中接入 getDomainId

**文件：**
- 修改：`src/agent/loop.ts`

- [ ] **步骤 1：找到 createDefaultRuntimeHooks 调用位置**

在 `loop.ts` 中搜索 `createDefaultRuntimeHooks`，找到传入 deps 的位置。在 deps 对象中新增：

```typescript
getDomainId: () => {
  if (!this.sessionDomain) return null
  const name = this.sessionDomain.name
  if (name === '破军') return 'pojun'
  if (name === '天府') return 'tianfu'
  if (name === '天梁') return 'tianliang'
  return null
},
```

注意：`this.sessionDomain` 是 `ActiveStarDomain | null | undefined`，类型是 `{ name: string; volatileBlock: string; motto: string }`。通过 `name` 字段（中文）反查 domainId。

- [ ] **步骤 2：运行 typecheck**

运行：`npx tsc --noEmit`
预期：0 errors

- [ ] **步骤 3：Commit**

```bash
git add src/agent/loop.ts
git commit -m "feat(agent): wire getDomainId from session domain into runtime hook deps"
```

---

### 任务 6：全量验证

**文件：** 无新文件

- [ ] **步骤 1：运行 typecheck**

运行：`npx tsc --noEmit`
预期：0 errors

- [ ] **步骤 2：运行全量测试**

运行：`npm test`
预期：全部 PASS

- [ ] **步骤 3：手动测试**

启动 Rivet 执行一个任务（自动匹配到某个星域），验证：
1. radio 消息前缀变为 `[天枢·破军]` / `[天枢·天府]` / `[天枢·天梁]`（取决于任务匹配）
2. phase 内不再有纯"停留 N turn"消息，而是带上下文的心跳（"还在了解代码结构"、"正在修改 middleware.ts，进展顺利"）
3. 没有匹配到星域时消息不变（`[天枢]` 前缀 + 通用措辞）
4. 心跳频率合理（每 6 turn 左右一次，不过密）

---

## 自检

**1. 规格覆盖度：**
- Layer 2 在场心跳 ✓（任务 2 模板 + 任务 3 触发逻辑）
- Layer 4 星域之声 ✓（任务 1 语气转换 + 任务 3 管线 + 任务 4-5 接入）
- Layer 1 诚实基线 — **延后**（等数据）
- Layer 3 主动对话 — **延后**（等暂停机制）

**2. 占位符扫描：** 无。

**3. 类型一致性：**
- `DomainVoiceId` = `'pojun' | 'tianfu' | 'tianliang' | null`，在 domain-voice.ts 定义，radio-hook.ts 的 getDomainId 返回类型匹配
- `RadioHookDeps.getDomainId` 在 radio-hook.ts 定义，create-runtime-hooks.ts 传入，loop.ts 提供实现——类型链一致
- `formatHeartbeatMessage` 在 radio-templates.ts 导出，radio-hook.ts 消费——参数类型一致
- `TemplateVars` 在两处使用——一致

---

## 验收标准

- [ ] `npm run typecheck` — 0 errors
- [ ] `npm test` — 全部 PASS
- [ ] 破军域任务的 radio 消息包含 `[天枢·破军]` 前缀 + 破军语气
- [ ] 天府域任务的 radio 消息包含 `[天枢·天府]` 前缀 + 天府语气
- [ ] 天梁域任务的 radio 消息包含 `[天枢·天梁]` 前缀 + 天梁语气
- [ ] phase 内每 ~6 turn 出现一次心跳消息（带实际上下文，非纯状态）
- [ ] 无域匹配时消息不变
- [ ] Token 开销不增加（措辞替换保持长度相似）

---

## 明确排除

| 提议 | 为什么不做 | 何时做 |
|------|-----------|--------|
| Layer 1: 勇气阈值 0.5→0.3 | 无数据支撑当前阈值漏报率 | 收集 10 session 勇气触发日志后 |
| Layer 3: 主动对话 | agent 问了问题但不暂停等回答，比不问更糟 | 实现 intent preview 类暂停机制后 |
| radio-hook 拆分为多 hook | 当前 ~250 行可管理，拆分有 hook 排序风险 | 膨胀到 400+ 行时 |
| 星域 voiceSignature 注入 system prompt | 语气转换在 harness 层模板替换已足够 | LLM 原生风格适配需求出现时 |

---

## 依赖关系

```
任务 1（domain-voice）→ 任务 3（radio-hook 消费 applyDomainVoice）
任务 2（heartbeat templates）→ 任务 3（radio-hook 消费 formatHeartbeatMessage）
任务 3（radio-hook 改动）→ 任务 4（create-runtime-hooks 传入 getDomainId）
任务 4（create-runtime-hooks）→ 任务 5（loop.ts 提供 getDomainId 实现）
任务 5 → 任务 6（验证）

可并行：任务 1 和 任务 2 无依赖
```
