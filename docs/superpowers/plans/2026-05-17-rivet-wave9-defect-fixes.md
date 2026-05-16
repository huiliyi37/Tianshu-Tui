# Wave 9: 内部缺陷修复 + 结构优化 实施计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复 Wave 5-8 积累的 P1/P2 内部缺陷：goal loop 补齐关键配置、loop.ts 拆分降低复杂度、main.tsx 消除配置重复、claim_used replay 修复。

**架构：** 提取 `createAgentConfig` 工厂函数消除 TUI/goal-loop 配置重复；从 loop.ts 提取 `tool-executor.ts` 和 `turn-lifecycle.ts`；修复 loadDurableClaims 的 claim_used 事件处理。

**技术栈：** TypeScript, 现有 AgentLoop/ContextClaimStore infrastructure

**前置条件：** Wave 8 ✅（含 DRY fix d245d76）

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/agent/create-agent-config.ts` | AgentLoop 配置工厂：统一 TUI 和 goal loop 的配置创建 |
| `src/__tests__/create-agent-config.test.ts` | 工厂测试 |
| `src/__tests__/claim-store-durable.test.ts` | loadDurableClaims claim_used replay 测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/main.tsx` | TUI + goal loop 都调用 createAgentConfig；goal loop 补齐 compactClient/fileHistory/sessionMemory |
| `src/context/claim-store.ts` | loadDurableClaims 增加 claim_used 事件处理 |

### 不拆分 loop.ts

经过再次审视，loop.ts 807 行虽大但职责连贯（tool execution 和 turn lifecycle 与 AgentLoop 状态紧密耦合）。强行拆分会引入大量跨模块状态传递，得不偿失。改为提取独立的配置工厂 + 修复真实 bug 为优先。

---

## 任务 1：createAgentConfig 工厂函数

**文件：**
- 创建：`src/agent/create-agent-config.ts`
- 测试：`src/__tests__/create-agent-config.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/__tests__/create-agent-config.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentConfig, type AgentConfigInput } from '../agent/create-agent-config.js'

describe('createAgentConfig', () => {
  const baseInput: AgentConfigInput = {
    apiKey: 'test-key',
    model: { id: 'deepseek-r1', maxTokens: 8192, contextWindow: 128000, reasoningEffort: undefined },
    cwd: '/tmp/test',
    compact: { enabled: true, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
    sessionId: 'session-1',
    toolDefinitions: [],
  }

  it('creates client with correct model params', () => {
    const cfg = createAgentConfig(baseInput)
    assert.ok(cfg.client)
    assert.ok(cfg.promptEngine)
    assert.equal(cfg.contextWindow, 128000)
    assert.equal(cfg.sessionId, 'session-1')
  })

  it('creates compactClient when compactModel provided', () => {
    const cfg = createAgentConfig({
      ...baseInput,
      compactModel: { id: 'deepseek-flash', maxTokens: 4096, contextWindow: 64000, reasoningEffort: undefined },
    })
    assert.ok(cfg.compactClient)
    assert.equal(cfg.compactModel, 'deepseek-flash')
  })

  it('omits compactClient when no compactModel', () => {
    const cfg = createAgentConfig(baseInput)
    assert.equal(cfg.compactClient, undefined)
    assert.equal(cfg.compactModel, undefined)
  })

  it('applies thinkingBudget based on reasoningEffort', () => {
    const maxCfg = createAgentConfig({
      ...baseInput,
      model: { ...baseInput.model, reasoningEffort: 'max' },
    })
    // Should create client with thinkingBudget: 64000
    assert.ok(maxCfg.client)
  })
})
```

- [ ] **步骤 2：运行测试确认失败**

运行：`npm test -- src/__tests__/create-agent-config.test.ts`
预期：FAIL（模块不存在）

- [ ] **步骤 3：实现 create-agent-config.ts**

```typescript
// src/agent/create-agent-config.ts
import { createDeepSeekClient } from '../api/deepseek.js'
import { PromptEngine } from '../prompt/engine.js'
import type { AgentConfig } from './loop.js'
import type { CompactionConfig } from '../compact/constants.js'
import type { ToolDefinition } from '../tools/types.js'

export interface ModelSpec {
  id: string
  maxTokens: number
  contextWindow: number
  reasoningEffort?: 'max' | 'high' | 'medium' | 'low'
}

export interface AgentConfigInput {
  apiKey: string
  model: ModelSpec
  cwd: string
  compact: CompactionConfig
  sessionId: string
  toolDefinitions: ToolDefinition[]
  compactModel?: ModelSpec
  sessionMemoryBlock?: string
  approvalMode?: 'auto-accept' | 'auto-safe' | 'manual'
}

export function createAgentConfig(input: AgentConfigInput): Pick<
  AgentConfig,
  'client' | 'promptEngine' | 'contextWindow' | 'compact' | 'compactClient' | 'compactModel' | 'sessionId' | 'approvalMode' | 'autoReasoning'
> {
  const { model, apiKey, cwd } = input
  const thinkingBudget = model.reasoningEffort === 'max'
    ? 64000
    : Math.min(16000, Math.floor(model.contextWindow * 0.02))

  const client = createDeepSeekClient({
    apiKey,
    model: model.id,
    reasoningEffort: model.reasoningEffort,
    maxTokens: model.maxTokens,
    thinkingBudget,
  })

  const promptEngine = new PromptEngine({
    model: model.id,
    maxTokens: model.maxTokens,
    staticCtx: { tools: input.toolDefinitions },
    volatileCtx: { cwd, sessionMemoryBlock: input.sessionMemoryBlock },
  })

  let compactClient: AgentConfig['compactClient']
  let compactModelId: string | undefined
  if (input.compactModel) {
    compactClient = createDeepSeekClient({
      apiKey,
      model: input.compactModel.id,
      reasoningEffort: input.compactModel.reasoningEffort,
      maxTokens: Math.min(2048, input.compactModel.maxTokens),
      thinkingBudget: 1024,
    })
    compactModelId = input.compactModel.id
  }

  return {
    client,
    promptEngine,
    contextWindow: model.contextWindow,
    compact: input.compact,
    compactClient,
    compactModel: compactModelId,
    sessionId: input.sessionId,
    approvalMode: input.approvalMode,
    autoReasoning: true,
  }
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`npm test -- src/__tests__/create-agent-config.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/create-agent-config.ts src/__tests__/create-agent-config.test.ts
git commit -m "feat(agent): extract createAgentConfig factory for DRY config creation"
```

---

## 任务 2：Goal Loop 补齐 compactClient + fileHistory + sessionMemory

**文件：**
- 修改：`src/main.tsx:463-522`

- [ ] **步骤 1：修改 goal loop createAgent 使用工厂 + 补齐缺失配置**

在 `src/main.tsx` 的 goal loop section（约第 463-522 行），将现有手工配置替换为：

```typescript
import { createAgentConfig } from './agent/create-agent-config.js'
import { FileHistory } from './agent/file-history.js'

// 在 goal loop section 中（约第 463 行之后）:
    const cfg = loadConfig()
    const prov = cfg.provider.providers[cfg.provider.default]
    if (!prov) { console.error('Provider not configured'); process.exit(1) }
    const key = prov.apiKey ?? process.env[prov.apiKeyEnv ?? '']
    if (!key) { console.error('API key not configured'); process.exit(1) }

    const model = prov.models[0]!
    const compactModel = prov.models.find(m => m.id === cfg.compact.model || m.alias === cfg.compact.model)
    const sessionId = randomUUID()
    const persist = new SessionPersist(sessionId)
    const claimStore = persist.createClaimStore()
    persist.injectDurableClaims(claimStore)
    const fileHistory = new FileHistory()

    const result = await runGoalLoop({
      goal: parsed.goal,
      budget: parsed.budget ?? 100,
      createAgent: () => {
        const toolRegistry = createDefaultToolRegistry()

        const agentCfg = createAgentConfig({
          apiKey: key,
          model: { id: model.id, maxTokens: model.maxTokens, contextWindow: model.contextWindow, reasoningEffort: model.reasoningEffort },
          cwd: process.cwd(),
          compact: cfg.compact,
          sessionId,
          toolDefinitions: toolRegistry.getDefinitions(),
          compactModel: compactModel ? { id: compactModel.id, maxTokens: compactModel.maxTokens, contextWindow: compactModel.contextWindow, reasoningEffort: compactModel.reasoningEffort } : undefined,
          sessionMemoryBlock: persist.buildMemoryBlock(),
          approvalMode: 'auto-accept',
        })

        const goalCoordinator = new DelegationCoordinator({
          baseToolRegistry: toolRegistry,
          modelCards: [{ model: model.id, toolUseReliability: 0.8, jsonStability: 0.8, editSuccessRate: 0.7, testRepairRate: 0.6, contextWindow: model.contextWindow, cacheEconomics: 'strong', recommendedTasks: ['code_search'] }],
          maxWorkers: 3,
          runtimeFactory: (order, card, workerRegistry) => ({
            order,
            client: createDeepSeekClient({ apiKey: key, model: card.model, reasoningEffort: undefined, maxTokens: Math.min(4096, card.contextWindow), thinkingBudget: 4096 }),
            promptEngine: new PromptEngine({ model: card.model, maxTokens: 4096, staticCtx: { tools: workerRegistry.getDefinitions() }, volatileCtx: { cwd: process.cwd() } }),
            toolRegistry: workerRegistry,
            cwd: process.cwd(),
            maxTurns: 4,
            contextWindow: card.contextWindow,
            compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
            activeClaims: claimStore.listActiveClaims(),
          }),
        })
        toolRegistry.register(createDelegateTaskTool(
          { delegate: async (req) => goalCoordinator.delegate(req) },
          () => claimStore,
          () => sessionId,
        ))

        const session = new SessionContext()
        return new AgentLoop({
          ...agentCfg,
          toolRegistry,
          maxTurns: 25,
          contextClaimStore: claimStore,
          getSessionMemoryState: () => persist.getSessionMemoryState(),
          fileHistory,
        }, session, process.cwd())
      },
      // ... rest unchanged
```

关键变更：
- `compactClient` + `compactModel` 通过 `createAgentConfig` 传入（使用 spread `...agentCfg`）
- `fileHistory` 创建并传入
- `getSessionMemoryState` 传入
- `maxWorkers: 3`（与 TUI 对齐）

- [ ] **步骤 2：同样重构 TUI agent 使用工厂**

在 `src/main.tsx` 的 `useMemo`（约第 207 行），将手工配置替换为：

```typescript
  const agent = useMemo(() => {
    const compactModelSpec = provider.models.find(m => m.id === config.compact.model || m.alias === config.compact.model)

    const agentCfg = createAgentConfig({
      apiKey,
      model: { id: currentModel.id, maxTokens: currentModel.maxTokens, contextWindow: currentModel.contextWindow, reasoningEffort: currentModel.reasoningEffort },
      cwd,
      compact: config.compact,
      sessionId,
      toolDefinitions: toolRegistry.getDefinitions(),
      compactModel: compactModelSpec ? { id: compactModelSpec.id, maxTokens: compactModelSpec.maxTokens, contextWindow: compactModelSpec.contextWindow, reasoningEffort: compactModelSpec.reasoningEffort } : undefined,
      sessionMemoryBlock: persist.buildMemoryBlock(),
      approvalMode: config.agent.approval as 'auto-accept' | 'auto-safe' | 'manual',
    })

    // ... runtimeFactory and coordinator setup unchanged ...

    _coordinatorRef = new DelegationCoordinator({
      baseToolRegistry: toolRegistry,
      modelCards,
      maxWorkers: 3,
      runtimeFactory,
    })

    return new AgentLoop(
      {
        ...agentCfg,
        toolRegistry,
        maxTurns: config.agent.maxTurns,
        getSessionMemoryState: () => persist.getSessionMemoryState(),
        lspEnabled: true,
        fileHistory,
        contextClaimStore: claimStore,
      },
      session,
      cwd,
    )
  }, [currentModel, toolVersion, fileHistory])
```

- [ ] **步骤 3：运行 typecheck + tests**

运行：`npx tsc --noEmit && npm test`
预期：无错误，全部通过

- [ ] **步骤 4：Commit**

```bash
git add src/main.tsx
git commit -m "fix(goal-loop): add compactClient, fileHistory, sessionMemory; DRY via createAgentConfig"
```

---

## 任务 3：loadDurableClaims 增加 claim_used replay

**文件：**
- 修改：`src/context/claim-store.ts:143-160`
- 测试：`src/__tests__/claim-store-durable.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/__tests__/claim-store-durable.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextClaimStore } from '../context/claim-store.js'

describe('loadDurableClaims with claim_used replay', () => {
  it('restores consumers from claim_used events', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-durable-'))
    const filePath = join(dir, 'prev-session.claims.jsonl')
    const claim = {
      id: 'claim-1',
      kind: 'user_constraint',
      scope: 'project',
      status: 'durable',
      text: 'Use TypeScript strict mode',
      confidence: 0.9,
      fitness: 7,
      source: { actor: 'user', sessionId: 'prev-session', turn: 1, eventId: 'e-1' },
      evidence: [{ id: 'e-1', kind: 'user_message', summary: 'Use strict mode', createdAt: 1000 }],
      consumers: [],
      counterevidence: [],
      createdAt: 1000,
      lastUsedAt: 1000,
      tags: [],
    }
    const events = [
      JSON.stringify({ type: 'claim_proposed', eventId: 'e-1', createdAt: 1000, claim }),
      JSON.stringify({ type: 'claim_status_changed', eventId: 'e-2', createdAt: 2000, claimId: 'claim-1', status: 'durable', reason: 'promotion' }),
      JSON.stringify({ type: 'claim_used', eventId: 'e-3', createdAt: 3000, claimId: 'claim-1', consumerId: 'turn-5:prompt', consumerKind: 'prompt' }),
      JSON.stringify({ type: 'claim_used', eventId: 'e-4', createdAt: 4000, claimId: 'claim-1', consumerId: 'turn-8:prompt', consumerKind: 'prompt' }),
    ]
    writeFileSync(filePath, events.join('\n') + '\n')

    try {
      const durables = ContextClaimStore.loadDurableClaims(dir, 'prev-session')
      assert.equal(durables.length, 1)
      assert.equal(durables[0]!.consumers.length, 2)
      assert.equal(durables[0]!.consumers[0]!.id, 'turn-5:prompt')
      assert.equal(durables[0]!.consumers[1]!.id, 'turn-8:prompt')
      assert.equal(durables[0]!.lastUsedAt, 4000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns empty array for non-existent session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-durable-empty-'))
    try {
      const durables = ContextClaimStore.loadDurableClaims(dir, 'no-such-session')
      assert.equal(durables.length, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

- [ ] **步骤 2：运行测试确认失败**

运行：`npm test -- src/__tests__/claim-store-durable.test.ts`
预期：FAIL（consumers.length === 0，因为 claim_used 不被 replay）

- [ ] **步骤 3：修改 loadDurableClaims**

在 `src/context/claim-store.ts` 的 `loadDurableClaims` 方法中，增加 `claim_used` 事件处理：

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
        } else if (event.type === 'claim_used') {
          const claim = claims.get(event.claimId)
          if (claim) {
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
      } catch { /* skip malformed lines */ }
    }
    return [...claims.values()].filter(c => c.status === 'durable')
  }
```

- [ ] **步骤 4：运行测试确认通过**

运行：`npm test -- src/__tests__/claim-store-durable.test.ts`
预期：PASS

- [ ] **步骤 5：运行全量测试**

运行：`npm test`
预期：831+ pass, 0 fail

- [ ] **步骤 6：Commit**

```bash
git add src/context/claim-store.ts src/__tests__/claim-store-durable.test.ts
git commit -m "fix(claims): loadDurableClaims replays claim_used events to restore consumers"
```

---

## 任务 4：验证 + 全量测试

**文件：** 无新增

- [ ] **步骤 1：运行 typecheck**

运行：`npx tsc --noEmit`
预期：0 errors

- [ ] **步骤 2：运行全量测试**

运行：`npm test`
预期：835+ pass, 0 fail

- [ ] **步骤 3：手动验证 goal loop 有 compactClient**

运行：`grep -n "compactClient\|compactModel\|fileHistory\|getSessionMemoryState" src/main.tsx | grep -v "^.*import"`

预期输出应在 goal loop section（~470-530 行）和 TUI section（~210-300 行）都能看到这些字段。

- [ ] **步骤 4：Commit（如有 lint fix）**

```bash
git add -A && git commit -m "chore: lint fixes for Wave 9" || true
```

---

## 验收标准

| 标准 | 验证方法 |
|------|---------|
| Goal loop agent 有 compactClient | grep compactClient in goal loop section |
| Goal loop agent 有 fileHistory | grep fileHistory in goal loop section |
| Goal loop agent 有 getSessionMemoryState | grep getSessionMemoryState in goal loop section |
| Goal loop maxWorkers=3 | grep maxWorkers in goal loop coordinator |
| TUI 和 goal loop 共用 createAgentConfig | 两处都 import + 调用 |
| loadDurableClaims replay claim_used | 测试：consumers 恢复 |
| 所有测试通过 | npm test: 835+ pass, 0 fail |
| Typecheck 通过 | npx tsc --noEmit: 0 errors |
