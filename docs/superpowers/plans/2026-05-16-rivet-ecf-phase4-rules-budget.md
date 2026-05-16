# ECF Phase 4: Project Rules + Claim Budget 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让用户通过 `.rivet/rules/*.md` 声明式注入持久 project_rule claims（不依赖自动晋升），并为 claim store 增加 budget cap + eviction 防止长 session 膨胀。

**架构：** Project rules loader 在 session 启动时扫描 `.rivet/rules/` 目录，将每个 `.md` 文件转为 `project_rule` claim（scope=project, status=durable, confidence=1.0）。Claim budget 在 `refreshActiveClaims()` 中执行 eviction：当 active claims 超过上限时，按 fitness→confidence→lastUsedAt 淘汰最弱的 claims 为 stale。

**技术栈：** TypeScript, node:test, existing ClaimStore/PromptEngine/AgentLoop infrastructure.

**前置条件：** Phase 3 完成 + P3 审查修复 ✅

---

## Scope

### 本计划包含

- `.rivet/rules/*.md` 文件加载为 `project_rule` claims（durable, scope=project）。
- Session 启动时自动加载；文件变更时 hot-reload（通过 `/context reload` 命令）。
- Claim budget cap：active claims 超过阈值时 evict 最弱 claims。
- Eviction 策略：fitness → confidence → lastUsedAt 排序，最弱的标记 stale。
- `project_rule` claims 豁免 eviction（它们是用户声明的持久规则）。

### 本计划不包含

- FTS5/SQLite 后端。
- Cross-machine export/import。
- Recall tool 接线。
- Rules 文件的 watch/fsnotify 自动热加载（用命令触发即可）。

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/context/rules-loader.ts` | 扫描 `.rivet/rules/*.md`，转为 project_rule ClaimProposal |
| `src/context/claim-budget.ts` | Budget cap 逻辑：eviction 排序 + 豁免规则 |
| `src/context/__tests__/rules-loader.test.ts` | Rules loader 测试 |
| `src/context/__tests__/claim-budget.test.ts` | Budget cap 测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/agent/loop.ts` | `refreshActiveClaims()` 中调用 budget eviction |
| `src/main.tsx` | Session 启动时调用 rules loader |
| `src/tui/slash-commands.ts` | 增加 `/context reload` 命令 |

---

## 任务 1：Project rules loader

**文件：**
- 创建：`src/context/rules-loader.ts`
- 创建：`src/context/__tests__/rules-loader.test.ts`

- [ ] **步骤 1：编写失败测试**

创建 `src/context/__tests__/rules-loader.test.ts`：

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadProjectRules } from '../rules-loader.js'

test('loads .md files from rules directory as project_rule proposals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-rules-'))
  const rulesDir = join(dir, '.rivet', 'rules')
  mkdirSync(rulesDir, { recursive: true })
  writeFileSync(join(rulesDir, 'no-force-push.md'), 'Never use git push --force on main branch.')
  writeFileSync(join(rulesDir, 'test-first.md'), 'Always run tests before committing.')

  try {
    const proposals = loadProjectRules(dir, 'session-1')

    assert.equal(proposals.length, 2)
    assert.ok(proposals.every(p => p.kind === 'project_rule'))
    assert.ok(proposals.every(p => p.scope === 'project'))
    assert.ok(proposals.every(p => p.confidence === 1.0))
    assert.ok(proposals.some(p => p.text.includes('Never use git push --force')))
    assert.ok(proposals.some(p => p.text.includes('Always run tests')))
    assert.ok(proposals.every(p => p.tags.includes('project_rule')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('returns empty array when rules directory does not exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-norules-'))
  try {
    const proposals = loadProjectRules(dir, 'session-1')
    assert.deepEqual(proposals, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('skips non-md files and empty files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-rules-'))
  const rulesDir = join(dir, '.rivet', 'rules')
  mkdirSync(rulesDir, { recursive: true })
  writeFileSync(join(rulesDir, 'valid.md'), 'Use TypeScript strict mode.')
  writeFileSync(join(rulesDir, 'readme.txt'), 'This is not a rule.')
  writeFileSync(join(rulesDir, 'empty.md'), '')

  try {
    const proposals = loadProjectRules(dir, 'session-1')
    assert.equal(proposals.length, 1)
    assert.ok(proposals[0]!.text.includes('TypeScript strict mode'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('truncates long rule files to 500 chars', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-rules-'))
  const rulesDir = join(dir, '.rivet', 'rules')
  mkdirSync(rulesDir, { recursive: true })
  writeFileSync(join(rulesDir, 'long.md'), 'x'.repeat(1000))

  try {
    const proposals = loadProjectRules(dir, 'session-1')
    assert.ok(proposals[0]!.text.length <= 500)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- src/context/__tests__/rules-loader.test.ts`
预期：FAIL（模块不存在）

- [ ] **步骤 3：实现 rules-loader.ts**

创建 `src/context/rules-loader.ts`：

```ts
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ClaimProposal } from './claims.js'

const MAX_RULE_LENGTH = 500

export function loadProjectRules(cwd: string, sessionId: string): ClaimProposal[] {
  const rulesDir = join(cwd, '.rivet', 'rules')
  if (!existsSync(rulesDir)) return []

  const files = readdirSync(rulesDir).filter(f => f.endsWith('.md'))
  const now = Date.now()
  const proposals: ClaimProposal[] = []

  for (const file of files) {
    const content = readFileSync(join(rulesDir, file), 'utf-8').trim()
    if (!content) continue

    proposals.push({
      kind: 'project_rule',
      scope: 'project',
      text: content.slice(0, MAX_RULE_LENGTH),
      confidence: 1.0,
      fitness: 10,
      source: { actor: 'user', sessionId, turn: 0, eventId: `rules:${file}` },
      evidence: [{ id: `rules:${file}`, kind: 'file', summary: `project rule from .rivet/rules/${file}`, path: join(rulesDir, file), createdAt: now }],
      createdAt: now,
      tags: ['project_rule', file.replace('.md', '')],
    })
  }

  return proposals
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test -- src/context/__tests__/rules-loader.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/context/rules-loader.ts src/context/__tests__/rules-loader.test.ts
git commit -m "feat(context): project rules loader — .rivet/rules/*.md → project_rule claims"
```

---

## 任务 2：Claim budget cap + eviction

**文件：**
- 创建：`src/context/claim-budget.ts`
- 创建：`src/context/__tests__/claim-budget.test.ts`

- [ ] **步骤 1：编写失败测试**

创建 `src/context/__tests__/claim-budget.test.ts`：

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { selectEvictionCandidates, MAX_ACTIVE_CLAIMS } from '../claim-budget.js'
import type { ContextClaim } from '../claims.js'

function claim(id: string, overrides: Partial<ContextClaim> = {}): ContextClaim {
  return {
    id,
    kind: 'file_observation',
    scope: 'session',
    status: 'active',
    text: `claim ${id}`,
    confidence: 0.7,
    fitness: 3,
    source: { actor: 'tool', sessionId: 's1', turn: 1, eventId: 'e1' },
    evidence: [{ id: 'ev1', kind: 'tool_result', summary: 'x', createdAt: 1 }],
    counterevidence: [],
    consumers: [],
    createdAt: 1,
    lastUsedAt: 1,
    tags: [],
    ...overrides,
  }
}

test('returns empty when under budget', () => {
  const claims = Array.from({ length: 10 }, (_, i) => claim(`c${i}`))
  assert.deepEqual(selectEvictionCandidates(claims), [])
})

test('evicts lowest fitness+confidence claims when over budget', () => {
  const claims = Array.from({ length: MAX_ACTIVE_CLAIMS + 5 }, (_, i) =>
    claim(`c${i}`, { fitness: i, confidence: 0.5 + i * 0.01 }),
  )

  const evicted = selectEvictionCandidates(claims)

  assert.equal(evicted.length, 5)
  assert.deepEqual(evicted.map(c => c.id), ['c0', 'c1', 'c2', 'c3', 'c4'])
})

test('never evicts project_rule claims', () => {
  const rules = Array.from({ length: 5 }, (_, i) =>
    claim(`rule${i}`, { kind: 'project_rule', fitness: 0, confidence: 0.1 }),
  )
  const regular = Array.from({ length: MAX_ACTIVE_CLAIMS + 3 }, (_, i) =>
    claim(`c${i}`, { fitness: 5 }),
  )

  const evicted = selectEvictionCandidates([...rules, ...regular])

  assert.ok(evicted.every(c => c.kind !== 'project_rule'))
  assert.equal(evicted.length, 3)
})

test('never evicts user_constraint claims', () => {
  const constraints = [claim('uc1', { kind: 'user_constraint', fitness: 0 })]
  const regular = Array.from({ length: MAX_ACTIVE_CLAIMS + 1 }, (_, i) =>
    claim(`c${i}`, { fitness: 5 }),
  )

  const evicted = selectEvictionCandidates([...constraints, ...regular])

  assert.ok(evicted.every(c => c.kind !== 'user_constraint'))
  assert.equal(evicted.length, 1)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- src/context/__tests__/claim-budget.test.ts`
预期：FAIL（模块不存在）

- [ ] **步骤 3：实现 claim-budget.ts**

创建 `src/context/claim-budget.ts`：

```ts
import type { ContextClaim } from './claims.js'

export const MAX_ACTIVE_CLAIMS = 50

const EXEMPT_KINDS: ContextClaim['kind'][] = ['project_rule', 'user_constraint', 'user_preference']

export function selectEvictionCandidates(activeClaims: ContextClaim[]): ContextClaim[] {
  const evictable = activeClaims.filter(c => !EXEMPT_KINDS.includes(c.kind))
  const exempt = activeClaims.length - evictable.length
  const budget = MAX_ACTIVE_CLAIMS - exempt
  if (evictable.length <= budget) return []

  const sorted = [...evictable].sort((a, b) =>
    a.fitness - b.fitness || a.confidence - b.confidence || a.lastUsedAt - b.lastUsedAt,
  )

  return sorted.slice(0, evictable.length - budget)
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test -- src/context/__tests__/claim-budget.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/context/claim-budget.ts src/context/__tests__/claim-budget.test.ts
git commit -m "feat(context): claim budget cap with fitness-based eviction (exempt project_rule/user_constraint)"
```

---

## 任务 3：AgentLoop 接线 — budget eviction + rules loading

**文件：**
- 修改：`src/agent/loop.ts`
- 修改：`src/main.tsx`

- [ ] **步骤 1：在 refreshActiveClaims() 中添加 budget eviction**

在 `src/agent/loop.ts` 的 `refreshActiveClaims()` 中，conflict detection 之后、projection 之前：

```ts
import { selectEvictionCandidates } from '../context/claim-budget.js'
```

```ts
// Budget eviction
const preEviction = this.config.contextClaimStore.listActiveClaims()
const toEvict = selectEvictionCandidates(preEviction)
for (const c of toEvict) {
  this.config.contextClaimStore.updateClaimStatus(c.id, 'stale', 'budget eviction')
}
```

- [ ] **步骤 2：在 main.tsx session 启动时加载 project rules**

在 `src/main.tsx` 中，`claimStore` 创建后、`AgentLoop` 构造前：

```ts
import { loadProjectRules } from './context/rules-loader.js'
```

```ts
// Load project rules into claim store
const projectRules = loadProjectRules(cwd, sessionId)
for (const rule of projectRules) {
  claimStore.propose(rule)
}
```

注意：`propose` 是幂等的（同 text+kind+scope+sessionId 不会重复创建），所以 resume 时重新加载不会产生重复 claims。但 project rules 的 sessionId 应该用固定值 `'project'` 而非当前 sessionId，这样跨 session 的 dedup 才能生效。

修正 `rules-loader.ts` 中的 source.sessionId：

```ts
source: { actor: 'user', sessionId: 'project', turn: 0, eventId: `rules:${file}` },
```

- [ ] **步骤 3：运行 typecheck + test**

运行：`npx tsc --noEmit && npm test`
预期：全部通过

- [ ] **步骤 4：Commit**

```bash
git add src/agent/loop.ts src/main.tsx src/context/rules-loader.ts
git commit -m "feat(context): wire budget eviction into agent loop + load project rules on session start"
```

---

## 任务 4：/context reload 命令

**文件：**
- 修改：`src/tui/slash-commands.ts`

- [ ] **步骤 1：添加 /context reload handler**

在 `src/tui/slash-commands.ts` 的 `/context` args 处理中添加：

```ts
if (args === 'reload') {
  const store = ctx.claimStoreRef.current
  if (!store) {
    pushStatic(createLogEntry({ type: 'text', content: 'Claim store not available.' }))
    setIsStreaming(false)
    return true
  }
  const { loadProjectRules } = await import('../context/rules-loader.js')
  const proposals = loadProjectRules(process.cwd(), 'project')
  let loaded = 0
  for (const p of proposals) {
    store.propose(p)
    loaded++
  }
  pushStatic(createLogEntry({ type: 'text', content: `Reloaded ${loaded} project rules from .rivet/rules/` }))
  setIsStreaming(false)
  return true
}
```

- [ ] **步骤 2：运行 typecheck**

运行：`npx tsc --noEmit`
预期：无错误

- [ ] **步骤 3：运行全部测试**

运行：`npm test`
预期：全部通过（830+）

- [ ] **步骤 4：Commit**

```bash
git add src/tui/slash-commands.ts
git commit -m "feat(tui): /context reload — hot-reload project rules from .rivet/rules/"
```

---

## 任务 5：Goal loop 也加载 project rules

**文件：**
- 修改：`src/main.tsx`（headless --goal 路径）

- [ ] **步骤 1：在 goal loop 路径中加载 project rules**

在 `src/main.tsx` 的 `--goal` 路由中，`claimStore` 创建后添加：

```ts
const { loadProjectRules } = await import('./context/rules-loader.js')
for (const rule of loadProjectRules(process.cwd(), 'project')) {
  claimStore.propose(rule)
}
```

- [ ] **步骤 2：运行 typecheck**

运行：`npx tsc --noEmit`
预期：无错误

- [ ] **步骤 3：Commit**

```bash
git add src/main.tsx
git commit -m "feat(goal): load project rules in autonomous goal loop mode"
```

---

## 验收标准

| 标准 | 验证方法 |
|------|---------|
| `.rivet/rules/no-force-push.md` 内容出现在 prompt 的 `<active-claims>` 中 | 创建规则文件 → 启动 session → 检查 prompt |
| Project rules 是 durable + scope=project | `claimStore.listClaims({ kind: ['project_rule'] })` 全部 status=durable |
| 空 `.rivet/rules/` 或不存在时不报错 | 测试覆盖 |
| Active claims 超过 50 时自动 evict 最弱 claims | Budget 测试覆盖 |
| project_rule 和 user_constraint 豁免 eviction | Budget 测试覆盖 |
| `/context reload` 重新加载规则 | 手动验证 |
| Goal loop 也加载 project rules | typecheck 通过 |
| 所有测试通过 | `npm test`: 830+ pass, 0 fail |

---

## 风险与防线

| 风险 | 应对 |
|------|------|
| Rules 文件过大撑爆 prompt | 每个 rule 截断 500 chars；MAX_PROMPT_CLAIMS=20 已有上限 |
| 大量 rules 文件（>20）占满 prompt budget | fitness=10 保证 project_rule 排在最前；超出 MAX_PROMPT_CLAIMS 的自然被截断 |
| Eviction 误杀重要 claim | EXEMPT_KINDS 保护 project_rule/user_constraint/user_preference |
| Project rules dedup 跨 session 失效 | 使用固定 sessionId='project' 保证 claim ID 稳定 |
