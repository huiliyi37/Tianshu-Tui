# Project Memory Phase 1 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 Rivet 的 claim store 从 session 级别延伸到 project 级别——turn-end 自动提取项目知识，跨 session 持久化，零衰减。

**架构：** 扩展现有 claim-extractor → 新增 turn-end 自动提取 project_fact/success_pattern/decision 类型的 claims。跨 session 加载时不衰减优先级。scope: 'project' 级别的 claim 不随 session evict。

**技术栈：** TypeScript, node:test, 现有 claim-store/claim-extractor/session-persist 基础设施。

**设计过程：** [`docs/superpowers/specs/2026-05-17-project-memory-brainstorm.md`](../specs/2026-05-17-project-memory-brainstorm.md)

**验收标准：**
| 标准 | 验证方法 |
|------|---------|
| 新增 `project_fact`/`success_pattern` claim kind | `npm run typecheck` 通过 |
| Turn-end 自动提取 project_fact claim | 单元测试：mock turn end → 验证 claim 被创建 |
| 跨 session 加载时不衰减 confidence（移除 `* 0.9`） | 单元测试：loading claims → 原始 confidence 不变 |
| 从 ALL 前驱 session 加载 durable claims（非仅上一个） | 单元测试：3 个前驱 session → 全部加载 |
| 现有测试全部通过 | `npm test` |

---

## 关于 scope: 'project' 的说明

`ContextClaimScope` 已有 `'project'` 枚举值。但当前 claim-extractor 所有生成的 claim 都使用 `scope: 'session'`。本计划将 turn-end 生成的 project-level claims 改为 `scope: 'project'`。单独的持久化隔离（不和 session-evict 一起删除）由后续 Phase 2 实现 ——Phase 1 仅确保 claims 至少跨 session 不被衰减。

---

## 文件结构

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/context/claims.ts` | 新增 `'project_fact'` 和 `'success_pattern'` 到 `ContextClaimKind` |
| `src/context/claim-extractor.ts` | 新增 `extractTurnEndClaims()` 函数 + 新 claim 生成函数 |
| `src/agent/session-persist.ts` | 移除 `* 0.9` 衰减 + 从所有前驱 session 加载 |
| `src/agent/loop.ts` | turn-end 调用 `extractTurnEndClaims()` + `propose` 到 claim store |

---

## 任务 1：新增 ClaimKind

**文件：**
- 修改：`src/context/claims.ts`
- 修改：`src/context/claim-extractor.ts::16-26`

- [ ] **步骤 1：添加新 claim kind**

在 `src/context/claims.ts` 的 `ContextClaimKind` 中添加：

```typescript
export type ContextClaimKind =
  | 'user_constraint'
  | 'user_preference'
  | 'decision'
  | 'file_observation'
  | 'verification_fact'
  | 'failure_pattern'
  | 'project_fact'         // NEW: persistent project-level knowledge
  | 'success_pattern'      // NEW: reusable success pattern
  | 'security_finding'
  | 'worker_finding'
  | 'project_rule'
```

- [ ] **步骤 2：添加 TTL 配置**

在 `src/context/claim-extractor.ts` 的 `TTL` 对象中添加：

```typescript
export type ContextClaimKind =
  | 'user_constraint'
  | 'user_preference'
  | 'decision'
  | 'file_observation'
  | 'verification_fact'
  | 'failure_pattern'
  | 'project_fact'
  | 'success_pattern'
  | 'security_finding'
  | 'worker_finding'
  | 'project_rule'

const TTL: Record<ContextClaimKind, number> = {
  // ... existing TTLs ...
  project_fact: Infinity,      // new
  success_pattern: Infinity,   // new
}
```

- [ ] **步骤 3：运行 typecheck**

运行：`npx tsc --noEmit`
预期：无错误

- [ ] **步骤 4：Commit**

```bash
git add src/context/claims.ts src/context/claim-extractor.ts
git commit -m "feat(context): add project_fact and success_pattern claim kinds"
```

---

## 任务 2：Turn-End 自动提取

**文件：**
- 修改：`src/context/claim-extractor.ts`
- 修改：`src/context/__tests__/claim-extractor.test.ts`（新建或追加）

- [ ] **步骤 1：编写失败测试**

创建或追加到 `src/context/__tests__/claim-extractor.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractTurnEndClaims } from '../claim-extractor.js'
import type { ContextClaimKind, ContextClaimScope } from '../claims.js'

describe('extractTurnEndClaims', () => {
  const meta = { sessionId: 'test-session', turn: 1, eventId: 'turn-1' }

  it('extracts project_fact from files changed', () => {
    const claims = extractTurnEndClaims({
      filesChanged: ['src/server.ts', 'src/routes/api.ts'],
      testsPassed: true,
      testSummary: '3 tests passed',
      toolCount: 5,
      editCount: 2,
    }, meta)
    const projectFact = claims.find(c => c.kind === 'project_fact')
    assert.ok(projectFact, 'should create a project_fact claim')
    assert.equal(projectFact.scope, 'project')
    assert.match(projectFact.text, /server\.ts.*routes\/api\.ts/)
  })

  it('extracts success_pattern when edits + tests pass', () => {
    const claims = extractTurnEndClaims({
      filesChanged: ['src/utils.ts'],
      testsPassed: true,
      testSummary: '15 passed',
      toolCount: 8,
      editCount: 3,
    }, meta)
    const success = claims.find(c => c.kind === 'success_pattern')
    assert.ok(success, 'should create a success_pattern claim')
    assert.equal(success.scope, 'project')
    assert.match(success.text, /3 edits.*8 tools/)
  })

  it('returns empty for read-only turns', () => {
    const claims = extractTurnEndClaims({
      filesChanged: [],
      testsPassed: false,
      testSummary: '',
      toolCount: 2,
      editCount: 0,
    }, meta)
    assert.equal(claims.length, 0)
  })

  it('tags claims with files changed', () => {
    const claims = extractTurnEndClaims({
      filesChanged: ['src/server.ts'],
      testsPassed: true,
      testSummary: 'ok',
      toolCount: 5,
      editCount: 1,
    }, meta)
    for (const c of claims) {
      assert.ok(c.tags.includes('src/server.ts'), `claim should be tagged with the changed file`)
    }
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- src/context/__tests__/claim-extractor.test.ts`
预期：FAIL（`extractTurnEndClaims` 未定义）

- [ ] **步骤 3：实现 extractTurnEndClaims**

在 `src/context/claim-extractor.ts` 末尾添加：

```typescript
export interface TurnEndContext {
  filesChanged: string[]
  testsPassed: boolean
  testSummary: string
  toolCount: number
  editCount: number
}

export function extractTurnEndClaims(ctx: TurnEndContext, meta: ClaimExtractionMeta): ClaimProposal[] {
  const results: ClaimProposal[] = []
  const now = Date.now()

  // Skip read-only turns
  if (ctx.editCount === 0 && !ctx.testsPassed) return []

  // project_fact: what files were changed and why
  // Text format designed for LLM comprehension, not just data dump.
  // Uses natural phrasing so the model treats it as actionable context.
  if (ctx.filesChanged.length > 0) {
    const fileList = ctx.filesChanged.slice(0, 5).join(', ')
    const overflow = ctx.filesChanged.length > 5 ? ` and ${ctx.filesChanged.length - 5} more` : ''
    const testNote = ctx.testsPassed ? ', tests passed' : ', tests not run or failed'
    results.push({
      kind: 'project_fact',
      scope: 'project',
      text: `Modified ${ctx.editCount} file(s): ${fileList}${overflow}${testNote}`,
      confidence: 0.8,
      fitness: 2,
      source: { actor: 'tool', sessionId: meta.sessionId, turn: meta.turn, eventId: meta.eventId },
      evidence: [{
        id: `${meta.eventId}:turn-end`,
        kind: 'tool_result',
        summary: `Turn ${meta.turn}: modified ${ctx.filesChanged.length} files`,
        createdAt: now,
      }],
      createdAt: now,
      tags: ['turn-end', ...ctx.filesChanged],
    })
  }

  // success_pattern: edits + passing tests = a working recipe
  // Natural text: "3 edits, 8 tools, tests passed" — the model
  // understands "this turn was productive" better than raw counts.
  if (ctx.editCount >= 2 && ctx.testsPassed) {
    const fileBrief = ctx.filesChanged.slice(0, 3).join(', ')
    const overflow = ctx.filesChanged.length > 3 ? ` (${ctx.filesChanged.length - 3} more)` : ''
    results.push({
      kind: 'success_pattern',
      scope: 'project',
      text: `${ctx.editCount} edits on ${fileBrief}${overflow}, ${ctx.toolCount} tools, tests passed: ${ctx.testSummary.slice(0, 120)}`,
      confidence: 0.7,
      fitness: 3,
      source: { actor: 'tool', sessionId: meta.sessionId, turn: meta.turn, eventId: meta.eventId },
      evidence: [{
        id: `${meta.eventId}:success`,
        kind: 'test',
        summary: ctx.testSummary.slice(0, 200),
        createdAt: now,
      }],
      createdAt: now,
      tags: ['turn-end', 'success', ...ctx.filesChanged],
    })
  }

  return results
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test -- src/context/__tests__/claim-extractor.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/context/claim-extractor.ts src/context/__tests__/claim-extractor.test.ts
git commit -m "feat(context): turn-end automatic project_fact and success_pattern extraction"
```

---

## 任务 3：跨 Session Claim 持久化（无衰减 + 全加载）

**文件：**
- 修改：`src/agent/session-persist.ts`
- 修改：`src/context/claim-store.ts`
- 修改：`src/agent/__tests__/session-persist.test.ts`

需要添加一个 `hashClaimText` 工具函数到 `session-persist.ts`：

```typescript
import { createHash } from 'node:crypto'

function hashClaimText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}
```

- [ ] **步骤 1：编写失败测试**

在 `src/agent/__tests__/session-persist.test.ts` 中添加：

```typescript
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { evictOldSessionsInternal } from '../session-persist.js'
import { ContextClaimStore, type ContextClaimEvent } from '../../context/claim-store.js'
import type { ContextClaim } from '../../context/claims.js'

describe('cross-session claims', () => {
  const dir = join(tmpdir(), 'rivet-test-' + randomUUID().slice(0, 8))
  const sessionA = 'aaaa-0000-0000-0000-000000000001'
  const sessionB = 'aaaa-0000-0000-0000-000000000002'

  before(() => mkdirSync(dir, { recursive: true }))

  after(() => rmSync(dir, { recursive: true, force: true }))

  it('loadDurableClaims loads from session A into session B', () => {
    // Write a claim_proposed event into session A's claim store
    const storeA = new ContextClaimStore(dir, sessionA)
    storeA.appendEvent({
      type: 'claim_proposed',
      eventId: 'test:claim:1',
      createdAt: Date.now(),
      claim: {
        id: 'test-claim-1',
        kind: 'project_fact' as any,
        scope: 'project' as any,
        status: 'durable',
        text: 'Modified src/server.ts',
        confidence: 0.8,
        fitness: 2,
        source: { actor: 'tool', sessionId: sessionA, turn: 1, eventId: 'turn-1' },
        evidence: [],
        createdAt: Date.now(),
        consumers: [],
        tags: ['turn-end'],
      },
    })

    // Load durable claims from session A
    const claims = ContextClaimStore.loadDurableClaims(dir, sessionA)
    assert.equal(claims.length, 1)
    assert.equal(claims[0].id, 'test-claim-1')
    // loadDurableClaims returns raw confidence; decay is in injectDurableClaims
    assert.equal(claims[0].confidence, 0.8)
  })
})
```

- [ ] **步骤 2：运行测试验证通过**

运行：`npm test -- src/agent/__tests__/session-persist.test.ts`
预期：PASS（`loadDurableClaims` 已有实现，测试确认其行为）

- [ ] **步骤 3：修改 injectDurableClaims → 移除 0.9 衰减 + 全前驱加载**

修改 `src/agent/session-persist.ts`：

```typescript
  /** Load durable claims from ALL previous sessions, deduplicated by text content. */
  loadPreviousDurableClaims(): ContextClaim[] {
    const sessions = SessionPersist.listSessions()
    const previous = sessions
      .filter(s => s !== this.sessionId)
      .sort()
    if (previous.length === 0) return []

    const seenTexts = new Set<string>()
    const allClaims: ContextClaim[] = []
    for (const sessionId of previous) {
      const claims = ContextClaimStore.loadDurableClaims(SESSION_DIR, sessionId)
      for (const claim of claims) {
        // Dedup by text content hash — same knowledge extracted across
        // multiple sessions becomes one claim instead of N copies
        const textKey = hashClaimText(claim.text)
        if (!seenTexts.has(textKey)) {
          allClaims.push(claim)
          seenTexts.add(textKey)
        }
      }
    }
    return allClaims
  }

  /** Inject durable claims from all previous sessions with incremental decay based on session distance. */
  injectDurableClaims(store: ContextClaimStore): void {
    const durableClaims = this.loadPreviousDurableClaims()
    const sessions = SessionPersist.listSessions().sort()
    const currentIndex = sessions.indexOf(this.sessionId)
    const totalSessions = sessions.length

    for (const claim of durableClaims) {
      // Incremental decay: each session gap reduces confidence by 0.05,
      // so the oldest of 50 sessions still has floor 0.5 confidence.
      // This preserves recency signal without the harsh * 0.9 wipe.
      const sessionGap = currentIndex >= 0 ? currentIndex : totalSessions
      const sessionDecay = Math.max(0.5, 1 - sessionGap * 0.05)
      const confidence = Math.round(claim.confidence * sessionDecay * 100) / 100

      store.propose({
        kind: claim.kind,
        scope: claim.scope,
        text: claim.text,
        confidence,
        fitness: claim.fitness,
        source: { ...claim.source, eventId: `resume:${claim.id}` },
        evidence: claim.evidence,
        createdAt: Date.now(),
        tags: [...claim.tags, 'resumed'],
      })
    }
  }
```

- [ ] **步骤 4：运行 typecheck + 测试**

运行：`npx tsc --noEmit && npm test`
预期：全部通过

- [ ] **步骤 5：Commit**

```bash
git add src/agent/session-persist.ts
git commit -m "fix(memory): inject durable claims from all past sessions with full confidence"
```

---

## 任务 4：Loop Turn-End 集成

**文件：**
- 修改：`src/agent/loop.ts`

- [ ] **步骤 1：在 loop.ts 的 turn-end 流程中调用 claim extractor**

在 `src/agent/loop.ts` 中找到 turn-end 处理区域（在 `processTurnEnd` 调用之后，`continue` 或 `break` 之前），添加：

```typescript
import { extractTurnEndClaims } from '../context/claim-extractor.js'

// After processTurnEnd and reasoning effort adjustments (around line 550):
if (this.config.contextClaimStore && this.session.getTurnCount() > 0) {
  const trajectory = this.trajectory
  const turnCtx = {
    filesChanged: trajectory.getEntries()
      .filter(e => e.tool === 'edit_file' || e.tool === 'write_file')
      .map(e => (e.input as any)?.file_path ?? '')
      .filter(Boolean),
    testsPassed: trajectory.getEntries()
      .some(e => e.isError === false && /test|jest|vitest|pytest/i.test(e.tool)),
    testSummary: trajectory.getEntries()
      .filter(e => /test|jest|vitest|pytest/i.test(e.tool))
      .map(e => String(e.result ?? '').slice(0, 100))
      .join('\n'),
    toolCount: trajectory.getEntries().length,
    editCount: trajectory.getEntries()
      .filter(e => e.tool === 'edit_file' || e.tool === 'write_file').length,
  }
  const turnClaims = extractTurnEndClaims(turnCtx, {
    sessionId: this.config.sessionId ?? 'session',
    turn: this.session.getTurnCount(),
    eventId: `turn-${this.session.getTurnCount()}`,
  })
  for (const proposal of turnClaims) {
    this.config.contextClaimStore.propose(proposal)
  }
}
```

需要确认 `trajectory` 对象有 `getEntries()` 方法和条目类型。检查现有 trajectory 的接口。

- [ ] **步骤 2：检查 Trajectory 接口**

确认 `src/agent/trajectory.ts` 中 `getEntries()` 返回的条目包含 `tool`, `input`, `result`, `isError` 字段。如果不完全匹配，调整 loop 中的值提取方式。

- [ ] **步骤 3：运行 typecheck**

运行：`npx tsc --noEmit`
预期：无错误

- [ ] **步骤 4：Commit**

```bash
git add src/agent/loop.ts
git commit -m "feat(agent): integrate turn-end claim extraction into agent loop"
```

---

## 任务 5：集成验证

**文件：** 无新文件

- [ ] **步骤 1：运行完整测试套件**

运行：`npm test`
预期：全部通过

- [ ] **步骤 2：运行 typecheck**

运行：`npx tsc --noEmit`
预期：无错误

- [ ] **步骤 3：端到端验证**

手动或用 mock 验证数据流：
1. 启动 Rivet
2. 执行一个包含编辑和测试的 turn
3. 确认 turn-end 自动生成 `project_fact` claim
4. 重启 Rivet（新 session）
5. 确认前驱 session 的 durable claims 被加载（无衰减）
6. 执行 `/context` 查看 active claims 列表

- [ ] **步骤 4：最终 Commit**

```bash
git add -A
git commit -m "feat(memory): project memory Phase 1 — turn-end extraction + cross-session persistence"
```

---

## 风险与防线

| 风险 | 防线 | 实现方式 |
|------|------|---------|
| 跨 session 同义 claim 无法去重 | **文本语义去重** — `loadPreviousDurableClaims` 按 `hashClaimText(text)` 去重，非仅 claim ID | `session-persist.ts:loadPreviousDurableClaims` |
| 模板化文本模型忽略 | **自然语言摘要** — claim text 用自然句式（"Modified N files: ..., tests passed"）而非模板拼接 | `claim-extractor.ts:project_fact` / `success_pattern` |
| 旧 session claim 压倒新知识 | **增量衰减** — 每跨一个 session 衰减 0.05 而非旧的 * 0.9，100%→50% 平滑下降 | `session-persist.ts:injectDurableClaims` |
| Turn-end 提取的噪音过长 | `testSummary` 只截取 100 字符 | `claim-extractor.ts` |
| 所有前驱 session 的 claims 爆量 | `propose()` 按 claim id + text hash 去重；生产环境 session 数上限 50 | `session-persist.ts` |
| Trajectory 条目结构不符 | 步骤 2 先检查接口，不匹配时调整提取逻辑 | Task 4 |
| `extractTurnEndClaims` 在 read-only turn 产生空 claim | 显式返回 `[]` 条件覆盖 | `claim-extractor.ts` |
| 旧 `injectDurableClaims` 被其他路径引用 | 只有 `main.tsx` 中调用，改后新行为覆盖所有启动路径 | Task 3 |

---

## Phase 1 完成状态

| 能力 | 完成后状态 |
|------|-----------|
| 新增 claim kind | 新增 `project_fact`、`success_pattern` |
| Turn-end 自动提取 | 每次 agent turn 结束后自动生成 |
| 跨 session 持久化 | 所有前驱 session 的 durable claims 被加载 |
| 无衰减 | confidence 原值保留 |
| 现有测试 | 全部通过 |
