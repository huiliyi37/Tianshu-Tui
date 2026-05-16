# Evolutionary Context Fabric Phase 2 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 Phase 1 的 evidence-backed session claims 基础上，实现最小可用的 claim lifecycle：投影消费记录、确定性晋升、文件变更 staleness、以及 TUI 可观测入口。

**架构：** Phase 2 不更换 JSONL 存储，也不引入 SQLite/vector/global memory。它把 Phase 1 已有的 `ContextClaimStore` 事件流变成可演化状态机：每次 prompt projection 记录消费者，工具结果触发 revalidation，promotion gate 根据消费者和反证确定 status transition，TUI 只展示计数和列表，不做交互式裁决。

**技术栈：** TypeScript, node:test, Ink/React TUI, JSONL append-only event store, existing Cockpit snapshot.

---

## Scope

### 本计划包含

- Runtime 消费追踪：active claims 被注入 prompt 后写入 `claim_used` 事件。
- 确定性晋升：`active -> durable_candidate` 基于消费者数量和无反证条件自动发生。
- 保守 revalidation：文件修改后，含该文件 evidence 的 claim 被标记为 `stale`。
- Claim 计数观测：Cockpit Context 面板展示 active/stale/conflicted/durable 计数。
- `/context claims [active|stale|conflicted|durable]` 文本列表。

### 本计划不包含

- SQLite/WAL/vector index。
- 跨 session/global memory。
- worker claim proposal / coordinator merge。
- 交互式 conflict adjudication UI。
- antibody/immune layer。
- import/export/encryption。

这些都需要新的数据边界或 UX，不应混进 Phase 2 一个 PR。

---

## 文件结构

### 新建文件

- `src/context/promotion.ts` — claim lifecycle 纯函数：promotion evaluation、file-evidence matching、claim-count summary。
- `src/context/__tests__/promotion.test.ts` — promotion/staleness/counting 单元测试。

### 修改文件

- `src/context/claims.ts` — 导出 `ClaimStatusCounts` 类型，保持 canonical claim model 不承担 runtime side effects。
- `src/context/claim-store.ts` — 增加 typed 查询方法：`listClaimsByFileEvidence(path)`、`getStatusCounts()`、`promoteEligibleClaims()`。
- `src/context/__tests__/claim-store.test.ts` — 覆盖新 store 查询和 promotion event replay。
- `src/agent/loop.ts` — 在 `refreshActiveClaims()` 记录 prompt consumer；成功写/改文件后触发 file evidence staleness；每轮构建 request 前运行 promotion gate。
- `src/agent/__tests__/loop.test.ts` — 覆盖 projected claim 被记录 consumer、三次 projection 后进入 `durable_candidate`、文件修改 stale。
- `src/tui/cockpit/types.ts` — `CockpitSnapshot.context` 增加 `claimCounts`。
- `src/tui/cockpit/state.ts` — `buildCockpitSnapshot()` 接收 claim counts 并放入 context snapshot。
- `src/tui/cockpit/context-panel.tsx` — Context 面板增加一行 claim summary。
- `src/tui/__tests__/cockpit-context.test.tsx` 或现有 cockpit 测试文件 — 覆盖 claim summary 渲染。
- `src/tui/app.tsx` — 注入 claim store 到 cockpit snapshot；扩展 `/context claims` slash command。
- `src/tui/__tests__/app-context-claims.test.tsx` 或现有 app 测试文件 — 覆盖 slash command 输出格式。
- `.wolf/anatomy.md` — 记录 Phase 2 文件职责。
- `.wolf/memory.md` — 记录 Phase 2 计划创建。

---

## Lifecycle Rules

### Prompt consumer tracking

- 每次 `AgentLoop.refreshActiveClaims()` 获取将要投影的 claims。
- 对每个 claim 调用：

```ts
store.recordClaimUsed(claim.id, {
  consumerId: `turn-${this.session.getTurnCount()}:prompt`,
  consumerKind: 'prompt',
  usedAt: Date.now(),
})
```

- 同一 turn 内避免重复记录同一个 claim consumer；测试可通过同一个 `consumerId` 验证 store replay 后没有重复 consumer，或者在 runtime 保证每 turn 只调用一次 `refreshActiveClaims()`。

### Promotion gate

- `active -> durable_candidate`：`consumers.length >= 3` 且 `counterevidence.length === 0` 且未过期。
- `durable_candidate -> durable`：Phase 2 不自动发生，需要未来用户确认命令。
- `stale/conflicted/quarantined`：不自动恢复。

### File staleness

- Evidence path 精确匹配修改路径时，claim 标记为 `stale`。
- 仅处理 `file_observation` 和 `verification_fact` claim；用户约束不因文件修改 stale。
- 路径比较使用 `validatePath()` 后的绝对路径或 store 中保存的原始 path；Phase 2 使用简单 normalized string match，不做 glob/semantic matching。

---

## 任务 1：Promotion 纯函数

**文件：**
- 创建：`src/context/promotion.ts`
- 创建：`src/context/__tests__/promotion.test.ts`
- 修改：`src/context/claims.ts`

- [ ] **步骤 1：编写失败测试**

创建 `src/context/__tests__/promotion.test.ts`：

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluatePromotion, claimHasFileEvidence, countClaimsByStatus } from '../promotion.js'
import type { ContextClaim } from '../claims.js'

function claim(overrides: Partial<ContextClaim> = {}): ContextClaim {
  return {
    id: 'c1',
    kind: 'user_constraint',
    scope: 'session',
    status: 'active',
    text: 'Run tests before claiming done',
    confidence: 0.9,
    fitness: 5,
    source: { actor: 'user', sessionId: 's1', turn: 1, eventId: 'e1' },
    evidence: [{ id: 'e1', kind: 'user_message', summary: 'Run tests', createdAt: 1 }],
    counterevidence: [],
    consumers: [],
    createdAt: 1,
    lastUsedAt: 1,
    tags: ['anchor'],
    ...overrides,
  }
}

test('promotes active claims with three prompt consumers and no counterevidence', () => {
  const result = evaluatePromotion(claim({
    consumers: [
      { id: 'turn-1:prompt', kind: 'prompt', usedAt: 1 },
      { id: 'turn-2:prompt', kind: 'prompt', usedAt: 2 },
      { id: 'turn-3:prompt', kind: 'prompt', usedAt: 3 },
    ],
  }), 4)

  assert.equal(result, 'durable_candidate')
})

test('does not promote claims with counterevidence or expiry', () => {
  assert.equal(evaluatePromotion(claim({
    counterevidence: [{ id: 'ce1', kind: 'tool_result', summary: 'contradicted', createdAt: 2 }],
    consumers: [
      { id: 'turn-1:prompt', kind: 'prompt', usedAt: 1 },
      { id: 'turn-2:prompt', kind: 'prompt', usedAt: 2 },
      { id: 'turn-3:prompt', kind: 'prompt', usedAt: 3 },
    ],
  }), 4), null)

  assert.equal(evaluatePromotion(claim({
    expiresAt: 4,
    consumers: [
      { id: 'turn-1:prompt', kind: 'prompt', usedAt: 1 },
      { id: 'turn-2:prompt', kind: 'prompt', usedAt: 2 },
      { id: 'turn-3:prompt', kind: 'prompt', usedAt: 3 },
    ],
  }), 4), null)
})

test('matches file evidence by path', () => {
  const observed = claim({
    kind: 'file_observation',
    evidence: [{ id: 'f1', kind: 'file', summary: 'read config', path: '/repo/src/config.ts', createdAt: 1 }],
  })

  assert.equal(claimHasFileEvidence(observed, '/repo/src/config.ts'), true)
  assert.equal(claimHasFileEvidence(observed, '/repo/src/other.ts'), false)
})

test('counts claims by lifecycle status', () => {
  assert.deepEqual(countClaimsByStatus([
    claim({ id: 'a', status: 'active' }),
    claim({ id: 's', status: 'stale' }),
    claim({ id: 'd', status: 'durable' }),
    claim({ id: 'c', status: 'conflicted' }),
  ]), { active: 1, stale: 1, conflicted: 1, durable: 1, durableCandidate: 0, quarantined: 0 })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/context/__tests__/promotion.test.ts
```

预期：FAIL，报错找不到 `../promotion.js`。

- [ ] **步骤 3：实现 promotion 纯函数**

创建 `src/context/promotion.ts`：

```ts
import { isPromptEligibleClaim, type ContextClaim, type ContextClaimStatus } from './claims.js'

export interface ClaimStatusCounts {
  active: number
  stale: number
  conflicted: number
  durable: number
  durableCandidate: number
  quarantined: number
}

export function evaluatePromotion(claim: ContextClaim, now = Date.now()): ContextClaimStatus | null {
  if (claim.status !== 'active') return null
  if (!isPromptEligibleClaim(claim, now)) return null
  if (claim.counterevidence.length > 0) return null
  if (claim.consumers.length < 3) return null
  return 'durable_candidate'
}

export function claimHasFileEvidence(claim: ContextClaim, path: string): boolean {
  if (claim.kind !== 'file_observation' && claim.kind !== 'verification_fact') return false
  return claim.evidence.some(evidence => evidence.path === path)
}

export function countClaimsByStatus(claims: ContextClaim[]): ClaimStatusCounts {
  return claims.reduce<ClaimStatusCounts>((counts, claim) => {
    if (claim.status === 'active') return { ...counts, active: counts.active + 1 }
    if (claim.status === 'stale') return { ...counts, stale: counts.stale + 1 }
    if (claim.status === 'conflicted') return { ...counts, conflicted: counts.conflicted + 1 }
    if (claim.status === 'durable') return { ...counts, durable: counts.durable + 1 }
    if (claim.status === 'durable_candidate') return { ...counts, durableCandidate: counts.durableCandidate + 1 }
    if (claim.status === 'quarantined') return { ...counts, quarantined: counts.quarantined + 1 }
    return counts
  }, { active: 0, stale: 0, conflicted: 0, durable: 0, durableCandidate: 0, quarantined: 0 })
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/context/__tests__/promotion.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/context/promotion.ts src/context/__tests__/promotion.test.ts
git commit -m "feat: add context claim promotion rules"
```

---

## 任务 2：ClaimStore lifecycle 查询与批量 transition

**文件：**
- 修改：`src/context/claim-store.ts`
- 修改：`src/context/__tests__/claim-store.test.ts`
- 使用：`src/context/promotion.ts`

- [ ] **步骤 1：编写失败测试**

在 `src/context/__tests__/claim-store.test.ts` 添加：

```ts
test('lists claims with file evidence and summarizes lifecycle statuses', () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')
    const fileClaim = store.propose({
      ...proposal('Observed config'),
      kind: 'file_observation',
      evidence: [{ id: 'f1', kind: 'file', summary: 'config', path: '/repo/src/config.ts', createdAt: 10 }],
    })
    const active = store.propose(proposal('Keep active'))
    store.updateClaimStatus(active.id, 'durable', 'user confirmed')

    assert.deepEqual(store.listClaimsByFileEvidence('/repo/src/config.ts').map(c => c.id), [fileClaim.id])
    assert.deepEqual(store.getStatusCounts(), {
      active: 1,
      stale: 0,
      conflicted: 0,
      durable: 1,
      durableCandidate: 0,
      quarantined: 0,
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('promotes eligible claims by appending status transition events', () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')
    const claim = store.propose(proposal('Project this claim repeatedly'))
    for (const turn of [1, 2, 3]) {
      store.recordClaimUsed(claim.id, { consumerId: `turn-${turn}:prompt`, consumerKind: 'prompt', usedAt: turn })
    }

    const promoted = store.promoteEligibleClaims(4)

    assert.deepEqual(promoted.map(c => c.id), [claim.id])
    assert.equal(store.listClaims()[0]?.status, 'durable_candidate')
    assert.match(store.exportSession(), /claim_status_changed/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/context/__tests__/claim-store.test.ts
```

预期：FAIL，`listClaimsByFileEvidence` / `getStatusCounts` / `promoteEligibleClaims` 不存在。

- [ ] **步骤 3：实现 store 方法**

在 `src/context/claim-store.ts` 引入：

```ts
import { claimHasFileEvidence, countClaimsByStatus, evaluatePromotion, type ClaimStatusCounts } from './promotion.js'
```

新增方法：

```ts
listClaimsByFileEvidence(path: string): ContextClaim[] {
  return this.listClaims().filter(claim => claimHasFileEvidence(claim, path))
}

getStatusCounts(): ClaimStatusCounts {
  return countClaimsByStatus(this.listClaims())
}

promoteEligibleClaims(now = Date.now()): ContextClaim[] {
  const promoted: ContextClaim[] = []
  for (const claim of this.listClaims()) {
    const next = evaluatePromotion(claim, now)
    if (!next) continue
    const updated = this.updateClaimStatus(claim.id, next, 'promotion threshold met')
    if (updated) promoted.push(updated)
  }
  return promoted
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/context/__tests__/claim-store.test.ts src/context/__tests__/promotion.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/context/claim-store.ts src/context/__tests__/claim-store.test.ts src/context/promotion.ts src/context/__tests__/promotion.test.ts
git commit -m "feat: add claim lifecycle store queries"
```

---

## 任务 3：AgentLoop consumer tracking 与 promotion

**文件：**
- 修改：`src/agent/loop.ts`
- 修改：`src/agent/__tests__/loop.test.ts`

- [ ] **步骤 1：编写失败测试**

在 `src/agent/__tests__/loop.test.ts` 添加测试，复用已有 fake client/registry helper：

```ts
it('records prompt consumers and promotes repeatedly projected claims', async () => {
  const session = new SessionContext()
  const registry = new ToolRegistry()
  const engine = makeEngine()
  const claimDir = mkdtempSync(join(tmpdir(), 'rivet-loop-claims-'))
  const claimStore = new ContextClaimStore(claimDir, 'session-123')
  const client = makeClient([
    { type: 'text', text: 'ok' },
    { type: 'text', text: 'ok again' },
    { type: 'text', text: 'ok third' },
  ])
  const agent = new AgentLoop({
    client,
    promptEngine: engine,
    toolRegistry: registry,
    maxTurns: 1,
    contextWindow: 1_000_000,
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    sessionId: 'session-123',
    contextClaimStore: claimStore,
  }, session, '/test')

  await agent.run('CRITICAL: always run tests before saying done', callbacks())
  await agent.run('continue', callbacks())
  await agent.run('continue again', callbacks())

  const [claim] = claimStore.listClaims()
  assert.equal(claim?.status, 'durable_candidate')
  assert.equal(claim?.consumers.length, 3)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/agent/__tests__/loop.test.ts
```

预期：FAIL，consumer 未记录或 status 仍为 `active`。

- [ ] **步骤 3：实现 runtime consumer tracking**

修改 `refreshActiveClaims()`：

```ts
private refreshActiveClaims(): void {
  if (!this.config.contextClaimStore) {
    this.config.promptEngine.updateActiveClaims([])
    return
  }

  this.config.contextClaimStore.promoteEligibleClaims()
  const activeClaims = this.config.contextClaimStore.listActiveClaims()
  const usedAt = Date.now()
  const consumerId = `turn-${this.session.getTurnCount()}:prompt`
  for (const claim of activeClaims) {
    this.config.contextClaimStore.recordClaimUsed(claim.id, {
      consumerId,
      consumerKind: 'prompt',
      usedAt,
    })
  }
  this.config.promptEngine.updateActiveClaims(this.config.contextClaimStore.listActiveClaims())
}
```

If duplicate `recordClaimUsed()` events appear in tests, update `ContextClaimStore.recordClaimUsed()` to return existing claim when the same `consumerId` is already present.

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/agent/__tests__/loop.test.ts src/context/__tests__/claim-store.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/agent/loop.ts src/agent/__tests__/loop.test.ts src/context/claim-store.ts src/context/__tests__/claim-store.test.ts
git commit -m "feat: track context claim prompt consumers"
```

---

## 任务 4：File evidence staleness

**文件：**
- 修改：`src/agent/loop.ts`
- 修改：`src/context/claim-store.ts`
- 修改：`src/context/__tests__/claim-store.test.ts`
- 修改：`src/agent/__tests__/loop.test.ts`

- [ ] **步骤 1：编写失败测试**

在 `src/context/__tests__/claim-store.test.ts` 添加：

```ts
test('marks claims with matching file evidence as stale', () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')
    const fileClaim = store.propose({
      ...proposal('Observed file'),
      kind: 'file_observation',
      evidence: [{ id: 'f1', kind: 'file', summary: 'file', path: '/repo/src/a.ts', createdAt: 10 }],
    })

    const updated = store.markClaimsStaleForFile('/repo/src/a.ts', 'file modified')

    assert.deepEqual(updated.map(c => c.id), [fileClaim.id])
    assert.equal(store.listClaims()[0]?.status, 'stale')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/context/__tests__/claim-store.test.ts
```

预期：FAIL，`markClaimsStaleForFile` 不存在。

- [ ] **步骤 3：实现 stale helper**

在 `ContextClaimStore` 添加：

```ts
markClaimsStaleForFile(path: string, reason: string): ContextClaim[] {
  const changed: ContextClaim[] = []
  for (const claim of this.listClaimsByFileEvidence(path)) {
    if (claim.status === 'stale' || claim.status === 'quarantined') continue
    const updated = this.updateClaimStatus(claim.id, 'stale', reason)
    if (updated) changed.push(updated)
  }
  return changed
}
```

- [ ] **步骤 4：AgentLoop 写文件成功后调用**

在 `src/agent/loop.ts` 已有 successful write/edit branch 后加入：

```ts
this.config.contextClaimStore?.markClaimsStaleForFile(
  tu.input.file_path as string,
  `file modified by ${tu.name}`,
)
```

位置：`this.evidence.trackFileModified(...)` 后，impact hint 前。

- [ ] **步骤 5：运行测试验证通过**

运行：

```bash
npm test -- src/context/__tests__/claim-store.test.ts src/agent/__tests__/loop.test.ts
```

预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add src/context/claim-store.ts src/context/__tests__/claim-store.test.ts src/agent/loop.ts src/agent/__tests__/loop.test.ts
git commit -m "feat: stale context claims after file edits"
```

---

## 任务 5：Cockpit Context claim counts

**文件：**
- 修改：`src/tui/cockpit/types.ts`
- 修改：`src/tui/cockpit/state.ts`
- 修改：`src/tui/cockpit/context-panel.tsx`
- 修改：相关 TUI cockpit 测试文件

- [ ] **步骤 1：编写失败测试**

在 cockpit context panel 测试中构造 snapshot：

```ts
it('renders claim status counts in the context panel', () => {
  const snapshot = buildCockpitSnapshot({
    contextLayerReport: emptyContextLayerReport,
    claimCounts: { active: 2, stale: 1, conflicted: 0, durable: 1, durableCandidate: 0, quarantined: 0 },
  })

  const output = renderContextPanelToText(snapshot)

  assert.match(output, /Claims: 2 active, 1 stale, 1 durable/)
})
```

Use existing render helpers from current TUI tests. If no helper exists, add a pure formatter function in `context-panel.tsx`:

```ts
export function formatClaimCounts(counts: ClaimStatusCounts): string { ... }
```

and test it directly.

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/tui/__tests__/*.test.ts
```

预期：FAIL，claim count fields/formatter missing。

- [ ] **步骤 3：扩展 cockpit snapshot types**

在 `src/tui/cockpit/types.ts` 的 `CockpitSnapshot.context` 中加入：

```ts
claimCounts: ClaimStatusCounts
```

从 `src/context/promotion.ts` import type。

- [ ] **步骤 4：扩展 snapshot builder**

在 `src/tui/cockpit/state.ts` 的 input config 中加入 optional `claimCounts`，默认：

```ts
{ active: 0, stale: 0, conflicted: 0, durable: 0, durableCandidate: 0, quarantined: 0 }
```

并写入 `snapshot.context.claimCounts`。

- [ ] **步骤 5：ContextPanel 渲染 claim summary**

在 `src/tui/cockpit/context-panel.tsx` 添加纯函数：

```ts
export function formatClaimCounts(counts: ClaimStatusCounts): string {
  const parts = [
    counts.active > 0 ? `${counts.active} active` : '',
    counts.stale > 0 ? `${counts.stale} stale` : '',
    counts.conflicted > 0 ? `${counts.conflicted} conflicted` : '',
    counts.durable > 0 ? `${counts.durable} durable` : '',
  ].filter(Boolean)
  return parts.length === 0 ? 'Claims: none' : `Claims: ${parts.join(', ')}`
}
```

Render this below context budget/ledger line.

- [ ] **步骤 6：运行测试验证通过**

运行：

```bash
npm test -- src/tui/__tests__/*.test.ts
```

预期：PASS。

- [ ] **步骤 7：Commit**

```bash
git add src/tui/cockpit/types.ts src/tui/cockpit/state.ts src/tui/cockpit/context-panel.tsx src/tui/__tests__/*.test.ts
git commit -m "feat: show context claim counts in cockpit"
```

---

## 任务 6：`/context claims` slash command

**文件：**
- 修改：`src/tui/app.tsx`
- 修改：相关 TUI app/slash command 测试

- [ ] **步骤 1：编写失败测试**

在 app command 测试中新增：

```ts
it('lists active context claims from slash command', async () => {
  const claimStore = new ContextClaimStore(tempDir(), 'session-123')
  claimStore.propose(proposal('Run tests before claiming done'))

  const output = await runSlashCommand('/context claims active', { claimStore })

  assert.match(output, /Run tests before claiming done/)
  assert.match(output, /active/)
})
```

If existing tests do not expose `runSlashCommand`, extract a pure helper from `handleSlashCommand()`:

```ts
export function formatContextClaimsCommand(store: ContextClaimStore, status?: ContextClaimStatus): string { ... }
```

Then test that helper directly.

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/tui/__tests__/*.test.ts
```

预期：FAIL，helper or command branch missing。

- [ ] **步骤 3：实现 pure formatter**

创建或添加到 `src/tui/app.tsx`：

```ts
function formatClaimLine(claim: ContextClaim): string {
  return `- [${claim.status}] ${claim.kind}: ${claim.text}`
}

export function formatContextClaimsCommand(store: ContextClaimStore, status?: ContextClaimStatus): string {
  const claims = status
    ? store.listClaims({ status: [status] })
    : store.listClaims()
  if (claims.length === 0) return 'No context claims.'
  return claims.map(formatClaimLine).join('\n')
}
```

- [ ] **步骤 4：接入 slash command**

在 `/context` command 分支中识别：

```ts
/context claims
/context claims active
/context claims stale
/context claims conflicted
/context claims durable
```

将输出追加到消息列表。无效 status 输出：

```text
Usage: /context claims [active|stale|conflicted|durable]
```

- [ ] **步骤 5：Cockpit snapshot 注入 counts**

在创建 cockpit snapshot 的地方传入：

```ts
claimCounts: claimStore.getStatusCounts()
```

- [ ] **步骤 6：运行测试验证通过**

运行：

```bash
npm test -- src/tui/__tests__/*.test.ts src/context/__tests__/claim-store.test.ts
```

预期：PASS。

- [ ] **步骤 7：Commit**

```bash
git add src/tui/app.tsx src/tui/__tests__/*.test.ts src/tui/cockpit/state.ts
git commit -m "feat: add context claims slash command"
```

---

## 任务 7：集成验证与文档账本

**文件：**
- 修改：`.wolf/anatomy.md`
- 修改：`.wolf/memory.md`
- 可选修改：`docs/superpowers/specs/2026-05-16-rivet-evolutionary-tui-memory-design.md`

- [ ] **步骤 1：运行完整测试**

运行：

```bash
npm test
```

预期：PASS。

- [ ] **步骤 2：运行类型检查**

运行：

```bash
npm run typecheck
```

预期：PASS。

- [ ] **步骤 3：运行构建**

运行：

```bash
npm run build
```

预期：PASS。

- [ ] **步骤 4：图谱 review**

运行 code-review-graph：

```text
detect_changes(base="HEAD", changed_files=[
  "src/context/promotion.ts",
  "src/context/claim-store.ts",
  "src/agent/loop.ts",
  "src/tui/app.tsx",
  "src/tui/cockpit/state.ts",
  "src/tui/cockpit/context-panel.tsx"
])
```

预期：无 CRITICAL/HIGH blocker；若有 blocker，先修再继续。

- [ ] **步骤 5：更新 OpenWolf**

`.wolf/anatomy.md` 添加：

```md
## Evolutionary Context Fabric Phase 2

- `src/context/promotion.ts` — Deterministic claim promotion, file-evidence matching, and lifecycle status counts.
- `src/context/claim-store.ts` — Lifecycle queries and append-only promotion/staleness transitions.
- `src/agent/loop.ts` — Records prompt consumers and marks file-evidence claims stale after successful writes.
- `src/tui/cockpit/context-panel.tsx` — Shows claim lifecycle counts in Context cockpit panel.
- `src/tui/app.tsx` — `/context claims` command lists claim state.
```

`.wolf/memory.md` 添加：

```md
- [2026-05-16] Phase 2 implemented claim lifecycle transitions, prompt consumer tracking, file staleness, and minimal TUI observability.
```

- [ ] **步骤 6：Commit**

```bash
git add .wolf/anatomy.md .wolf/memory.md docs/superpowers/plans/2026-05-16-rivet-evolutionary-context-fabric-phase2.md
git commit -m "docs: record context fabric phase 2 implementation"
```

---

## 风险与防线

- **Risk: Prompt path writes too often.** Consumer tracking appends JSONL during prompt refresh. Keep one event per claim per turn; make duplicate consumer IDs idempotent if needed.
- **Risk: Promotion before usage event.** Run promotion before projection to promote claims from previous turns; the claim used this turn should influence the next turn.
- **Risk: Stale path matching too narrow.** Phase 2 intentionally uses exact evidence path match. Broader dependency-aware invalidation belongs after import graph integration.
- **Risk: TUI coupling.** Add pure formatters for `/context claims` and claim count strings so tests do not require full Ink interaction.
- **Risk: Scope creep.** Do not add SQLite, vector retrieval, global memory, worker merge, or conflict adjudication in this PR.

---

## 验收标准

- A claim projected in three distinct prompt turns becomes `durable_candidate`.
- Prompt projection writes `claim_used` consumers to JSONL exactly once per claim per turn.
- A `file_observation` claim with matching evidence path becomes `stale` after successful edit/write of that path.
- Expired or stale/conflicted/quarantined claims do not project as active claims.
- Context cockpit panel displays claim lifecycle counts.
- `/context claims active` lists active claims; `/context claims stale` lists stale claims.
- `npm test`, `npm run typecheck`, and `npm run build` pass.
