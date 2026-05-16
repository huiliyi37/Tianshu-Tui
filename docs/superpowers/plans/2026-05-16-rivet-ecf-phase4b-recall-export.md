# ECF Phase 4B: Recall Tool + Claim Export/Import 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 recall 工具从死代码激活并接入 claim store，让 agent 能按关键词搜索历史 claims；增加 JSON export/import 支持跨机器迁移 durable claims。

**架构：** 重写 recall 工具：搜索 claim store（text substring match + kind/status filter），而非 PersistentStore 的 raw tool result 归档。Export/import 作为 `/context export` 和 `/context import <path>` slash commands 实现，操作对象是 durable claims 的 JSON 快照。

**技术栈：** TypeScript, node:test, existing ClaimStore/ToolRegistry/slash-commands infrastructure.

**前置条件：** Phase 4A（project rules + budget cap）✅

---

## Scope

### 本计划包含

- Recall tool 重写：搜索 claim store 中的 claims（text match + filter by kind/status）
- Recall tool 注册到 main.tsx 的 tool registry
- `/context export` → 导出 durable claims 为 JSON 文件（`~/.rivet/exports/<timestamp>.json`）
- `/context import <path>` → 从 JSON 文件导入 claims（confidence decay 0.8x）
- 删除 `PersistentStore` 死代码（recall 不再使用它）

### 本计划不包含

- FTS5/SQLite 后端
- Vector recall / sqlite-vec
- 远程 sync / cloud storage
- Retrieval eval（属于后续优化）

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/context/claim-export.ts` | Export/import durable claims 为 JSON |
| `src/context/__tests__/claim-export.test.ts` | Export/import 测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/tools/recall.ts` | 重写：搜索 claim store 而非 PersistentStore |
| `src/tools/__tests__/recall.test.ts` | 新建：recall tool 测试 |
| `src/main.tsx` | 注册 recall tool |
| `src/tui/slash-commands.ts` | 增加 `/context export` 和 `/context import` |

### 删除文件

| 文件 | 原因 |
|------|------|
| `src/context/persistent-store.ts` | Recall 不再使用，无其他消费者 |

---

## 任务 1：Recall tool 重写

**文件：**
- 修改：`src/tools/recall.ts`
- 创建：`src/tools/__tests__/recall.test.ts`

- [ ] **步骤 1：编写失败测试**

创建 `src/tools/__tests__/recall.test.ts`：

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRecallTool } from '../recall.js'
import { ContextClaimStore } from '../../context/claim-store.js'
import type { ClaimProposal } from '../../context/claims.js'

function proposal(text: string, kind: ClaimProposal['kind'] = 'file_observation'): ClaimProposal {
  return {
    kind,
    scope: 'session',
    text,
    confidence: 0.8,
    fitness: 4,
    source: { actor: 'tool', sessionId: 'test', turn: 1, eventId: `e:${text.slice(0, 8)}` },
    evidence: [{ id: `ev:${text.slice(0, 8)}`, kind: 'tool_result', summary: text, createdAt: Date.now() }],
    createdAt: Date.now(),
    tags: ['test'],
  }
}

describe('recall tool', () => {
  it('searches claims by text keyword', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-recall-'))
    try {
      const store = new ContextClaimStore(dir, 'session-1')
      store.propose(proposal('config uses port 3000'))
      store.propose(proposal('database connection string'))

      const tool = createRecallTool(store)
      const result = await tool.execute({ toolUseId: 't1', input: { query: 'port' } })

      assert.ok(result.content.includes('port 3000'))
      assert.ok(!result.content.includes('database'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('filters by kind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-recall-'))
    try {
      const store = new ContextClaimStore(dir, 'session-1')
      store.propose(proposal('test passed', 'verification_fact'))
      store.propose(proposal('test also passed', 'file_observation'))

      const tool = createRecallTool(store)
      const result = await tool.execute({ toolUseId: 't1', input: { query: 'test', kind: 'verification_fact' } })

      assert.ok(result.content.includes('test passed'))
      assert.ok(!result.content.includes('also passed'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns message when no results found', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-recall-'))
    try {
      const store = new ContextClaimStore(dir, 'session-1')
      const tool = createRecallTool(store)
      const result = await tool.execute({ toolUseId: 't1', input: { query: 'nonexistent' } })

      assert.ok(result.content.includes('No claims found'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('respects limit parameter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-recall-'))
    try {
      const store = new ContextClaimStore(dir, 'session-1')
      for (let i = 0; i < 10; i++) {
        store.propose(proposal(`observation number ${i}`))
      }

      const tool = createRecallTool(store)
      const result = await tool.execute({ toolUseId: 't1', input: { query: 'observation', limit: 3 } })

      const matches = result.content.split('[claim:').length - 1
      assert.equal(matches, 3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- src/tools/__tests__/recall.test.ts`
预期：FAIL（recall 仍依赖 PersistentStore）

- [ ] **步骤 3：重写 recall.ts**

重写 `src/tools/recall.ts`：

```ts
import type { Tool, ToolCallParams, ToolResult } from './types.js'
import type { ContextClaimStore } from '../context/claim-store.js'
import type { ContextClaimKind } from '../context/claims.js'
import type { ToolDefinition } from '../api/types.js'

interface RecallInput {
  query: string
  kind?: ContextClaimKind
  limit?: number
}

const DEFINITION: ToolDefinition = {
  name: 'recall',
  description: 'Search historical claims in context memory by keyword. Returns matching claims with their status, kind, and evidence.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search keyword (substring match on claim text)' },
      kind: { type: 'string', enum: ['user_constraint', 'user_preference', 'decision', 'file_observation', 'verification_fact', 'failure_pattern', 'security_finding', 'worker_finding', 'project_rule'], description: 'Filter by claim kind' },
      limit: { type: 'number', default: 5, description: 'Max results to return' },
    },
    required: ['query'],
  },
}

export function createRecallTool(store: ContextClaimStore): Tool {
  return {
    definition: DEFINITION,
    async execute(params: ToolCallParams): Promise<ToolResult> {
      const input = params.input as unknown as RecallInput
      const limit = input.limit ?? 5
      const filter = input.kind ? { kind: [input.kind] } : {}

      const matches = store.listClaims(filter)
        .filter(c => c.text.toLowerCase().includes(input.query.toLowerCase()))
        .sort((a, b) => b.fitness - a.fitness || b.confidence - a.confidence)
        .slice(0, limit)

      if (matches.length === 0) {
        return { content: 'No claims found matching query.' }
      }

      const formatted = matches.map(c =>
        `[claim:${c.id.slice(0, 8)}] (${c.kind}, ${c.status}, confidence=${c.confidence.toFixed(2)})\n  ${c.text.slice(0, 200)}`
      ).join('\n')

      return { content: `Found ${matches.length} claim(s):\n${formatted}` }
    },
    requiresApproval(): boolean { return false },
    isConcurrencySafe(): boolean { return true },
    isEnabled(): boolean { return true },
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test -- src/tools/__tests__/recall.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/tools/recall.ts src/tools/__tests__/recall.test.ts
git commit -m "feat(tools): rewrite recall tool to search claim store by keyword"
```

---

## 任务 2：注册 recall tool 到 main.tsx

**文件：**
- 修改：`src/main.tsx`

- [ ] **步骤 1：在 tool registry 初始化处注册 recall**

在 `src/main.tsx` 中，找到 tool registry 初始化（`new ToolRegistry(...)` 或 `registry.register(...)` 附近），添加：

```ts
import { createRecallTool } from './tools/recall.js'
```

在 claimStore 初始化之后、agent 创建之前，注册 recall tool：

```ts
toolRegistry.register(createRecallTool(claimStore))
```

- [ ] **步骤 2：运行 typecheck**

运行：`npx tsc --noEmit`
预期：无错误

- [ ] **步骤 3：运行全部测试**

运行：`npm test`
预期：全部通过

- [ ] **步骤 4：Commit**

```bash
git add src/main.tsx
git commit -m "feat(tools): register recall tool in main app"
```

---

## 任务 3：Claim export/import

**文件：**
- 创建：`src/context/claim-export.ts`
- 创建：`src/context/__tests__/claim-export.test.ts`

- [ ] **步骤 1：编写失败测试**

创建 `src/context/__tests__/claim-export.test.ts`：

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportDurableClaims, importClaims } from '../claim-export.js'
import { ContextClaimStore } from '../claim-store.js'
import type { ClaimProposal } from '../claims.js'

function proposal(text: string): ClaimProposal {
  return {
    kind: 'user_constraint',
    scope: 'session',
    text,
    confidence: 0.9,
    fitness: 5,
    source: { actor: 'user', sessionId: 'test', turn: 1, eventId: `e:${text.slice(0, 8)}` },
    evidence: [{ id: `ev:${text.slice(0, 8)}`, kind: 'user_input', summary: text, createdAt: Date.now() }],
    createdAt: Date.now(),
    tags: ['test'],
  }
}

describe('claim export/import', () => {
  it('exports durable claims to JSON file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-export-'))
    try {
      const store = new ContextClaimStore(dir, 'session-1')
      const claim = store.propose(proposal('Never force push'))
      store.updateClaimStatus(claim.id, 'durable', 'user confirmed')

      const outPath = join(dir, 'export.json')
      const count = exportDurableClaims(store, outPath)

      assert.equal(count, 1)
      assert.ok(existsSync(outPath))

      const data = JSON.parse(readFileSync(outPath, 'utf-8'))
      assert.equal(data.claims.length, 1)
      assert.equal(data.claims[0].text, 'Never force push')
      assert.equal(data.version, 1)
      assert.ok(data.exportedAt)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not export non-durable claims', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-export-'))
    try {
      const store = new ContextClaimStore(dir, 'session-1')
      store.propose(proposal('Active only claim'))

      const outPath = join(dir, 'export.json')
      const count = exportDurableClaims(store, outPath)

      assert.equal(count, 0)
      const data = JSON.parse(readFileSync(outPath, 'utf-8'))
      assert.deepEqual(data.claims, [])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('imports claims with confidence decay', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-import-'))
    try {
      const sourceStore = new ContextClaimStore(dir, 'source')
      const claim = sourceStore.propose(proposal('Important rule'))
      sourceStore.updateClaimStatus(claim.id, 'durable', 'confirmed')

      const exportPath = join(dir, 'export.json')
      exportDurableClaims(sourceStore, exportPath)

      const targetStore = new ContextClaimStore(dir, 'target')
      const imported = importClaims(targetStore, exportPath)

      assert.equal(imported, 1)
      const claims = targetStore.listClaims()
      assert.equal(claims.length, 1)
      assert.equal(claims[0]!.text, 'Important rule')
      assert.ok(claims[0]!.confidence <= 0.9 * 0.8 + 0.01) // 0.8x decay
      assert.ok(claims[0]!.tags.includes('imported'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips import if file does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-import-'))
    try {
      const store = new ContextClaimStore(dir, 'session-1')
      const imported = importClaims(store, '/nonexistent/path.json')
      assert.equal(imported, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- src/context/__tests__/claim-export.test.ts`
预期：FAIL（模块不存在）

- [ ] **步骤 3：实现 claim-export.ts**

创建 `src/context/claim-export.ts`：

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ContextClaimStore } from './claim-store.js'
import type { ContextClaim } from './claims.js'

export interface ClaimExportData {
  version: 1
  exportedAt: string
  claims: ContextClaim[]
}

export function exportDurableClaims(store: ContextClaimStore, outPath: string): number {
  const durable = store.listClaims({ status: ['durable', 'durable_candidate'] })
  const data: ClaimExportData = {
    version: 1,
    exportedAt: new Date().toISOString(),
    claims: durable,
  }

  const dir = dirname(outPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf-8')
  return durable.length
}

export function importClaims(store: ContextClaimStore, filePath: string): number {
  if (!existsSync(filePath)) return 0

  const raw = readFileSync(filePath, 'utf-8')
  const data = JSON.parse(raw) as ClaimExportData
  if (data.version !== 1 || !Array.isArray(data.claims)) return 0

  let imported = 0
  for (const claim of data.claims) {
    store.propose({
      kind: claim.kind,
      scope: claim.scope,
      text: claim.text,
      confidence: claim.confidence * 0.8,
      fitness: claim.fitness,
      source: { ...claim.source, eventId: `import:${claim.id}` },
      evidence: claim.evidence,
      createdAt: Date.now(),
      tags: [...(claim.tags ?? []), 'imported'],
    })
    imported++
  }
  return imported
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test -- src/context/__tests__/claim-export.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/context/claim-export.ts src/context/__tests__/claim-export.test.ts
git commit -m "feat(context): claim export/import with confidence decay"
```

---

## 任务 4：Slash commands — /context export + /context import

**文件：**
- 修改：`src/tui/slash-commands.ts`

- [ ] **步骤 1：添加 export 和 import handlers**

在 `src/tui/slash-commands.ts` 中，在 `/context` args 处理的 switch 里，添加：

```ts
import { exportDurableClaims, importClaims } from '../context/claim-export.js'
import { join } from 'node:path'
import { homedir } from 'node:os'
```

```ts
if (args === 'export') {
  const store = ctx.claimStoreRef.current
  if (!store) {
    pushStatic(createLogEntry({ type: 'text', content: 'Claim store not available.' }))
    setIsStreaming(false)
    return true
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outPath = join(homedir(), '.rivet', 'exports', `${timestamp}.json`)
  const count = exportDurableClaims(store, outPath)
  pushStatic(createLogEntry({ type: 'text', content: `Exported ${count} durable claims to ${outPath}` }))
  setIsStreaming(false)
  return true
}

if (args.startsWith('import ')) {
  const store = ctx.claimStoreRef.current
  if (!store) {
    pushStatic(createLogEntry({ type: 'text', content: 'Claim store not available.' }))
    setIsStreaming(false)
    return true
  }
  const filePath = args.slice('import '.length).trim()
  const count = importClaims(store, filePath)
  pushStatic(createLogEntry({ type: 'text', content: count > 0 ? `Imported ${count} claims (confidence ×0.8)` : `No claims imported. Check file path: ${filePath}` }))
  setIsStreaming(false)
  return true
}
```

- [ ] **步骤 2：运行 typecheck**

运行：`npx tsc --noEmit`
预期：无错误

- [ ] **步骤 3：运行全部测试**

运行：`npm test`
预期：全部通过

- [ ] **步骤 4：Commit**

```bash
git add src/tui/slash-commands.ts
git commit -m "feat(tui): /context export and /context import slash commands"
```

---

## 任务 5：删除 PersistentStore 死代码

**文件：**
- 删除：`src/context/persistent-store.ts`

- [ ] **步骤 1：确认无其他引用**

运行：`grep -rn "persistent-store\|PersistentStore" src/ --include="*.ts" --include="*.tsx" | grep -v __tests__ | grep -v recall`

预期：无输出（recall 已重写，不再引用）

- [ ] **步骤 2：删除文件**

```bash
rm src/context/persistent-store.ts
```

- [ ] **步骤 3：运行 typecheck + tests**

运行：`npx tsc --noEmit && npm test`
预期：全部通过

- [ ] **步骤 4：Commit**

```bash
git add -A
git commit -m "chore: remove dead PersistentStore code (recall now uses claim store)"
```

---

## 验收标准

| 标准 | 验证方法 |
|------|---------|
| `recall` tool 搜索 claim store 中的 claims | recall.test.ts: keyword match → correct results |
| `recall` tool 注册在 main.tsx 中 | typecheck 通过 + agent 可调用 |
| `/context export` 导出 durable claims 为 JSON | 手动验证：文件生成在 `~/.rivet/exports/` |
| `/context import <path>` 导入 claims（0.8x decay） | claim-export.test.ts: import → confidence decayed |
| 导入的 claims 带 `imported` tag | 测试验证 |
| PersistentStore 已删除 | `grep` 无引用 + typecheck 通过 |
| 所有测试通过 | `npm test`: 860+ pass, 0 fail |

---

## 风险与防线

| 风险 | 应对 |
|------|------|
| Recall 搜索 O(n) 全量 claims | Phase 4B scope 内 claims < 200，substring match 足够；FTS5 延后 |
| Export 文件含敏感 claim 内容 | 用户主动触发 export，文件存本地 ~/.rivet/exports/ |
| Import 重复导入同一文件 | propose() 的 dedup 防止同 ID claim 重复 |
| Import JSON 格式不兼容 | version 字段 + 格式校验，不匹配则返回 0 |
