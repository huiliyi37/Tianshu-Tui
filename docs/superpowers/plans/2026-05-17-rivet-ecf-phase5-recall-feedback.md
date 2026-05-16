# ECF Phase 5: Recall 正反馈 + Claim 质量信号 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** recall tool 返回 claims 后记录 consumer + boost fitness，形成正反馈循环加速 claim 晋升。

**架构：** 在 claim-store 新增 `boostFitness()` 方法；recall tool 在返回结果后对每个匹配 claim 调用 `recordClaimUsed()` + `boostFitness()`。

**技术栈：** TypeScript, node:test, existing ClaimStore/recall infrastructure.

**前置条件：** Phase 4B（recall tool + export/import）✅

---

## Scope

### 本计划包含

- `ContextClaimStore.boostFitness(id, delta, cap)` 方法
- Recall tool 返回结果后记录 consumer + boost fitness
- 测试覆盖：consumer 记录、fitness boost、cap 限制、promotion 触发

### 本计划不包含

- Prompt projection 算法变更
- 新的 TUI 命令
- Recall 搜索算法优化

---

## 文件结构

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/context/claim-store.ts` | 新增 `boostFitness()` 方法 |
| `src/tools/recall.ts` | 返回结果后调用 `recordClaimUsed()` + `boostFitness()` |
| `src/tools/__tests__/recall.test.ts` | 新增 consumer + fitness 测试 |
| `src/context/__tests__/claim-store.test.ts` | 新增 `boostFitness()` 测试 |

---

## 任务 1：ClaimStore.boostFitness 方法

**文件：**
- 修改：`src/context/claim-store.ts`
- 修改：`src/context/__tests__/claim-store.test.ts`

- [ ] **步骤 1：编写失败测试**

在 `src/context/__tests__/claim-store.test.ts` 末尾追加：

```ts
describe('boostFitness', () => {
  it('increases fitness by delta', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-boost-'))
    try {
      const store = new ContextClaimStore(dir, 'session-1')
      const claim = store.propose({
        kind: 'file_observation',
        scope: 'session',
        text: 'config uses port 3000',
        confidence: 0.7,
        fitness: 3,
        source: { actor: 'tool', sessionId: 'session-1', turn: 1, eventId: 'e1' },
        evidence: [{ id: 'ev1', kind: 'tool_result', summary: 'x', createdAt: Date.now() }],
        createdAt: Date.now(),
        tags: ['test'],
      })

      const updated = store.boostFitness(claim.id, 2, 10)

      assert.equal(updated!.fitness, 5)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('caps fitness at max value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-boost-'))
    try {
      const store = new ContextClaimStore(dir, 'session-1')
      const claim = store.propose({
        kind: 'file_observation',
        scope: 'session',
        text: 'high fitness claim',
        confidence: 0.7,
        fitness: 9,
        source: { actor: 'tool', sessionId: 'session-1', turn: 1, eventId: 'e2' },
        evidence: [{ id: 'ev2', kind: 'tool_result', summary: 'x', createdAt: Date.now() }],
        createdAt: Date.now(),
        tags: ['test'],
      })

      const updated = store.boostFitness(claim.id, 5, 10)

      assert.equal(updated!.fitness, 10)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns null for nonexistent claim', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-boost-'))
    try {
      const store = new ContextClaimStore(dir, 'session-1')
      const result = store.boostFitness('nonexistent', 1, 10)
      assert.equal(result, null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- src/context/__tests__/claim-store.test.ts`
预期：FAIL（`boostFitness` 不存在）

- [ ] **步骤 3：实现 boostFitness**

在 `src/context/claim-store.ts` 的 `ContextClaimStore` 类中，在 `recordClaimUsed` 方法之后添加：

```ts
  boostFitness(id: string, delta: number, cap: number): ContextClaim | null {
    const claim = this.listClaims().find(c => c.id === id)
    if (!claim) return null
    claim.fitness = Math.min(claim.fitness + delta, cap)
    this.appendEvent({ type: 'claim_boosted', claimId: id, fitness: claim.fitness, timestamp: Date.now() })
    return claim
  }
```

同时在 `ClaimEvent` 类型联合中添加新事件类型（如果需要）。如果 `ClaimEvent` 不支持 `claim_boosted`，在 `appendEvent` 中直接写入 JSON 即可（JSONL 格式兼容任意事件类型）。

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test -- src/context/__tests__/claim-store.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/context/claim-store.ts src/context/__tests__/claim-store.test.ts
git commit -m "feat(context): add boostFitness method to ClaimStore"
```

---

## 任务 2：Recall tool 记录 consumer + boost fitness

**文件：**
- 修改：`src/tools/recall.ts`
- 修改：`src/tools/__tests__/recall.test.ts`

- [ ] **步骤 1：编写失败测试**

在 `src/tools/__tests__/recall.test.ts` 追加：

```ts
  it('records consumer on matched claims', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-recall-'))
    try {
      const store = new ContextClaimStore(dir, 'session-1')
      store.propose(proposal('config uses port 3000'))

      const tool = createRecallTool(store, { sessionId: 'session-1', getTurn: () => 5 })
      await tool.execute({ toolUseId: 't1', input: { query: 'port' } })

      const claims = store.listClaims()
      assert.ok(claims[0]!.consumers.length >= 1)
      assert.ok(claims[0]!.consumers.some(c => c.id.includes('recall')))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('boosts fitness on matched claims (capped at 10)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-recall-'))
    try {
      const store = new ContextClaimStore(dir, 'session-1')
      store.propose(proposal('config uses port 3000', 'file_observation'))

      const tool = createRecallTool(store, { sessionId: 'session-1', getTurn: () => 3 })
      await tool.execute({ toolUseId: 't1', input: { query: 'port' } })

      const claims = store.listClaims()
      assert.equal(claims[0]!.fitness, 5) // original 4 + 1 boost
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not boost fitness beyond cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-recall-'))
    try {
      const store = new ContextClaimStore(dir, 'session-1')
      store.propose({
        ...proposal('high fitness claim'),
        fitness: 10,
      })

      const tool = createRecallTool(store, { sessionId: 'session-1', getTurn: () => 1 })
      await tool.execute({ toolUseId: 't1', input: { query: 'high' } })

      const claims = store.listClaims()
      assert.equal(claims[0]!.fitness, 10)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- src/tools/__tests__/recall.test.ts`
预期：FAIL（`createRecallTool` 签名不匹配）

- [ ] **步骤 3：修改 recall.ts 添加 consumer 记录 + fitness boost**

修改 `src/tools/recall.ts`：

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

export interface RecallContext {
  sessionId: string
  getTurn: () => number
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

export function createRecallTool(store: ContextClaimStore, ctx?: RecallContext): Tool {
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

      // Record consumer + boost fitness for matched claims
      if (ctx) {
        const turn = ctx.getTurn()
        const usedAt = Date.now()
        for (const c of matches) {
          store.recordClaimUsed(c.id, { id: `recall:turn-${turn}`, usedAt })
          store.boostFitness(c.id, 1, 10)
        }
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
git commit -m "feat(tools): recall records consumer + boosts fitness on matched claims"
```

---

## 任务 3：更新 main.tsx 传入 RecallContext

**文件：**
- 修改：`src/main.tsx`

- [ ] **步骤 1：修改 recall 注册传入 context**

在 `src/main.tsx` 中找到 `createRecallTool(claimStore)` 调用，改为：

```ts
toolRegistry.register(createRecallTool(claimStore, {
  sessionId,
  getTurn: () => agent?.session?.getTurnCount() ?? 0,
}))
```

注意：`agent` 变量可能在 recall 注册时还不存在。如果是这样，改为使用一个 ref：

```ts
const turnRef = useRef(0)
// ... 在 agent 创建后更新 turnRef
toolRegistry.register(createRecallTool(claimStore, {
  sessionId,
  getTurn: () => turnRef.current,
}))
```

具体实现取决于 `agent` 的生命周期。检查 main.tsx 中 `agent` 的创建时机，选择合适的方式获取 turn count。

- [ ] **步骤 2：运行 typecheck**

运行：`npx tsc --noEmit`
预期：无错误

- [ ] **步骤 3：运行全部测试**

运行：`npm test`
预期：全部通过

- [ ] **步骤 4：Commit**

```bash
git add src/main.tsx
git commit -m "feat(tools): pass RecallContext to recall tool in main app"
```

---

## 验收标准

| 标准 | 验证方法 |
|------|---------|
| Recall 返回结果后 claim 的 consumers 增加 | recall.test.ts: consumer 包含 `recall:turn-N` |
| Recall 命中后 fitness +1 | recall.test.ts: fitness 从 4 变为 5 |
| Fitness 不超过 cap=10 | recall.test.ts + claim-store.test.ts |
| boostFitness 对不存在的 claim 返回 null | claim-store.test.ts |
| main.tsx 传入 RecallContext | typecheck 通过 |
| 所有测试通过 | `npm test`: 890+ pass, 0 fail |

---

## 风险与防线

| 风险 | 应对 |
|------|------|
| Recall 频繁调用导致 fitness 膨胀 | cap=10 硬上限 |
| Consumer 记录导致 JSONL 膨胀 | 每次 recall 最多 5 个 claim × 1 event = 5 行，可接受 |
| RecallContext 的 getTurn 在 agent 未初始化时返回 0 | 使用 ref 或 fallback 为 0，不影响功能 |
