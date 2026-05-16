# Wave 8: Context Fabric Phase 2 — Claim 自动提取 + TTL + 晋升 实施计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 claim store 从"只有 user message anchors"变成"tool results + test failures + file observations 自动产生 claims"，加 TTL 防膨胀，加晋升触发让高价值 claims 跨 session 存活。

**架构：** 在 AgentLoop 的 tool result 处理路径中插入 claim 提取逻辑。新建 `claim-extractor.ts` 封装提取规则。在每轮结束时触发 `promoteEligibleClaims()`。Session resume 时加载上一 session 的 durable claims。

**技术栈：** TypeScript, 现有 claim-store/claims/promotion/failure-classifier infrastructure

**前置条件：** ECF Phase 1 ✅ + Wave 7 ✅

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/context/claim-extractor.ts` | 从 tool results 提取 claim proposals（规则引擎） |
| `src/context/__tests__/claim-extractor.test.ts` | 提取规则测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/agent/loop.ts` | tool result 后调用 claim extractor + 每轮结束触发 promotion |
| `src/context/promotion.ts` | 增加 `durable_candidate → durable` 晋升规则 |
| `src/context/__tests__/promotion.test.ts` | durable 晋升测试 |
| `src/agent/session-persist.ts` | resume 时加载上一 session 的 durable claims |
| `src/main.tsx` | session resume 路径注入 durable claims |

---

## 任务 1：Claim Extractor — 从 tool results 提取 claims

**文件：**
- 创建：`src/context/claim-extractor.ts`
- 测试：`src/context/__tests__/claim-extractor.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/context/__tests__/claim-extractor.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractClaimsFromToolResult, type ToolResultContext } from '../claim-extractor.js'

describe('claim-extractor', () => {
  const meta = { sessionId: 'session-1', turn: 3, eventId: 'turn-3:tool' }

  it('extracts file_observation from read_file result', () => {
    const ctx: ToolResultContext = {
      toolName: 'read_file',
      input: { file_path: '/repo/src/config.ts' },
      result: 'export const MAX_RETRIES = 3\nexport const TIMEOUT = 5000',
      isError: false,
    }
    const proposals = extractClaimsFromToolResult(ctx, meta)
    assert.equal(proposals.length, 1)
    assert.equal(proposals[0]!.kind, 'file_observation')
    assert.equal(proposals[0]!.scope, 'session')
    assert.ok(proposals[0]!.text.includes('config.ts'))
    assert.ok(proposals[0]!.evidence[0]!.path === '/repo/src/config.ts')
    assert.ok(proposals[0]!.expiresAt! > Date.now())
  })

  it('extracts failure_pattern from run_tests error', () => {
    const ctx: ToolResultContext = {
      toolName: 'run_tests',
      input: { command: 'npm test' },
      result: 'FAIL src/__tests__/auth.test.ts\n  ✗ login rejects invalid token\n    Error: expected 401 got 200',
      isError: true,
    }
    const proposals = extractClaimsFromToolResult(ctx, meta)
    assert.equal(proposals.length, 1)
    assert.equal(proposals[0]!.kind, 'failure_pattern')
    assert.ok(proposals[0]!.text.includes('auth.test.ts'))
    assert.equal(proposals[0]!.confidence, 0.8)
  })

  it('extracts verification_fact from run_tests success', () => {
    const ctx: ToolResultContext = {
      toolName: 'run_tests',
      input: { command: 'npm test' },
      result: 'Tests: 797 pass, 0 fail\nDuration: 9.2s',
      isError: false,
    }
    const proposals = extractClaimsFromToolResult(ctx, meta)
    assert.equal(proposals.length, 1)
    assert.equal(proposals[0]!.kind, 'verification_fact')
    assert.ok(proposals[0]!.text.includes('797 pass'))
  })

  it('skips grep/glob results (too noisy)', () => {
    const ctx: ToolResultContext = {
      toolName: 'grep',
      input: { pattern: 'TODO' },
      result: 'src/a.ts:5: // TODO fix\nsrc/b.ts:10: // TODO later',
      isError: false,
    }
    const proposals = extractClaimsFromToolResult(ctx, meta)
    assert.equal(proposals.length, 0)
  })

  it('extracts security_finding from bash with security-related output', () => {
    const ctx: ToolResultContext = {
      toolName: 'bash',
      input: { command: 'npm audit' },
      result: '3 vulnerabilities found\n  high: prototype-pollution in lodash',
      isError: false,
    }
    const proposals = extractClaimsFromToolResult(ctx, meta)
    assert.equal(proposals.length, 1)
    assert.equal(proposals[0]!.kind, 'security_finding')
  })

  it('assigns TTL based on claim kind', () => {
    const ctx: ToolResultContext = {
      toolName: 'read_file',
      input: { file_path: '/repo/src/a.ts' },
      result: 'const x = 1',
      isError: false,
    }
    const proposals = extractClaimsFromToolResult(ctx, meta)
    const ttl = proposals[0]!.expiresAt! - proposals[0]!.createdAt
    // file_observation TTL = 30 minutes
    assert.ok(ttl >= 29 * 60_000 && ttl <= 31 * 60_000)
  })
})
```

- [ ] **步骤 2：运行测试确认失败**

运行：`npm test -- src/context/__tests__/claim-extractor.test.ts`
预期：FAIL（模块不存在）

- [ ] **步骤 3：实现 claim-extractor.ts**

```typescript
// src/context/claim-extractor.ts
import type { ClaimProposal, ContextClaimKind, EvidenceKind } from './claims.js'

export interface ToolResultContext {
  toolName: string
  input: Record<string, unknown>
  result: string
  isError: boolean
}

export interface ClaimExtractionMeta {
  sessionId: string
  turn: number
  eventId: string
}

const TTL: Record<ContextClaimKind, number> = {
  file_observation: 30 * 60_000,
  verification_fact: 60 * 60_000,
  failure_pattern: 120 * 60_000,
  security_finding: 240 * 60_000,
  user_constraint: Infinity,
  user_preference: Infinity,
  decision: Infinity,
  worker_finding: 60 * 60_000,
  project_rule: Infinity,
}

const SKIP_TOOLS = new Set(['grep', 'glob', 'diff', 'inspect_project', 'repo_map', 'related_tests', 'recall'])

export function extractClaimsFromToolResult(ctx: ToolResultContext, meta: ClaimExtractionMeta): ClaimProposal[] {
  if (SKIP_TOOLS.has(ctx.toolName)) return []
  if (ctx.result.length < 10) return []

  const now = Date.now()

  if (ctx.toolName === 'read_file' && !ctx.isError) {
    return [fileObservation(ctx, meta, now)]
  }

  if (ctx.toolName === 'run_tests' || ctx.toolName === 'bash' && String(ctx.input.command ?? '').match(/test|jest|vitest|pytest/)) {
    if (ctx.isError) return [failurePattern(ctx, meta, now)]
    if (ctx.result.match(/\d+\s*pass/i)) return [verificationFact(ctx, meta, now)]
    return []
  }

  if (ctx.toolName === 'bash' && ctx.result.match(/vulnerabilit|CVE-|security|audit/i)) {
    return [securityFinding(ctx, meta, now)]
  }

  return []
}

function fileObservation(ctx: ToolResultContext, meta: ClaimExtractionMeta, now: number): ClaimProposal {
  const path = String(ctx.input.file_path ?? '')
  const filename = path.split('/').pop() ?? path
  const lines = ctx.result.split('\n').length
  return {
    kind: 'file_observation',
    scope: 'session',
    text: `Read ${filename} (${lines} lines)`,
    confidence: 0.6,
    fitness: 2,
    source: { actor: 'tool', sessionId: meta.sessionId, turn: meta.turn, eventId: meta.eventId },
    evidence: [{ id: `${meta.eventId}:read`, kind: 'tool_result' as EvidenceKind, summary: `read_file ${filename}`, path, createdAt: now }],
    createdAt: now,
    expiresAt: now + TTL.file_observation,
    tags: ['tool', 'read_file'],
  }
}

function failurePattern(ctx: ToolResultContext, meta: ClaimExtractionMeta, now: number): ClaimProposal {
  const summary = ctx.result.slice(0, 200).replace(/\n/g, ' ')
  return {
    kind: 'failure_pattern',
    scope: 'session',
    text: summary,
    confidence: 0.8,
    fitness: 5,
    source: { actor: 'tool', sessionId: meta.sessionId, turn: meta.turn, eventId: meta.eventId },
    evidence: [{ id: `${meta.eventId}:fail`, kind: 'test' as EvidenceKind, summary, createdAt: now }],
    createdAt: now,
    expiresAt: now + TTL.failure_pattern,
    tags: ['tool', 'test_failure'],
  }
}

function verificationFact(ctx: ToolResultContext, meta: ClaimExtractionMeta, now: number): ClaimProposal {
  const match = ctx.result.match(/(\d+)\s*pass/i)
  const text = match ? `Tests: ${match[1]} pass` : 'Tests passing'
  return {
    kind: 'verification_fact',
    scope: 'session',
    text,
    confidence: 0.9,
    fitness: 3,
    source: { actor: 'tool', sessionId: meta.sessionId, turn: meta.turn, eventId: meta.eventId },
    evidence: [{ id: `${meta.eventId}:verify`, kind: 'test' as EvidenceKind, summary: text, createdAt: now }],
    createdAt: now,
    expiresAt: now + TTL.verification_fact,
    tags: ['tool', 'test_pass'],
  }
}

function securityFinding(ctx: ToolResultContext, meta: ClaimExtractionMeta, now: number): ClaimProposal {
  const summary = ctx.result.slice(0, 200).replace(/\n/g, ' ')
  return {
    kind: 'security_finding',
    scope: 'session',
    text: summary,
    confidence: 0.75,
    fitness: 6,
    source: { actor: 'tool', sessionId: meta.sessionId, turn: meta.turn, eventId: meta.eventId },
    evidence: [{ id: `${meta.eventId}:security`, kind: 'tool_result' as EvidenceKind, summary, createdAt: now }],
    createdAt: now,
    expiresAt: now + TTL.security_finding,
    tags: ['tool', 'security'],
  }
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`npm test -- src/context/__tests__/claim-extractor.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/context/claim-extractor.ts src/context/__tests__/claim-extractor.test.ts
git commit -m "feat(claims): claim extractor — tool results → typed claim proposals with TTL"
```

---

## 任务 2：AgentLoop 接线 — tool result 后提取 claims

**文件：**
- 修改：`src/agent/loop.ts`

- [ ] **步骤 1：导入 claim extractor**

在 `src/agent/loop.ts` 顶部 imports 中添加：

```typescript
import { extractClaimsFromToolResult } from '../context/claim-extractor.js'
```

- [ ] **步骤 2：在 tool result 处理后插入 claim 提取**

在 `src/agent/loop.ts` 中，找到 `callbacks.onToolResult(tu.id, tu.name, finalContent, ...)` 之后、`toolResults.push(...)` 之前，插入：

```typescript
// Extract claims from tool results
if (this.config.contextClaimStore && this.config.sessionId) {
  const proposals = extractClaimsFromToolResult(
    { toolName: tu.name, input: tu.input as Record<string, unknown>, result: harnessResult.content, isError: harnessResult.isError },
    { sessionId: this.config.sessionId, turn: this.session.getTurnCount(), eventId: `turn-${this.session.getTurnCount()}:${tu.name}:${tu.id}` },
  )
  for (const proposal of proposals) {
    this.config.contextClaimStore.propose(proposal)
  }
}
```

- [ ] **步骤 3：在每轮结束时触发 promotion**

在 `src/agent/loop.ts` 中，找到 `callbacks.onTurnComplete(...)` 调用前，插入：

```typescript
this.config.contextClaimStore?.promoteEligibleClaims()
```

- [ ] **步骤 4：运行 typecheck + test**

运行：`npx tsc --noEmit && npm test`
预期：无错误，全部通过

- [ ] **步骤 5：Commit**

```bash
git add src/agent/loop.ts
git commit -m "feat(claims): wire claim extraction into tool result path + promotion on turn end"
```

---

## 任务 3：Promotion 增强 — durable_candidate → durable

**文件：**
- 修改：`src/context/promotion.ts`
- 测试：`src/context/__tests__/promotion.test.ts`

- [ ] **步骤 1：编写失败的测试**

追加到 `src/context/__tests__/promotion.test.ts`：

```typescript
it('promotes durable_candidate to durable after 5+ consumers and 10+ minutes', () => {
  const result = evaluatePromotion(claim({
    status: 'durable_candidate',
    consumers: Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, kind: 'prompt' as const, usedAt: Date.now() - 600_001 })),
    createdAt: Date.now() - 600_001,
    counterevidence: [],
  }))
  assert.equal(result, 'durable')
})

it('does not promote durable_candidate with fewer than 5 consumers', () => {
  const result = evaluatePromotion(claim({
    status: 'durable_candidate',
    consumers: [{ id: 'c1', kind: 'prompt' as const, usedAt: Date.now() }],
    createdAt: Date.now() - 600_001,
    counterevidence: [],
  }))
  assert.equal(result, null)
})
```

- [ ] **步骤 2：运行测试确认失败**

运行：`npm test -- src/context/__tests__/promotion.test.ts`
预期：FAIL（durable_candidate 不被 evaluatePromotion 处理）

- [ ] **步骤 3：扩展 evaluatePromotion**

```typescript
// src/context/promotion.ts — 替换 evaluatePromotion
export function evaluatePromotion(claim: ContextClaim, now = Date.now()): ContextClaimStatus | null {
  if (!isPromptEligibleClaim(claim, now)) return null
  if (claim.counterevidence.length > 0) return null

  if (claim.status === 'active') {
    if (new Set(claim.consumers.map(c => c.id)).size < 3) return null
    return 'durable_candidate'
  }

  if (claim.status === 'durable_candidate') {
    const age = now - claim.createdAt
    if (age < 10 * 60_000) return null
    if (new Set(claim.consumers.map(c => c.id)).size < 5) return null
    return 'durable'
  }

  return null
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`npm test -- src/context/__tests__/promotion.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/context/promotion.ts src/context/__tests__/promotion.test.ts
git commit -m "feat(claims): durable_candidate → durable promotion after 5 consumers + 10min age"
```

---

## 任务 4：跨 Session Durable Claim 加载

**文件：**
- 修改：`src/agent/session-persist.ts`
- 修改：`src/main.tsx`
- 测试：追加到 `src/context/__tests__/claim-store.test.ts`

- [ ] **步骤 1：编写失败的测试**

追加到 `src/context/__tests__/claim-store.test.ts`：

```typescript
test('loadDurableClaims returns only durable claims from a session file', () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-old')
    const active = store.propose(proposal('Active claim'))
    const durable = store.propose(proposal('Durable claim'))
    store.updateClaimStatus(durable.id, 'durable_candidate', 'promoted')
    store.updateClaimStatus(durable.id, 'durable', 'promotion threshold met')

    const loaded = ContextClaimStore.loadDurableClaims(dir, 'session-old')
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0]!.text, 'Durable claim')
    assert.equal(loaded[0]!.status, 'durable')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
```

- [ ] **步骤 2：运行测试确认失败**

运行：`npm test -- src/context/__tests__/claim-store.test.ts`
预期：FAIL（loadDurableClaims 不存在）

- [ ] **步骤 3：实现 loadDurableClaims 静态方法**

在 `src/context/claim-store.ts` 的 `ContextClaimStore` class 中添加：

```typescript
static loadDurableClaims(dir: string, sessionId: string): ContextClaim[] {
  const filePath = join(dir, `${sessionId}.claims.jsonl`)
  if (!existsSync(filePath)) return []
  const lines = readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim().length > 0)
  const claims = new Map<string, ContextClaim>()
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as ContextClaimEvent
      if (event.type === 'claim_proposed' && !claims.has(event.claim.id)) {
        claims.set(event.claim.id, event.claim)
      } else if (event.type === 'claim_status_changed') {
        const claim = claims.get(event.claimId)
        if (claim) claims.set(event.claimId, { ...claim, status: event.status })
      }
    } catch { /* skip */ }
  }
  return [...claims.values()].filter(c => c.status === 'durable')
}
```

- [ ] **步骤 4：在 session-persist.ts 添加 loadPreviousDurableClaims**

```typescript
// src/agent/session-persist.ts — 添加方法
import { ContextClaimStore } from '../context/claim-store.js'

/** Load durable claims from the most recent previous session. */
loadPreviousDurableClaims(): import('../context/claims.js').ContextClaim[] {
  const sessions = SessionPersist.listSessions()
  // Find the most recent session that isn't the current one
  const previous = sessions
    .filter(s => s !== this.sessionId)
    .sort()
    .pop()
  if (!previous) return []
  return ContextClaimStore.loadDurableClaims(SESSION_DIR, previous)
}
```

- [ ] **步骤 5：在 main.tsx 的 session resume 路径注入 durable claims**

在 `src/main.tsx` 中，agent 创建后、第一次 run 前，添加：

```typescript
// Inject durable claims from previous session
const durableClaims = persist.loadPreviousDurableClaims()
for (const claim of durableClaims) {
  claimStore.propose({
    kind: claim.kind,
    scope: claim.scope,
    text: claim.text,
    confidence: claim.confidence * 0.9, // slight decay on cross-session transfer
    fitness: claim.fitness,
    source: { ...claim.source, eventId: `resume:${claim.id}` },
    evidence: claim.evidence,
    createdAt: Date.now(),
    tags: [...claim.tags, 'resumed'],
  })
}
```

- [ ] **步骤 6：运行 typecheck + test**

运行：`npx tsc --noEmit && npm test`
预期：全部通过

- [ ] **步骤 7：Commit**

```bash
git add src/context/claim-store.ts src/agent/session-persist.ts src/main.tsx src/context/__tests__/claim-store.test.ts
git commit -m "feat(claims): cross-session durable claim loading with confidence decay"
```

---

## 任务 5：Claim Budget Cap — 防止 active claims 无限膨胀

**文件：**
- 修改：`src/context/claims.ts`
- 测试：追加到 `src/context/__tests__/claims.test.ts`

- [ ] **步骤 1：编写失败的测试**

追加到 `src/context/__tests__/claims.test.ts`：

```typescript
test('renderActiveClaimsBlock caps at MAX_PROMPT_CLAIMS and sorts by fitness', () => {
  const claims: ContextClaim[] = Array.from({ length: 30 }, (_, i) => ({
    id: `c_${i}`,
    kind: 'file_observation' as const,
    scope: 'session' as const,
    status: 'active' as const,
    text: `Claim ${i}`,
    confidence: 0.7,
    fitness: i,
    source: { actor: 'tool' as const, sessionId: 's', turn: 1, eventId: `e${i}` },
    evidence: [{ id: `ev${i}`, kind: 'tool_result' as const, summary: `Claim ${i}`, createdAt: 1 }],
    counterevidence: [],
    consumers: [],
    createdAt: 1,
    lastUsedAt: 1,
    tags: [],
  }))

  const block = renderActiveClaimsBlock(claims)
  const claimCount = (block.match(/<claim /g) ?? []).length
  assert.ok(claimCount <= 20)
  // Highest fitness claims should be included
  assert.ok(block.includes('Claim 29'))
  assert.ok(!block.includes('Claim 0'))
})
```

- [ ] **步骤 2：运行测试确认失败**

运行：`npm test -- src/context/__tests__/claims.test.ts`
预期：FAIL（all 30 claims rendered）

- [ ] **步骤 3：添加 cap 到 renderActiveClaimsBlock**

在 `src/context/claims.ts` 的 `renderActiveClaimsBlock` 中，在 sort 后添加 slice：

```typescript
export const MAX_PROMPT_CLAIMS = 20

export function renderActiveClaimsBlock(claims: ContextClaim[]): string {
  const active = claims
    .filter(isPromptEligibleClaim)
    .sort((a, b) => b.fitness - a.fitness || b.confidence - a.confidence || a.createdAt - b.createdAt)
    .slice(0, MAX_PROMPT_CLAIMS)

  if (active.length === 0) return ''
  // ... rest unchanged
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`npm test -- src/context/__tests__/claims.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/context/claims.ts src/context/__tests__/claims.test.ts
git commit -m "feat(claims): cap active claims at 20 in prompt projection, sorted by fitness"
```

---

## 验收标准

| 标准 | 验证方法 |
|------|---------|
| read_file 产生 file_observation claim | 测试：extractClaimsFromToolResult + loop integration |
| run_tests 失败产生 failure_pattern claim | 测试：isError=true → failure_pattern |
| run_tests 成功产生 verification_fact claim | 测试：pass count → verification_fact |
| npm audit 产生 security_finding claim | 测试：security keywords → security_finding |
| Claims 有 TTL（file_observation=30min） | 测试：expiresAt = createdAt + 30min |
| 过期 claims 不进入 prompt | isPromptEligibleClaim 已检查 expiresAt ✅ |
| active → durable_candidate（3 consumers） | 已有测试 ✅ |
| durable_candidate → durable（5 consumers + 10min） | 新测试 |
| Durable claims 跨 session 加载 | 测试：loadDurableClaims + resume 注入 |
| Active claims 上限 20 | 测试：30 claims → 只渲染 20 |
| 所有测试通过 | npm test: 810+ pass, 0 fail |
