# Evolutionary Context Fabric Phase 1 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为 Rivet 实现 Evolutionary Context Fabric 的最小闭环：从用户输入提取证据约束 claim，写入本地 JSONL 事件流，并在下一轮 prompt 中只投影 active/durable claim。

**架构：** Phase 1 保持本地、同步、可测试：`AnchorRegistry` 继续负责从用户输入识别 salience，新的 claim 模型把 anchor 转成带 evidence/status/scope 的 `ContextClaim`，新的 JSONL store 以 append-only event 方式保存 claim 并投影当前状态。`PromptEngine` 将 active claims 当作 latest-turn volatile context 注入，避免改写历史 context block，保持 DeepSeek prefix-cache 边界尽量稳定。

**技术栈：** TypeScript、Node `fs/path/crypto`、`node:test`、现有 `tsx --test` 测试 runner、现有 `PromptEngine` / `AgentLoop` / `SessionPersist`。

---

## 范围切分

本计划只实现 Phase 1 的可工作闭环：user input → anchor → claim proposal → JSONL event → active-claim prompt projection → tests。SQLite、`sqlite-vec`、跨机器合并、worker claim proposal、TUI conflict journal 面板、加密导入导出不属于这个计划；它们依赖 Phase 1 产生的 claim/event 基础类型，可以拆成独立计划实现。

## 文件结构

### 新建文件

- `src/context/claims.ts` — claim/proposal/evidence/event 类型，claim ID 生成，anchor→proposal 转换，active claim 过滤，XML 投影渲染。
- `src/context/claim-store.ts` — append-only JSONL claim event store，同步读写，状态投影，active claims 查询。
- `src/context/__tests__/claims.test.ts` — claim 模型、anchor 转换、status 过滤、XML escaping 测试。
- `src/context/__tests__/claim-store.test.ts` — JSONL store 事件追加、重放投影、状态转换、坏 JSONL 行隔离测试。

### 修改文件

- `src/prompt/volatile.ts` — `VolatileContext` 增加 `activeClaimsBlock?: string`，stable block 排除 active claims，latest-turn block 包含 active claims。
- `src/prompt/engine.ts` — latest user text message 始终使用 fresh volatile block；新增 `updateActiveClaims()`；现有 `updateSessionMemory()` 通过最新一轮 context 生效。
- `src/prompt/__tests__/volatile.test.ts` — active claims 只进入 latest-turn volatile block 的单元测试。
- `src/prompt/__tests__/engine.test.ts` — active claims/session memory 更新后下一轮 request 可见、历史 stable block 不被 active claims 污染的测试。
- `src/agent/loop.ts` — 持有 `AnchorRegistry`，在 `run(userInput)` 开始时生成 claim proposal，写入 store，并在每次 buildRequest 前刷新 active claims block。
- `src/agent/__tests__/loop.test.ts` — 用 fake client/fake tool registry 验证用户约束进入下一轮 request context。
- `src/agent/session-persist.ts` — 为当前 session 创建 claim store，复用 `~/.rivet/sessions/<sessionId>.claims.jsonl`。
- `src/main.tsx` — 主 agent 注入 `contextClaimStore`。
- `.wolf/anatomy.md` — OpenWolf 文件地图更新。
- `.wolf/memory.md` — 记录本计划写入事实。

---

## 任务 1：定义 claim 模型与 prompt 投影

**文件：**
- 创建：`src/context/claims.ts`
- 测试：`src/context/__tests__/claims.test.ts`

- [ ] **步骤 1：编写失败的 claim 模型测试**

创建 `src/context/__tests__/claims.test.ts`：

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  claimProposalFromAnchor,
  createClaimFromProposal,
  isPromptEligibleClaim,
  renderActiveClaimsBlock,
  type ContextClaim,
} from '../claims.js'
import type { ContextAnchor } from '../types.js'

test('converts a user constraint anchor into a session claim proposal with evidence', () => {
  const anchor: ContextAnchor = {
    kind: 'user_constraint',
    text: 'CRITICAL: do not call tools for this answer',
    sourceRoundIndex: 4,
    salience: 6,
  }

  const proposal = claimProposalFromAnchor(anchor, {
    actor: 'user',
    sessionId: 'session-123',
    turn: 4,
    eventId: 'turn-4:user-input',
    createdAt: 1_700_000_000_000,
  })

  assert.equal(proposal.kind, 'user_constraint')
  assert.equal(proposal.scope, 'session')
  assert.equal(proposal.text, 'CRITICAL: do not call tools for this answer')
  assert.equal(proposal.confidence, 0.9)
  assert.equal(proposal.fitness, 6)
  assert.deepEqual(proposal.tags, ['anchor', 'user_constraint'])
  assert.equal(proposal.evidence[0]?.kind, 'user_message')
  assert.equal(proposal.evidence[0]?.summary, 'CRITICAL: do not call tools for this answer')
})

test('creates deterministic claim ids from proposal content and source', () => {
  const anchor: ContextAnchor = {
    kind: 'decision',
    text: 'Use JSONL before SQLite',
    sourceRoundIndex: 2,
    salience: 4,
  }
  const proposal = claimProposalFromAnchor(anchor, {
    actor: 'assistant',
    sessionId: 'session-123',
    turn: 2,
    eventId: 'decision-2',
    createdAt: 1_700_000_000_000,
  })

  const a = createClaimFromProposal(proposal)
  const b = createClaimFromProposal(proposal)

  assert.equal(a.id, b.id)
  assert.equal(a.status, 'active')
  assert.equal(a.lastUsedAt, 1_700_000_000_000)
})

test('only active durable candidate and durable claims are prompt eligible', () => {
  const base: ContextClaim = {
    id: 'c_active',
    kind: 'user_constraint',
    scope: 'session',
    status: 'active',
    text: 'Keep claim projection small',
    confidence: 0.9,
    fitness: 6,
    source: { actor: 'user', sessionId: 'session-123', turn: 1, eventId: 'e1' },
    evidence: [{ id: 'e1', kind: 'user_message', summary: 'Keep claim projection small', createdAt: 1 }],
    counterevidence: [],
    consumers: [],
    createdAt: 1,
    lastUsedAt: 1,
    tags: ['anchor'],
  }

  assert.equal(isPromptEligibleClaim(base), true)
  assert.equal(isPromptEligibleClaim({ ...base, id: 'c_candidate', status: 'durable_candidate' }), true)
  assert.equal(isPromptEligibleClaim({ ...base, id: 'c_durable', status: 'durable' }), true)
  assert.equal(isPromptEligibleClaim({ ...base, id: 'c_stale', status: 'stale' }), false)
  assert.equal(isPromptEligibleClaim({ ...base, id: 'c_conflicted', status: 'conflicted' }), false)
  assert.equal(isPromptEligibleClaim({ ...base, id: 'c_quarantined', status: 'quarantined' }), false)
})

test('renders only prompt eligible claims and escapes XML-sensitive text', () => {
  const claim: ContextClaim = {
    id: 'c_xml',
    kind: 'user_constraint',
    scope: 'session',
    status: 'active',
    text: 'Use <claims> & never trust "raw" XML',
    confidence: 0.92,
    fitness: 7,
    source: { actor: 'user', sessionId: 'session-123', turn: 1, eventId: 'e1' },
    evidence: [{ id: 'e1', kind: 'user_message', summary: 'Use <claims>', createdAt: 1 }],
    counterevidence: [],
    consumers: [],
    createdAt: 1,
    lastUsedAt: 1,
    tags: ['anchor'],
  }

  const stale: ContextClaim = { ...claim, id: 'c_stale', status: 'stale', text: 'stale text' }
  const block = renderActiveClaimsBlock([stale, claim])

  assert.match(block, /<active-claims count="1">/)
  assert.match(block, /<claim id="c_xml" kind="user_constraint" scope="session" confidence="0.92" evidence="e1">/)
  assert.match(block, /Use &lt;claims&gt; &amp; never trust &quot;raw&quot; XML/)
  assert.doesNotMatch(block, /stale text/)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/context/__tests__/claims.test.ts
```

预期：FAIL，核心错误包含：

```text
Cannot find module '../claims.js'
```

- [ ] **步骤 3：实现最小 claim 模型**

创建 `src/context/claims.ts`：

```ts
import { createHash } from 'node:crypto'
import type { ContextAnchor } from './types.js'

export type ContextClaimKind =
  | 'user_constraint'
  | 'user_preference'
  | 'decision'
  | 'file_observation'
  | 'verification_fact'
  | 'failure_pattern'
  | 'security_finding'
  | 'worker_finding'
  | 'project_rule'

export type ContextClaimScope = 'turn' | 'session' | 'project' | 'repo' | 'global'

export type ContextClaimStatus =
  | 'ephemeral'
  | 'active'
  | 'durable_candidate'
  | 'durable'
  | 'stale'
  | 'conflicted'
  | 'quarantined'

export type EvidenceKind = 'user_message' | 'assistant_message' | 'tool_result' | 'file' | 'test' | 'worker' | 'hook' | 'compact' | 'resume'
export type ContextActor = 'user' | 'assistant' | 'tool' | 'worker' | 'hook' | 'compact' | 'resume'

export interface EvidenceRef {
  id: string
  kind: EvidenceKind
  summary: string
  path?: string
  createdAt: number
}

export interface ConsumerRef {
  id: string
  kind: 'prompt' | 'tool' | 'test' | 'worker'
  usedAt: number
}

export interface ClaimSource {
  actor: ContextActor
  sessionId: string
  turn: number
  eventId: string
}

export interface ContextClaim {
  id: string
  kind: ContextClaimKind
  scope: ContextClaimScope
  status: ContextClaimStatus
  text: string
  confidence: number
  fitness: number
  source: ClaimSource
  evidence: EvidenceRef[]
  consumers: ConsumerRef[]
  counterevidence: EvidenceRef[]
  createdAt: number
  lastUsedAt: number
  expiresAt?: number
  tags: string[]
}

export interface ClaimProposal {
  kind: ContextClaimKind
  scope: ContextClaimScope
  text: string
  confidence: number
  fitness: number
  source: ClaimSource
  evidence: EvidenceRef[]
  createdAt: number
  expiresAt?: number
  tags: string[]
}

export interface ClaimProposalMeta extends ClaimSource {
  createdAt: number
}

function claimIdFor(proposal: ClaimProposal): string {
  return createHash('sha256')
    .update(JSON.stringify({
      kind: proposal.kind,
      scope: proposal.scope,
      text: proposal.text,
      source: proposal.source,
      evidence: proposal.evidence.map(e => e.id),
    }))
    .digest('hex')
    .slice(0, 12)
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function kindFromAnchor(anchor: ContextAnchor): ContextClaimKind {
  if (anchor.kind === 'user_constraint') return 'user_constraint'
  if (anchor.kind === 'user_preference') return 'user_preference'
  if (anchor.kind === 'decision') return 'decision'
  if (anchor.kind === 'verification') return 'verification_fact'
  if (anchor.kind === 'error') return 'failure_pattern'
  return 'file_observation'
}

function confidenceFromAnchor(anchor: ContextAnchor): number {
  if (anchor.kind === 'user_constraint') return 0.9
  if (anchor.kind === 'decision') return 0.82
  if (anchor.kind === 'verification') return 0.88
  return 0.7
}

export function claimProposalFromAnchor(anchor: ContextAnchor, meta: ClaimProposalMeta): ClaimProposal {
  const evidenceId = `${meta.eventId}:anchor`
  return {
    kind: kindFromAnchor(anchor),
    scope: 'session',
    text: anchor.text,
    confidence: confidenceFromAnchor(anchor),
    fitness: anchor.salience,
    source: {
      actor: meta.actor,
      sessionId: meta.sessionId,
      turn: meta.turn,
      eventId: meta.eventId,
    },
    evidence: [{
      id: evidenceId,
      kind: meta.actor === 'user' ? 'user_message' : 'assistant_message',
      summary: anchor.text,
      createdAt: meta.createdAt,
    }],
    createdAt: meta.createdAt,
    tags: ['anchor', anchor.kind],
  }
}

export function createClaimFromProposal(proposal: ClaimProposal): ContextClaim {
  return {
    id: claimIdFor(proposal),
    kind: proposal.kind,
    scope: proposal.scope,
    status: 'active',
    text: proposal.text,
    confidence: proposal.confidence,
    fitness: proposal.fitness,
    source: proposal.source,
    evidence: [...proposal.evidence],
    consumers: [],
    counterevidence: [],
    createdAt: proposal.createdAt,
    lastUsedAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
    tags: [...proposal.tags],
  }
}

export function isPromptEligibleClaim(claim: ContextClaim): boolean {
  return claim.status === 'active' || claim.status === 'durable_candidate' || claim.status === 'durable'
}

export function renderActiveClaimsBlock(claims: ContextClaim[]): string {
  const active = claims
    .filter(isPromptEligibleClaim)
    .sort((a, b) => b.fitness - a.fitness || b.confidence - a.confidence || a.createdAt - b.createdAt)

  if (active.length === 0) return ''

  const entries = active.map(claim => {
    const evidence = claim.evidence[0]?.id ?? ''
    return `  <claim id="${escapeXml(claim.id)}" kind="${claim.kind}" scope="${claim.scope}" confidence="${claim.confidence.toFixed(2)}" evidence="${escapeXml(evidence)}">${escapeXml(claim.text)}</claim>`
  })

  return `<active-claims count="${active.length}">\n${entries.join('\n')}\n</active-claims>`
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/context/__tests__/claims.test.ts
```

预期：PASS，输出包含：

```text
# pass 4
# fail 0
```

- [ ] **步骤 5：Commit**

运行：

```bash
git add src/context/claims.ts src/context/__tests__/claims.test.ts
git commit -m "feat: add context claim model"
```

---

## 任务 2：实现 JSONL claim event store

**文件：**
- 创建：`src/context/claim-store.ts`
- 测试：`src/context/__tests__/claim-store.test.ts`

- [ ] **步骤 1：编写失败的 JSONL store 测试**

创建 `src/context/__tests__/claim-store.test.ts`：

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextClaimStore } from '../claim-store.js'
import type { ClaimProposal } from '../claims.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'rivet-claims-'))
}

function proposal(text = 'Do not repeat failed Read calls'): ClaimProposal {
  return {
    kind: 'user_constraint',
    scope: 'session',
    text,
    confidence: 0.9,
    fitness: 5,
    source: { actor: 'user', sessionId: 'session-123', turn: 1, eventId: 'turn-1:user-input' },
    evidence: [{ id: 'e1', kind: 'user_message', summary: text, createdAt: 10 }],
    createdAt: 10,
    tags: ['anchor', 'user_constraint'],
  }
}

test('proposes a claim by appending a JSONL event and projecting current claims', () => {
  const store = new ContextClaimStore(tempDir(), 'session-123')

  const claim = store.propose(proposal())
  const claims = store.listClaims()

  assert.equal(claim.status, 'active')
  assert.equal(claims.length, 1)
  assert.equal(claims[0]?.text, 'Do not repeat failed Read calls')

  const raw = readFileSync(store.path, 'utf-8')
  assert.match(raw, /"type":"claim_proposed"/)
  assert.match(raw, /Do not repeat failed Read calls/)
})

test('replays claim status transitions from JSONL', () => {
  const dir = tempDir()
  const store = new ContextClaimStore(dir, 'session-123')
  const claim = store.propose(proposal())

  store.updateClaimStatus(claim.id, 'stale', 'evidence expired')

  const reloaded = new ContextClaimStore(dir, 'session-123')
  const claims = reloaded.listClaims()

  assert.equal(claims.length, 1)
  assert.equal(claims[0]?.status, 'stale')
  assert.equal(claims[0]?.counterevidence[0]?.summary, 'evidence expired')
})

test('filters active claims and excludes quarantined claims', () => {
  const store = new ContextClaimStore(tempDir(), 'session-123')
  const active = store.propose(proposal('Keep this active'))
  const quarantined = store.propose(proposal('Do not project this'))
  store.updateClaimStatus(quarantined.id, 'quarantined', 'counter evidence')

  const activeClaims = store.listActiveClaims()

  assert.deepEqual(activeClaims.map(c => c.id), [active.id])
})

test('ignores invalid JSONL lines while preserving valid events', () => {
  const dir = tempDir()
  const store = new ContextClaimStore(dir, 'session-123')
  const claim = store.propose(proposal())
  writeFileSync(store.path, `${readFileSync(store.path, 'utf-8')}not json\n`, 'utf-8')

  const reloaded = new ContextClaimStore(dir, 'session-123')

  assert.equal(reloaded.listClaims()[0]?.id, claim.id)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/context/__tests__/claim-store.test.ts
```

预期：FAIL，核心错误包含：

```text
Cannot find module '../claim-store.js'
```

- [ ] **步骤 3：实现 JSONL store**

创建 `src/context/claim-store.ts`：

```ts
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertValidSessionId } from '../validation.js'
import {
  createClaimFromProposal,
  isPromptEligibleClaim,
  type ClaimProposal,
  type ContextClaim,
  type ContextClaimStatus,
  type EvidenceRef,
} from './claims.js'

export type ContextClaimEvent =
  | { type: 'claim_proposed'; eventId: string; createdAt: number; claim: ContextClaim }
  | { type: 'claim_status_changed'; eventId: string; createdAt: number; claimId: string; status: ContextClaimStatus; reason: string }
  | { type: 'claim_used'; eventId: string; createdAt: number; claimId: string; consumerId: string; consumerKind: 'prompt' | 'tool' | 'test' | 'worker' }

export interface ClaimFilter {
  status?: ContextClaimStatus[]
  kind?: ContextClaim['kind'][]
  scope?: ContextClaim['scope'][]
}

export class ContextClaimStore {
  readonly path: string

  constructor(dir: string, private sessionId: string) {
    assertValidSessionId(sessionId)
    mkdirSync(dir, { recursive: true })
    this.path = join(dir, `${sessionId}.claims.jsonl`)
  }

  appendEvent(event: ContextClaimEvent): void {
    appendFileSync(this.path, JSON.stringify(event) + '\n', 'utf-8')
  }

  propose(proposal: ClaimProposal): ContextClaim {
    const claim = createClaimFromProposal(proposal)
    this.appendEvent({
      type: 'claim_proposed',
      eventId: `${proposal.source.eventId}:claim:${claim.id}`,
      createdAt: proposal.createdAt,
      claim,
    })
    return claim
  }

  updateClaimStatus(id: string, status: ContextClaimStatus, reason: string): ContextClaim | null {
    const current = this.listClaims().find(claim => claim.id === id)
    if (!current) return null

    this.appendEvent({
      type: 'claim_status_changed',
      eventId: `${id}:status:${status}:${Date.now()}`,
      createdAt: Date.now(),
      claimId: id,
      status,
      reason,
    })

    return this.listClaims().find(claim => claim.id === id) ?? null
  }

  listClaims(filter: ClaimFilter = {}): ContextClaim[] {
    const projected = this.projectClaims()
    return projected.filter(claim => {
      if (filter.status && !filter.status.includes(claim.status)) return false
      if (filter.kind && !filter.kind.includes(claim.kind)) return false
      if (filter.scope && !filter.scope.includes(claim.scope)) return false
      return true
    })
  }

  listActiveClaims(): ContextClaim[] {
    return this.listClaims().filter(isPromptEligibleClaim)
  }

  exportSession(): string {
    if (!existsSync(this.path)) return ''
    return readFileSync(this.path, 'utf-8')
  }

  private readEvents(): ContextClaimEvent[] {
    if (!existsSync(this.path)) return []
    return readFileSync(this.path, 'utf-8')
      .split('\n')
      .filter(line => line.trim().length > 0)
      .flatMap(line => {
        try {
          return [JSON.parse(line) as ContextClaimEvent]
        } catch {
          return []
        }
      })
  }

  private projectClaims(): ContextClaim[] {
    const claims = new Map<string, ContextClaim>()

    for (const event of this.readEvents()) {
      if (event.type === 'claim_proposed') {
        claims.set(event.claim.id, event.claim)
        continue
      }

      if (event.type === 'claim_status_changed') {
        const claim = claims.get(event.claimId)
        if (!claim) continue
        const counterevidence: EvidenceRef[] = event.status === 'active'
          ? claim.counterevidence
          : [...claim.counterevidence, {
              id: event.eventId,
              kind: 'tool_result',
              summary: event.reason,
              createdAt: event.createdAt,
            }]
        claims.set(event.claimId, { ...claim, status: event.status, counterevidence })
        continue
      }

      if (event.type === 'claim_used') {
        const claim = claims.get(event.claimId)
        if (!claim) continue
        claims.set(event.claimId, {
          ...claim,
          lastUsedAt: event.createdAt,
          consumers: [...claim.consumers, {
            id: event.consumerId,
            kind: event.consumerKind,
            usedAt: event.createdAt,
          }],
        })
      }
    }

    return [...claims.values()]
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/context/__tests__/claim-store.test.ts
```

预期：PASS，输出包含：

```text
# pass 4
# fail 0
```

- [ ] **步骤 5：Commit**

运行：

```bash
git add src/context/claim-store.ts src/context/__tests__/claim-store.test.ts
git commit -m "feat: add context claim event store"
```

---

## 任务 3：让 prompt latest-turn context 支持 active claims

**文件：**
- 修改：`src/prompt/volatile.ts`
- 修改：`src/prompt/engine.ts`
- 测试：`src/prompt/__tests__/volatile.test.ts`
- 测试：`src/prompt/__tests__/engine.test.ts`

- [ ] **步骤 1：编写 volatile active claims 失败测试**

在 `src/prompt/__tests__/volatile.test.ts` 追加：

```ts
import { buildLatestTurnVolatileBlock, buildStableVolatileBlock } from '../volatile.js'

test('active claims are excluded from stable volatile block and included in latest turn block', () => {
  const ctx = {
    cwd: '/repo',
    activeClaimsBlock: '<active-claims count="1">\n  <claim id="c1" kind="user_constraint" scope="session" confidence="0.90" evidence="e1">Prefer tests first</claim>\n</active-claims>',
  }

  const stable = buildStableVolatileBlock(ctx)
  const latest = buildLatestTurnVolatileBlock(ctx)

  assert.doesNotMatch(stable, /active-claims/)
  assert.match(latest, /<active-claims count="1">/)
  assert.match(latest, /Prefer tests first/)
})
```

如果文件顶部还没有 `assert`，添加：

```ts
import assert from 'node:assert/strict'
```

- [ ] **步骤 2：编写 PromptEngine 更新后下一轮可见的失败测试**

在 `src/prompt/__tests__/engine.test.ts` 追加：

```ts
import { PromptEngine } from '../engine.js'

test('updated active claims appear in the latest turn request without entering historical stable context', () => {
  const engine = new PromptEngine({
    model: 'deepseek-test',
    maxTokens: 4096,
    staticCtx: { tools: [] },
    volatileCtx: { cwd: '/repo' },
  })

  engine.updateActiveClaims('<active-claims count="1">\n  <claim id="c1" kind="user_constraint" scope="session" confidence="0.90" evidence="e1">Run tests before claiming done</claim>\n</active-claims>')

  const request = engine.buildRequest([
    { role: 'user', content: 'first turn' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'second turn' },
  ])

  const contextMessages = request.messages.filter(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('<context>'))

  assert.equal(contextMessages.length, 2)
  assert.doesNotMatch(contextMessages[0]!.content as string, /active-claims/)
  assert.match(contextMessages[1]!.content as string, /Run tests before claiming done/)
})

test('updated session memory appears in the latest turn request', () => {
  const engine = new PromptEngine({
    model: 'deepseek-test',
    maxTokens: 4096,
    staticCtx: { tools: [] },
    volatileCtx: { cwd: '/repo' },
  })

  engine.updateSessionMemory('<session-memory session_id="s1">\n<entry id="m1" created_at="1" source="manual">Use JSONL first</entry>\n</session-memory>')

  const request = engine.buildRequest([{ role: 'user', content: 'remember this' }])
  const context = request.messages[0]!.content as string

  assert.match(context, /<session-memory session_id="s1">/)
  assert.match(context, /Use JSONL first/)
})
```

- [ ] **步骤 3：运行 prompt 测试验证失败**

运行：

```bash
npm test -- src/prompt/__tests__/volatile.test.ts src/prompt/__tests__/engine.test.ts
```

预期：FAIL，核心错误包含：

```text
Property 'activeClaimsBlock' does not exist
```

或：

```text
engine.updateActiveClaims is not a function
```

- [ ] **步骤 4：修改 `VolatileContext` 与 volatile block 构建**

在 `src/prompt/volatile.ts` 的 `VolatileContext` 中加入：

```ts
activeClaimsBlock?: string
```

修改 `buildStableVolatileBlock()`，让 stable block 排除 active claims：

```ts
export function buildStableVolatileBlock(ctx: VolatileContext): string {
  return buildVolatileBlockInternal({
    ...ctx,
    activeClaimsBlock: undefined,
    toolHistory: undefined,
    taskProgress: undefined,
    behaviorMirror: undefined,
    decisions: undefined,
  })
}
```

在 `buildVolatileBlockInternal()` 的 session memory 前加入 active claims：

```ts
  if (ctx.activeClaimsBlock) {
    parts.push(ctx.activeClaimsBlock)
  }

  if (ctx.sessionMemoryBlock) {
    parts.push(ctx.sessionMemoryBlock)
  }
```

- [ ] **步骤 5：修改 `PromptEngine` latest-turn 构建**

在 `src/prompt/engine.ts` 中新增方法：

```ts
  updateActiveClaims(block: string): void {
    this.config.volatileCtx.activeClaimsBlock = block
  }
```

将 `buildRequest()` 中最新 user text 的判断从：

```ts
        if (i === lastUserTextIdx && toolHistory && toolHistory.length > 0) {
          const freshBlock = buildLatestTurnVolatileBlock({ ...this.config.volatileCtx, toolHistory, taskProgress: this.taskProgress, behaviorMirror: this.behaviorMirror, strategyShift: this.strategyShift, repairHint: this.repairHint, impactHint: this.impactHint, routingReason: this.routingReason, decisions: this.decisions })
          result.push({ role: 'user', content: freshBlock })
        } else {
          result.push({ role: 'user', content: this.volatileBlock })
        }
```

改为：

```ts
        if (i === lastUserTextIdx) {
          const freshBlock = buildLatestTurnVolatileBlock({
            ...this.config.volatileCtx,
            toolHistory,
            taskProgress: this.taskProgress,
            behaviorMirror: this.behaviorMirror,
            strategyShift: this.strategyShift,
            repairHint: this.repairHint,
            impactHint: this.impactHint,
            routingReason: this.routingReason,
            decisions: this.decisions,
          })
          result.push({ role: 'user', content: freshBlock })
        } else {
          result.push({ role: 'user', content: this.volatileBlock })
        }
```

- [ ] **步骤 6：运行 prompt 测试验证通过**

运行：

```bash
npm test -- src/prompt/__tests__/volatile.test.ts src/prompt/__tests__/engine.test.ts
```

预期：PASS，输出包含：

```text
# fail 0
```

- [ ] **步骤 7：Commit**

运行：

```bash
git add src/prompt/volatile.ts src/prompt/engine.ts src/prompt/__tests__/volatile.test.ts src/prompt/__tests__/engine.test.ts
git commit -m "feat: project active claims into latest prompt context"
```

---

## 任务 4：SessionPersist 创建当前 session 的 claim store

**文件：**
- 修改：`src/agent/session-persist.ts`
- 测试：`src/context/__tests__/claim-store.test.ts`

- [ ] **步骤 1：编写失败的 SessionPersist store 路径测试**

在 `src/context/__tests__/claim-store.test.ts` 追加：

```ts
import { SessionPersist } from '../../agent/session-persist.js'

test('SessionPersist creates a claim store for the current session id', () => {
  const persist = new SessionPersist('session-claims-test')
  const store = persist.createClaimStore()

  assert.match(store.path, /session-claims-test\.claims\.jsonl$/)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/context/__tests__/claim-store.test.ts
```

预期：FAIL，核心错误包含：

```text
persist.createClaimStore is not a function
```

- [ ] **步骤 3：实现 `createClaimStore()`**

在 `src/agent/session-persist.ts` 顶部加入：

```ts
import { ContextClaimStore } from '../context/claim-store.js'
```

在 `SessionPersist` class 中加入：

```ts
  createClaimStore(): ContextClaimStore {
    return new ContextClaimStore(SESSION_DIR, this.sessionId)
  }
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/context/__tests__/claim-store.test.ts
```

预期：PASS，输出包含：

```text
# fail 0
```

- [ ] **步骤 5：Commit**

运行：

```bash
git add src/agent/session-persist.ts src/context/__tests__/claim-store.test.ts
git commit -m "feat: attach claim store to sessions"
```

---

## 任务 5：AgentLoop 从用户输入生成 claim 并刷新 prompt projection

**文件：**
- 修改：`src/agent/loop.ts`
- 测试：`src/agent/__tests__/loop.test.ts`

- [ ] **步骤 1：编写 AgentLoop claim projection 失败测试**

在 `src/agent/__tests__/loop.test.ts` 追加或创建等价测试。若文件已有 fake client/helper，复用现有 helper；若没有，追加下面完整测试：

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { ContextClaimStore } from '../../context/claim-store.js'
import type { MessageRequest } from '../../api/types.js'

class CapturingClient {
  requests: MessageRequest[] = []

  async stream(request: MessageRequest, callbacks: { onContentBlock(block: unknown): void }, _signal?: AbortSignal): Promise<void> {
    this.requests.push(request)
    callbacks.onContentBlock({ type: 'text', text: 'done' })
  }
}

test('AgentLoop promotes user constraint anchors into active claim prompt context', async () => {
  const client = new CapturingClient()
  const session = new SessionContext()
  const promptEngine = new PromptEngine({
    model: 'deepseek-test',
    maxTokens: 4096,
    staticCtx: { tools: [] },
    volatileCtx: { cwd: '/repo' },
  })
  const claimStore = new ContextClaimStore(mkdtempSync(join(tmpdir(), 'rivet-loop-claims-')), 'session-123')

  const loop = new AgentLoop(session, {
    client: client as never,
    promptEngine,
    toolRegistry: new ToolRegistry(),
    cwd: '/repo',
    maxTurns: 1,
    contextWindow: 4096,
    sessionId: 'session-123',
    contextClaimStore: claimStore,
  })

  await loop.run('CRITICAL: always run tests before saying done', {
    onTextDelta: () => {},
    onThinkingDelta: () => {},
    onToolUse: () => {},
    onToolResult: () => {},
    onError: error => { throw error },
    onAbort: () => {},
    onTurnComplete: () => {},
    onApprovalRequired: async () => true,
  })

  const requestText = client.requests[0]!.messages.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n')

  assert.match(requestText, /<active-claims count="1">/)
  assert.match(requestText, /always run tests before saying done/)
  assert.equal(claimStore.listActiveClaims().length, 1)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/agent/__tests__/loop.test.ts
```

预期：FAIL，核心错误包含：

```text
Object literal may only specify known properties, and 'contextClaimStore' does not exist
```

或运行期断言失败：

```text
The input did not match the regular expression /<active-claims count="1">/
```

- [ ] **步骤 3：修改 `AgentLoopConfig`**

在 `src/agent/loop.ts` 顶部 import：

```ts
import { AnchorRegistry } from '../context/anchor-registry.js'
import { claimProposalFromAnchor, renderActiveClaimsBlock } from '../context/claims.js'
import type { ContextClaimStore } from '../context/claim-store.js'
```

在 `AgentLoopConfig` interface 加入：

```ts
  contextClaimStore?: ContextClaimStore
```

在 `AgentLoop` class 字段区加入：

```ts
  private anchorRegistry = new AnchorRegistry(2_000)
```

- [ ] **步骤 4：新增用户输入 claim 记录 helper**

在 `src/agent/loop.ts` 的 `updateSessionMemory()` 方法附近加入：

```ts
  private recordUserInputClaims(userInput: string): void {
    if (!this.config.contextClaimStore || !this.config.sessionId) return

    const before = this.anchorRegistry.getAnchors().length
    const turn = this.session.getTurnCount()
    this.anchorRegistry.processUserMessage(userInput, turn)
    const anchors = this.anchorRegistry.getAnchors().slice(before)
    const createdAt = Date.now()

    for (const anchor of anchors) {
      const proposal = claimProposalFromAnchor(anchor, {
        actor: 'user',
        sessionId: this.config.sessionId,
        turn,
        eventId: `turn-${turn}:user-input`,
        createdAt,
      })
      this.config.contextClaimStore.propose(proposal)
    }
  }

  private refreshActiveClaims(): void {
    if (!this.config.contextClaimStore) {
      this.config.promptEngine.updateActiveClaims('')
      return
    }

    this.config.promptEngine.updateActiveClaims(
      renderActiveClaimsBlock(this.config.contextClaimStore.listActiveClaims()),
    )
  }
```

- [ ] **步骤 5：调用 helper**

在 `run(userInput)` 开头，把：

```ts
    this.session.addUserMessage(userInput)
```

改为：

```ts
    this.recordUserInputClaims(userInput)
    this.session.addUserMessage(userInput)
```

在 `buildRequest()` 前，把：

```ts
        this.enforceContextCeiling()
        const request = this.config.promptEngine.buildRequest(this.session.getMessages(), this.recentToolHistory)
```

改为：

```ts
        this.enforceContextCeiling()
        this.refreshActiveClaims()
        const request = this.config.promptEngine.buildRequest(this.session.getMessages(), this.recentToolHistory)
```

- [ ] **步骤 6：运行 AgentLoop 测试验证通过**

运行：

```bash
npm test -- src/agent/__tests__/loop.test.ts
```

预期：PASS，输出包含：

```text
# fail 0
```

- [ ] **步骤 7：Commit**

运行：

```bash
git add src/agent/loop.ts src/agent/__tests__/loop.test.ts
git commit -m "feat: seed active claims from user constraints"
```

---

## 任务 6：主 TUI runtime 注入 claim store

**文件：**
- 修改：`src/main.tsx`
- 测试：`src/agent/__tests__/loop.test.ts`

- [ ] **步骤 1：编写 runtime wiring 检查测试**

当前 `main.tsx` 是 Ink runtime，不适合直接渲染成单元测试。本任务的测试使用 TypeScript 编译检查 runtime wiring；先运行：

```bash
npm run typecheck
```

预期：FAIL，核心错误包含：

```text
Property 'contextClaimStore' is missing
```

如果上一步没有失败，继续执行步骤 2；最终 typecheck 必须在步骤 4 通过。

- [ ] **步骤 2：在 Root 中创建 claim store**

在 `src/main.tsx` 中，`persist` 初始化之后加入：

```ts
  const [claimStore] = useState(() => persist.createClaimStore())
```

- [ ] **步骤 3：主 AgentLoop 注入 claim store**

在主 `AgentLoop` 构造参数中加入：

```ts
      contextClaimStore: claimStore,
```

目标位置是包含这些字段的对象：

```ts
      sessionId,
      transcriptPath: persist.getPath(),
      getSessionMemoryState: () => persist.getSessionMemoryState(),
```

修改后应为：

```ts
      sessionId,
      transcriptPath: persist.getPath(),
      getSessionMemoryState: () => persist.getSessionMemoryState(),
      contextClaimStore: claimStore,
```

不要给 worker `AgentLoop` 注入相同 store；worker claim proposal 需要 actor/merge 设计，本计划只接入主 TUI runtime。

- [ ] **步骤 4：运行类型检查验证通过**

运行：

```bash
npm run typecheck
```

预期：PASS，无 TypeScript error。

- [ ] **步骤 5：Commit**

运行：

```bash
git add src/main.tsx
git commit -m "feat: wire claim store into TUI runtime"
```

---

## 任务 7：端到端回归测试与缓存边界检查

**文件：**
- 测试：`src/context/__tests__/claims.test.ts`
- 测试：`src/context/__tests__/claim-store.test.ts`
- 测试：`src/prompt/__tests__/volatile.test.ts`
- 测试：`src/prompt/__tests__/engine.test.ts`
- 测试：`src/agent/__tests__/loop.test.ts`

- [ ] **步骤 1：运行所有相关单元测试**

运行：

```bash
npm test -- src/context/__tests__/claims.test.ts src/context/__tests__/claim-store.test.ts src/prompt/__tests__/volatile.test.ts src/prompt/__tests__/engine.test.ts src/agent/__tests__/loop.test.ts
```

预期：PASS，输出包含：

```text
# fail 0
```

- [ ] **步骤 2：运行全量测试**

运行：

```bash
npm test
```

预期：PASS，输出包含：

```text
# fail 0
```

如果本地环境出现历史已知问题：

```text
sh: tsx: command not found
```

执行：

```bash
npm install
npm test
```

预期：安装依赖后 PASS，输出包含：

```text
# fail 0
```

- [ ] **步骤 3：运行类型检查**

运行：

```bash
npm run typecheck
```

预期：PASS，无 TypeScript error。

- [ ] **步骤 4：运行构建**

运行：

```bash
npm run build
```

预期：PASS，输出包含 `CLI Building entry` 或 `Build success`。

- [ ] **步骤 5：检查 prefix-cache 边界测试含义**

确认 `src/prompt/__tests__/engine.test.ts` 中的测试满足这两个断言：

```ts
assert.doesNotMatch(contextMessages[0]!.content as string, /active-claims/)
assert.match(contextMessages[1]!.content as string, /Run tests before claiming done/)
```

这证明 active claims 只进入最新一轮 context，而不是改写历史 stable context。

- [ ] **步骤 6：Commit**

如果只修改测试期望或修复类型错误，运行：

```bash
git add src/context src/prompt src/agent src/main.tsx
git commit -m "test: verify active claim projection flow"
```

如果步骤 1-5 没有产生新 diff，跳过 commit。

---

## 任务 8：OpenWolf 账本更新

**文件：**
- 修改：`.wolf/anatomy.md`
- 修改：`.wolf/memory.md`
- 可能修改：`.wolf/buglog.json`

- [ ] **步骤 1：更新 `.wolf/anatomy.md` 文件地图**

在 `.wolf/anatomy.md` 中加入这些新文件条目，放在对应目录小节下：

```md
- `src/context/claims.ts` — Evolutionary Context Fabric claim/proposal/evidence model and active-claim XML projection.
- `src/context/claim-store.ts` — JSONL append-only claim event store with projected current claim state.
- `src/context/__tests__/claims.test.ts` — Tests for claim conversion, prompt eligibility, and XML projection escaping.
- `src/context/__tests__/claim-store.test.ts` — Tests for JSONL claim event replay, status transitions, and invalid-line isolation.
```

- [ ] **步骤 2：追加 `.wolf/memory.md` 工作记录**

在 `.wolf/memory.md` 末尾追加：

```md

## 2026-05-16 — Evolutionary Context Fabric Phase 1 plan
- Wrote implementation plan `docs/superpowers/plans/2026-05-16-rivet-evolutionary-context-fabric-phase1.md`.
- Phase 1 scope: user input anchors become evidence-backed `ContextClaim`s, persist through JSONL events, and project active claims only into latest-turn prompt context.
- Guardrail: SQLite/vector retrieval/worker semantic merge are intentionally outside Phase 1 to protect cache boundaries and keep the first slice testable.
```

- [ ] **步骤 3：只在实际修复 bug 时更新 `.wolf/buglog.json`**

如果实现过程中修复了失败测试、构建错误、类型错误、或用户报告的问题，追加 buglog entry，格式保持现有数组结构：

```json
{
  "id": "bug-next-number",
  "timestamp": "2026-05-16T00:00:00.000Z",
  "error_message": "Exact failing command and error text",
  "file": "exact/file/path.ts",
  "root_cause": "Specific root cause found in code",
  "fix": "Specific change that fixed the error",
  "tags": ["test", "context", "claims"],
  "related_bugs": [],
  "occurrences": 1,
  "last_seen": "2026-05-16T00:00:00.000Z"
}
```

不要记录 Claude Code host-terminal `Read` pages 参数问题为 Rivet runtime bug；那是宿主工具问题，不是项目代码行为。

- [ ] **步骤 4：Commit**

运行：

```bash
git add .wolf/anatomy.md .wolf/memory.md .wolf/buglog.json
git commit -m "chore: record evolutionary context fabric plan"
```

如果 `.wolf/buglog.json` 没有变化，从 `git add` 中移除它。

---

## 自检清单

### 规格覆盖度

- `ContextClaim` canonical object：任务 1 覆盖。
- Evidence-backed claim proposal：任务 1、任务 5 覆盖。
- JSONL local-first event store：任务 2 覆盖。
- AnchorRegistry runtime seed：任务 5 覆盖。
- Prompt active claims projection：任务 3、任务 5 覆盖。
- Stale/conflicted/quarantined 不污染 prompt：任务 1、任务 2 覆盖。
- Prefix-cache 边界：任务 3、任务 7 覆盖。
- TUI runtime wiring：任务 6 覆盖。
- OpenWolf project bookkeeping：任务 8 覆盖。

### 占位符扫描

本计划已移除空泛占位语和反向引用禁用短语。每个代码变更步骤都给出具体文件、代码片段、命令、预期结果。

### 类型一致性

- Store 类型名统一为 `ContextClaimStore`。
- Prompt projection 方法统一为 `updateActiveClaims(block: string)`。
- Claim 渲染函数统一为 `renderActiveClaimsBlock(claims)`。
- Anchor 转 proposal 函数统一为 `claimProposalFromAnchor(anchor, meta)`。
- Prompt context 字段统一为 `activeClaimsBlock?: string`。

---

## 完成定义

实现完成时必须同时满足：

```bash
npm test -- src/context/__tests__/claims.test.ts src/context/__tests__/claim-store.test.ts src/prompt/__tests__/volatile.test.ts src/prompt/__tests__/engine.test.ts src/agent/__tests__/loop.test.ts
npm test
npm run typecheck
npm run build
```

全部 PASS 后，手动检查一个生成的 JSONL 文件路径形如：

```text
~/.rivet/sessions/<sessionId>.claims.jsonl
```

并确认其中每行都是一个 claim event JSON object。
