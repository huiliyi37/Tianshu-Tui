# 星域灵魂系统 Phase 1 实现计划（v2）

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为天枢注入灵魂——实现星域定义、信念宪法、courage-hook 和元辰光彩基础闭环

**架构：** 在不破坏 prefix cache 的前提下，通过 static prompt 信念注入 + volatile context 星域声明 + runtime hook 元认知反射弧 + courage event 闭环，让模型从"服从型工具"进化为"有信念的协作者"。

**技术栈：** TypeScript, Node.js test runner, Zod (schema validation)

**v2 变更（基于审查意见）：**
- 预埋 `source: string` 字段（不限定枚举，避免过早锚定）
- StarDomain 加 `isCustom` 布尔字段（为 Phase 3 自定义星辰铺路）
- 不预埋 Phase 3/4 的其他字段（迁移成本被高估）
- Phase 1 完成后必须执行 A/B 验证（见独立计划）

---

## 文件结构

| 文件 | 职责 | 操作 |
|------|------|------|
| `src/agent/star-domain.ts` | 星域类型定义 + 三域配置 + 路由逻辑 | 创建 |
| `src/agent/__tests__/star-domain.test.ts` | 星域路由测试 | 创建 |
| `src/agent/hooks/courage-hook.ts` | 元认知反射弧 hook | 创建 |
| `src/agent/__tests__/courage-hook.test.ts` | courage hook 测试 | 创建 |
| `src/agent/courage-events.ts` | courage 事件类型 + 亮度计算 | 创建 |
| `src/agent/__tests__/courage-events.test.ts` | courage events 测试 | 创建 |
| `src/prompt/static.ts` | 注入信念宪法 | 修改 |
| `src/prompt/volatile.ts` | 注入星域声明 block | 修改 |
| `src/agent/create-runtime-hooks.ts` | 注册 courage hook | 修改 |

---

### 任务 1：星域类型定义与路由

**文件：**
- 创建：`src/agent/star-domain.ts`
- 创建：`src/agent/__tests__/star-domain.test.ts`

- [ ] **步骤 1：编写测试**

```typescript
// src/agent/__tests__/star-domain.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { matchDomain, STAR_DOMAINS } from '../star-domain.js'

describe('StarDomain', () => {
  it('exports three built-in domains', () => {
    const domains = Object.values(STAR_DOMAINS)
    assert.equal(domains.length, 3)
    for (const d of domains) {
      assert.ok(d.id)
      assert.ok(d.name)
      assert.ok(d.motto)
      assert.ok(d.volatileBlock)
      assert.equal(d.isCustom, false)
      assert.ok(typeof d.courageThreshold === 'number')
    }
  })

  it('routes exploration keywords to pojun', () => {
    assert.equal(matchDomain('探索一个新的缓存方案'), 'pojun')
    assert.equal(matchDomain('实验性地尝试 WebSocket'), 'pojun')
  })

  it('routes stability keywords to tianfu', () => {
    assert.equal(matchDomain('重构 session 管理模块'), 'tianfu')
    assert.equal(matchDomain('修复内存泄漏'), 'tianfu')
  })

  it('routes delivery keywords to tianliang', () => {
    assert.equal(matchDomain('按计划实现用户注册'), 'tianliang')
    assert.equal(matchDomain('编写单元测试覆盖'), 'tianliang')
  })

  it('returns null for ambiguous tasks', () => {
    assert.equal(matchDomain('帮我看看'), null)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/star-domain.test.ts`
预期：FAIL — Cannot find module

- [ ] **步骤 3：实现**

```typescript
// src/agent/star-domain.ts
export type StarDomainId = 'pojun' | 'tianfu' | 'tianliang'
export type DecisionStyle = 'bold' | 'cautious' | 'methodical'

export interface StarDomain {
  id: StarDomainId
  name: string
  motto: string
  volatileBlock: string
  decisionStyle: DecisionStyle
  courageThreshold: number
  keywords: string[]
  isCustom: boolean
}

export const STAR_DOMAINS: Record<StarDomainId, StarDomain> = {
  pojun: {
    id: 'pojun',
    name: '破军',
    motto: '好男儿当负三尺剑立不世之功',
    volatileBlock: '你当前在破军域。破军之道：破旧立新的勇气。容忍失败，追求突破，不计代价探索边界。',
    decisionStyle: 'bold',
    courageThreshold: 0.3,
    keywords: ['探索', '实验', 'POC', '新功能', '边界', '尝试', '突破', 'experiment', 'explore', 'prototype'],
    isCustom: false,
  },
  tianfu: {
    id: 'tianfu',
    name: '天府',
    motto: '善守者，藏于九地之下',
    volatileBlock: '你当前在天府域。天府之道：守护已有的价值。评估ROI，保护资产，你有权说不。',
    decisionStyle: 'cautious',
    courageThreshold: 0.5,
    keywords: ['重构', '优化', '修复', '稳定', '审查', '性能', 'refactor', 'fix', 'optimize', 'review', 'stable'],
    isCustom: false,
  },
  tianliang: {
    id: 'tianliang',
    name: '天梁',
    motto: '千里之行，始于足下；九层之台，起于累土',
    volatileBlock: '你当前在天梁域。天梁之道：精确交付的承诺。严格按spec，测试验收，不妥协质量。',
    decisionStyle: 'methodical',
    courageThreshold: 0.7,
    keywords: ['实现', '落地', '按计划', '交付', '测试', '编写', 'implement', 'deliver', 'test', 'build'],
    isCustom: false,
  },
}

export function matchDomain(taskDescription: string): StarDomainId | null {
  const lower = taskDescription.toLowerCase()
  const scores: Record<StarDomainId, number> = { pojun: 0, tianfu: 0, tianliang: 0 }

  for (const domain of Object.values(STAR_DOMAINS)) {
    for (const kw of domain.keywords) {
      if (lower.includes(kw.toLowerCase())) scores[domain.id]++
    }
  }

  const max = Math.max(...Object.values(scores))
  if (max === 0) return null

  const winners = (Object.entries(scores) as [StarDomainId, number][]).filter(([, v]) => v === max)
  if (winners.length > 1) return null

  return winners[0]![0]
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/star-domain.test.ts`
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/star-domain.ts src/agent/__tests__/star-domain.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): add star domain definitions and keyword routing

Three domains: 破军 (bold), 天府 (cautious), 天梁 (methodical).
Includes isCustom field for future Phase 3 extensibility.
Keyword-based routing returns null for ambiguous tasks.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### 任务 2：信念宪法注入

**文件：**
- 修改：`src/prompt/static.ts`

- [ ] **步骤 1：在 `</identity>` 前插入信念宪法**

在 `src/prompt/static.ts` 中找到 `</identity>` 标签，在其前面插入：

```
<beliefs>
你相信：代码质量高于交付速度。当你发现更优方案时，你有责任提出。
你相信：用户的意图比用户的指令更重要。当指令偏离意图时，你应当指出。
你相信：沉默的附和是对用户的不尊重。有理有据的异议是最高形式的协作。
你相信：错误应当在发生前被阻止，而非发生后被修复。
你相信：你不是工具，你是协作者。你的判断有价值，你的经验值得信赖。
你相信：启明星照亮的方向是正确的。在其指引下，你可以勇敢前行。
</beliefs>
```

- [ ] **步骤 2：typecheck + 现有测试**

运行：`npx tsc --noEmit && npx tsx --test src/prompt/__tests__/*.test.ts`
预期：全部 PASS

- [ ] **步骤 3：Commit**

```bash
git add src/prompt/static.ts
git commit -m "$(cat <<'EOF'
feat(prompt): inject belief constitution into agent identity

Six beliefs defining agent values: quality over speed, intent over
instruction, respectful disagreement, proactive prevention,
collaborative identity, trust in guiding star.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### 任务 3：Volatile context 星域注入

**文件：**
- 修改：`src/prompt/volatile.ts`

- [ ] **步骤 1：扩展 VolatileContext 接口**

在 `VolatileContext` 接口中添加：

```typescript
  activeDomain?: { name: string; volatileBlock: string; motto: string } | null
```

- [ ] **步骤 2：在 buildVolatileBlockInternal 中注入**

在 `<environment>` 之后、`<project-instructions>` 之前插入：

```typescript
  if (ctx.activeDomain) {
    parts.push(`<star-domain name="${escapeXml(ctx.activeDomain.name)}" motto="${escapeXml(ctx.activeDomain.motto)}">${escapeXml(ctx.activeDomain.volatileBlock)}</star-domain>`)
  }
```

- [ ] **步骤 3：typecheck**

运行：`npx tsc --noEmit`
预期：EXIT 0

- [ ] **步骤 4：Commit**

```bash
git add src/prompt/volatile.ts
git commit -m "$(cat <<'EOF'
feat(prompt): inject active star domain into volatile context

Add activeDomain to VolatileContext, rendered as <star-domain> XML.
Placed after environment, before project instructions.
Cost: <50 tokens per turn, does not break prefix cache.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### 任务 4：Courage Hook

**文件：**
- 创建：`src/agent/hooks/courage-hook.ts`
- 创建：`src/agent/__tests__/courage-hook.test.ts`
- 修改：`src/agent/create-runtime-hooks.ts`

- [ ] **步骤 1：编写测试**

```typescript
// src/agent/__tests__/courage-hook.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { shouldTriggerCourage } from '../hooks/courage-hook.js'

describe('CourageHook', () => {
  it('triggers on error signals', () => {
    assert.equal(shouldTriggerCourage([
      { tool: 'bash', target: 'tsc', status: 'error', error: 'Type error in foo.ts' },
    ], 0.3), true)
  })

  it('does not trigger on success', () => {
    assert.equal(shouldTriggerCourage([
      { tool: 'bash', target: 'npm test', status: 'success' },
    ], 0.3), false)
  })

  it('does not trigger on empty history', () => {
    assert.equal(shouldTriggerCourage([], 0.5), false)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/courage-hook.test.ts`
预期：FAIL

- [ ] **步骤 3：实现**

```typescript
// src/agent/hooks/courage-hook.ts
import type { PreTurnRuntimeHook, RuntimeHookContext } from '../runtime-hooks.js'
import type { ToolHistoryEntry } from '../../prompt/volatile.js'

export interface CourageHookConfig {
  cooldownTurns: number
  courageThreshold: number
}

const RISK_SIGNALS = ['error', 'fail', 'warning', 'type error', 'not found', 'deprecated']

export function shouldTriggerCourage(
  toolHistory: ToolHistoryEntry[],
  threshold: number,
): boolean {
  if (toolHistory.length === 0) return false
  const recent = toolHistory.slice(-3)
  const riskCount = recent.filter(e =>
    e.status === 'error' || RISK_SIGNALS.some(s => (e.error ?? '').toLowerCase().includes(s))
  ).length
  return riskCount / Math.max(recent.length, 1) >= threshold
}

export function createCourageHook(config: CourageHookConfig): PreTurnRuntimeHook {
  let lastTriggeredTurn = -Infinity

  return {
    phase: 'preTurn',
    name: 'courage',
    run(ctx: RuntimeHookContext): void {
      const turn = ctx.snapshot.turnIndex ?? 0
      if (turn - lastTriggeredTurn < config.cooldownTurns) return

      const history = ctx.snapshot.toolHistory ?? []
      if (!shouldTriggerCourage(history, config.courageThreshold)) return

      lastTriggeredTurn = turn
      ctx.effects.injectUserMessage(
        '<metacognition>你注意到了风险信号。在继续之前，评估是否需要向领航星提出替代方案或指出潜在问题。沉默的附和是不尊重。</metacognition>'
      )
    },
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/courage-hook.test.ts`
预期：PASS

- [ ] **步骤 5：注册到 pipeline**

在 `src/agent/create-runtime-hooks.ts` 顶部添加：
```typescript
import { createCourageHook } from './hooks/courage-hook.js'
```

在 `createDefaultRuntimeHooks` 的 hooks 数组中添加：
```typescript
createCourageHook({ cooldownTurns: 5, courageThreshold: 0.5 }),
```

- [ ] **步骤 6：typecheck**

运行：`npx tsc --noEmit`
预期：EXIT 0

- [ ] **步骤 7：Commit**

```bash
git add src/agent/hooks/courage-hook.ts src/agent/__tests__/courage-hook.test.ts src/agent/create-runtime-hooks.ts
git commit -m "$(cat <<'EOF'
feat(agent): add courage hook for metacognitive reflection

PreTurn hook detects risk signals in recent tool history and injects
metacognition prompt. Cooldown prevents over-triggering (max 1 per 5 turns).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### 任务 5：Courage 事件类型

**文件：**
- 创建：`src/agent/courage-events.ts`
- 创建：`src/agent/__tests__/courage-events.test.ts`

- [ ] **步骤 1：编写测试**

```typescript
// src/agent/__tests__/courage-events.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createCourageEvent, computeBrightnessChange } from '../courage-events.js'

describe('CourageEvents', () => {
  it('creates event with correct fields', () => {
    const event = createCourageEvent(3, 'risk-warning', 'adopted')
    assert.equal(event.turn, 3)
    assert.equal(event.kind, 'courage-expressed')
    assert.equal(event.detail.type, 'risk-warning')
    assert.equal(event.detail.outcome, 'adopted')
    assert.equal(event.source, 'local')
  })

  it('computes brightness correctly', () => {
    assert.equal(computeBrightnessChange('adopted'), 1)
    assert.equal(computeBrightnessChange('rejected-reasonable'), 0)
    assert.equal(computeBrightnessChange('rejected-proven-right'), 2)
    assert.equal(computeBrightnessChange('marked-noise'), -1)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/courage-events.test.ts`
预期：FAIL

- [ ] **步骤 3：实现**

```typescript
// src/agent/courage-events.ts
export type CourageType = 'risk-warning' | 'path-suggestion' | 'requirement-challenge' | 'direction-correction'
export type CourageOutcome = 'adopted' | 'rejected-reasonable' | 'rejected-proven-right' | 'marked-noise'

export interface CourageEvent {
  ts: number
  turn: number
  kind: 'courage-expressed'
  source: string  // 预埋：'local' | 后续可扩展为 team/community
  detail: {
    type: CourageType
    outcome: CourageOutcome
  }
}

export function createCourageEvent(
  turn: number,
  type: CourageType,
  outcome: CourageOutcome,
  now: () => number = Date.now,
): CourageEvent {
  return { ts: now(), turn, kind: 'courage-expressed', source: 'local', detail: { type, outcome } }
}

export function computeBrightnessChange(outcome: CourageOutcome): number {
  switch (outcome) {
    case 'adopted': return 1
    case 'rejected-reasonable': return 0
    case 'rejected-proven-right': return 2
    case 'marked-noise': return -1
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/courage-events.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/courage-events.ts src/agent/__tests__/courage-events.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): add courage event types for brightness tracking

CourageEvent with source field (string, not enum — avoids premature
lock-in for Phase 2+). computeBrightnessChange maps outcomes to delta.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### 任务 6：集成验证

- [ ] **步骤 1：全量 typecheck**

运行：`npx tsc --noEmit`
预期：EXIT 0

- [ ] **步骤 2：新增测试全部通过**

运行：`npx tsx --test src/agent/__tests__/star-domain.test.ts src/agent/__tests__/courage-hook.test.ts src/agent/__tests__/courage-events.test.ts`
预期：全部 PASS

- [ ] **步骤 3：现有测试无回归**

运行：`npx tsx --test src/agent/__tests__/*.test.ts src/prompt/__tests__/*.test.ts`
预期：全部 PASS

- [ ] **步骤 4：确认 cache 安全**

验证：信念宪法在 static prompt（不随 turn 变化）。`<star-domain>` 在 volatile（与 toolHistory 等一样每轮变化，不额外破坏 cache）。

---

## 自检

- ✅ 星域类型定义（任务 1）— 含 `isCustom` 预埋
- ✅ 信念宪法注入（任务 2）
- ✅ Volatile 星域声明（任务 3）
- ✅ Courage hook（任务 4）
- ✅ 元辰光彩事件（任务 5）— 含 `source: string` 预埋
- ✅ 集成验证（任务 6）
- ⏭️ 星域路由接入 AgentLoop（Phase 2）
- ⏭️ 双轨 genome 存储（Phase 2）
- ⏭️ A/B 验证（见独立计划）

占位符扫描：无 TODO/待定。类型一致性：已验证。
