# StarSpine Phase 1：TaskContract + CognitiveLedger 实施计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 建立天枢认知脊柱的最小可行版本 — TaskContract 防漂移锚点 + CognitiveLedger 统一读接口 + Prompt minimal projection。

**架构：** 不替代现有 store（EvidenceTracker/ClaimStore/PlaybookStore/TraceStore），而是在它们之上建立统一查询层。TaskContract 是新增的轻量结构（~30 行 interface），由 AgentLoop 在首轮从用户消息提取。CognitiveLedger 是只读聚合器，为 PromptEngine 和 TUI 提供投影。

**技术栈：** TypeScript strict, node:test + node:assert/strict, ESM

---

## 设计原则

来自三方共识（DeepSeek V4 Pro / GPT 5.5 / Opus 架构评估）：

1. **少写给模型看的上下文，多建设模型之外的认知结构**
2. **Runtime Truth → 按需投影到 Prompt / TUI / Chronicle**
3. **TaskContract 短、硬、可验证 — 不是 plan.md**
4. **渐进演化，不是大重构 — 现有 store 全部保留**
5. **人格点亮系统，不替代系统**

---

## 已有基础（不改动）

| 模块 | 文件 | 状态 |
|------|------|------|
| EvidenceTracker | `src/agent/evidence.ts` (131 行) | 成熟，per-turn，in-memory |
| ClaimStore | `src/context/claim-store.ts` (315 行) | 成熟，event-sourced，persisted |
| PlaybookStore | `src/agent/playbook-store.ts` (101 行) | 成熟，persisted |
| TraceStore | `src/agent/trace-store.ts` (95 行) | 成熟，pure data |
| TaskState | `src/agent/task-state.ts` (29 行) | 轻量 heuristic |
| SessionContext | `src/agent/context.ts` (232 行) | 成熟，in-memory |
| DecisionAnchor | `src/agent/decision-anchor.ts` (13 行) | 最简 regex |

---

## 文件结构

> **实施修正（2026-05-20）：** 采纳架构审查意见后，TaskContract / CognitiveLedger 不放在 `src/agent/`，而放在 `src/context/`，作为 agent runtime、prompt projection、TUI 态势图都可共享的认知中层。PromptEngine 不 import TaskContract 对象，只接收已经渲染好的 minimal projection string，避免 `prompt -> agent` 反向依赖。

| 文件 | 职责 |
|------|------|
| 新建 `src/context/task-contract.ts` | TaskContract interface + 从 user message 提取 contract 的纯函数 + XML-safe projection |
| 新建 `src/context/__tests__/task-contract.test.ts` | TaskContract 提取、XML escape、单调状态推进测试 |
| 新建 `src/context/cognitive-ledger.ts` | CognitiveLedger 纯 read model — 统一查询现有 store 并生成 projection |
| 新建 `src/context/__tests__/cognitive-ledger.test.ts` | Ledger 投影与 phase snapshot 测试 |
| 修改 `src/agent/loop.ts` | 从 userInput 提取 TaskContract，每轮创建 CognitiveLedger，传入 PromptEngine projection |
| 修改 `src/prompt/engine.ts` | 新增 setCognitiveProjection()，minimal projection 替代散射注入，并失效 latest fresh cache |

### 实施偏离原计划的原因

1. **避免 prompt -> agent 反向依赖**：TaskContract 是认知上下文结构，不是 AgentLoop 私有逻辑。
2. **PromptEngine 只接 projection string**：prompt 层不理解 TaskContract lifecycle，只负责拼接最新 turn 动态上下文。
3. **CognitiveLedger 使用 plain object + pure functions**：符合项目“data 不用 class”的约定。
4. **约束提取不用单一大正则**：原正则路径在中文无空格约束与英文多句约束上脆弱，改为 clause split + marker detection。
5. **exploring 阶段仍投影 actionable contract**：探索阶段最容易漂移，不能因 status=exploring 省略锚点；通过 isActionable 过滤闲聊。
6. **projection setter 失效 cachedFreshForUser**：同一 user message 的 tool-call turns 中 contract 状态会变化，必须避免 stale fresh block。

---

### 任务 1：TaskContract 数据结构 + 提取函数

**文件：**
- 新建：`src/agent/task-contract.ts`
- 测试：`src/agent/__tests__/task-contract.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/agent/__tests__/task-contract.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractTaskContract, type TaskContract } from '../task-contract.js'

describe('extractTaskContract', () => {
  it('extracts objective from simple user message', () => {
    const contract = extractTaskContract('fix the auth bug in login.ts')
    assert.equal(contract.objective, 'fix the auth bug in login.ts')
    assert.equal(contract.status, 'exploring')
  })

  it('extracts file scope from message mentioning files', () => {
    const contract = extractTaskContract('refactor src/auth/middleware.ts and src/auth/types.ts to use zod validation')
    assert.ok(contract.scope.mentionedFiles.includes('src/auth/middleware.ts'))
    assert.ok(contract.scope.mentionedFiles.includes('src/auth/types.ts'))
  })

  it('extracts constraints from messages with "don\'t" / "must" / "不要"', () => {
    const contract = extractTaskContract('add rate limiting to the API. Don\'t modify the database schema. Must be backwards compatible.')
    assert.ok(contract.constraints.length >= 2)
    assert.ok(contract.constraints.some(c => c.includes('database schema')))
    assert.ok(contract.constraints.some(c => c.includes('backwards compatible')))
  })

  it('handles Chinese user messages', () => {
    const contract = extractTaskContract('修复 src/api/client.ts 的重试逻辑，不要改接口签名')
    assert.equal(contract.status, 'exploring')
    assert.ok(contract.scope.mentionedFiles.includes('src/api/client.ts'))
    assert.ok(contract.constraints.some(c => c.includes('接口签名')))
  })

  it('truncates long objectives to 200 chars', () => {
    const long = 'x'.repeat(300)
    const contract = extractTaskContract(long)
    assert.ok(contract.objective.length <= 200)
  })

  it('returns empty scope and constraints for minimal messages', () => {
    const contract = extractTaskContract('hello')
    assert.equal(contract.objective, 'hello')
    assert.deepEqual(contract.scope.mentionedFiles, [])
    assert.deepEqual(contract.constraints, [])
  })
})

describe('TaskContract status transitions', () => {
  it('starts as exploring', () => {
    const contract = extractTaskContract('do something')
    assert.equal(contract.status, 'exploring')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/task-contract.test.ts`
预期：FAIL — cannot find module

- [ ] **步骤 3：实现 task-contract.ts**

```typescript
// src/agent/task-contract.ts

export type ContractStatus =
  | 'exploring'
  | 'planning'
  | 'executing'
  | 'verifying'
  | 'blocked'
  | 'ready_to_deliver'

export interface TaskContract {
  objective: string
  scope: {
    mentionedFiles: string[]
  }
  constraints: string[]
  status: ContractStatus
  createdAtTurn: number
}

const FILE_PATTERN = /(?:^|\s)((?:src|lib|test|tests|pkg|cmd|internal|docs|scripts)\/[\w./-]+\.\w+)/g
const CONSTRAINT_PATTERN = /(?:(?:don'?t|must(?:n'?t)?|never|不要|禁止|必须|不可以|不能)\s+)(.{5,80})/gi

export function extractTaskContract(userMessage: string, turn: number = 0): TaskContract {
  const objective = userMessage.slice(0, 200).split('\n')[0]!.trim()

  const mentionedFiles: string[] = []
  for (const match of userMessage.matchAll(FILE_PATTERN)) {
    if (!mentionedFiles.includes(match[1]!)) {
      mentionedFiles.push(match[1]!)
    }
  }

  const constraints: string[] = []
  for (const match of userMessage.matchAll(CONSTRAINT_PATTERN)) {
    const text = match[0]!.trim().slice(0, 100)
    if (!constraints.includes(text)) {
      constraints.push(text)
    }
  }

  return {
    objective,
    scope: { mentionedFiles },
    constraints,
    status: 'exploring',
    createdAtTurn: turn,
  }
}

export function advanceContractStatus(contract: TaskContract, newStatus: ContractStatus): TaskContract {
  return { ...contract, status: newStatus }
}

export function renderContractProjection(contract: TaskContract): string {
  const parts = [`<task-contract status="${contract.status}">`]
  parts.push(`  <objective>${contract.objective}</objective>`)
  if (contract.scope.mentionedFiles.length > 0) {
    parts.push(`  <scope>${contract.scope.mentionedFiles.join(', ')}</scope>`)
  }
  if (contract.constraints.length > 0) {
    for (const c of contract.constraints) {
      parts.push(`  <constraint>${c}</constraint>`)
    }
  }
  parts.push('</task-contract>')
  return parts.join('\n')
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/task-contract.test.ts`
预期：7 tests PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/task-contract.ts src/agent/__tests__/task-contract.test.ts
git commit -m "feat(agent): add TaskContract — mission anchor for anti-drift"
```

---

### 任务 2：CognitiveLedger 只读聚合器

**文件：**
- 新建：`src/agent/cognitive-ledger.ts`
- 测试：`src/agent/__tests__/cognitive-ledger.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/agent/__tests__/cognitive-ledger.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CognitiveLedger } from '../cognitive-ledger.js'
import type { TaskContract } from '../task-contract.js'
import type { EvidenceState } from '../evidence.js'
import type { TraceStore } from '../trace-store.js'

describe('CognitiveLedger', () => {
  function makeLedger(overrides: Partial<{
    contract: TaskContract
    evidence: EvidenceState
    trace: TraceStore
    turn: number
  }> = {}) {
    return new CognitiveLedger({
      contract: overrides.contract ?? {
        objective: 'fix auth bug',
        scope: { mentionedFiles: ['src/auth.ts'] },
        constraints: ['don\'t break API'],
        status: 'executing',
        createdAtTurn: 0,
      },
      evidence: overrides.evidence ?? {
        filesRead: new Set(['src/auth.ts', 'src/types.ts']),
        filesModified: new Set(['src/auth.ts']),
        verifications: [],
        deliveryStatus: 'unverified',
        impactedFiles: new Set(),
        impactedTests: new Set(),
      },
      trace: overrides.trace ?? {
        maxEvents: 50,
        events: [],
        toolFingerprints: [],
      },
      turn: overrides.turn ?? 5,
    })
  }

  it('getPromptProjection includes contract objective', () => {
    const ledger = makeLedger()
    const projection = ledger.getPromptProjection()
    assert.ok(projection.includes('fix auth bug'))
    assert.ok(projection.includes('task-contract'))
  })

  it('getPromptProjection is short (under 500 chars for simple contract)', () => {
    const ledger = makeLedger()
    const projection = ledger.getPromptProjection()
    assert.ok(projection.length < 500, `Projection too long: ${projection.length} chars`)
  })

  it('getPromptProjection omits contract when status is exploring', () => {
    const ledger = makeLedger({
      contract: {
        objective: 'hello',
        scope: { mentionedFiles: [] },
        constraints: [],
        status: 'exploring',
        createdAtTurn: 0,
      },
    })
    const projection = ledger.getPromptProjection()
    assert.equal(projection, '')
  })

  it('getPhaseSnapshot returns structured state', () => {
    const ledger = makeLedger()
    const snapshot = ledger.getPhaseSnapshot()
    assert.equal(snapshot.contractStatus, 'executing')
    assert.equal(snapshot.filesRead, 2)
    assert.equal(snapshot.filesModified, 1)
    assert.equal(snapshot.deliveryStatus, 'unverified')
    assert.equal(snapshot.turn, 5)
  })

  it('getPhaseSnapshot works without contract', () => {
    const ledger = new CognitiveLedger({
      evidence: {
        filesRead: new Set(),
        filesModified: new Set(),
        verifications: [],
        deliveryStatus: 'unverified',
        impactedFiles: new Set(),
        impactedTests: new Set(),
      },
      trace: { maxEvents: 50, events: [], toolFingerprints: [] },
      turn: 0,
    })
    const snapshot = ledger.getPhaseSnapshot()
    assert.equal(snapshot.contractStatus, undefined)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/cognitive-ledger.test.ts`
预期：FAIL — cannot find module

- [ ] **步骤 3：实现 cognitive-ledger.ts**

```typescript
// src/agent/cognitive-ledger.ts

import { renderContractProjection, type TaskContract } from './task-contract.js'
import type { EvidenceState } from './evidence.js'
import type { TraceStore } from './trace-store.js'

export interface LedgerInput {
  contract?: TaskContract
  evidence: EvidenceState
  trace: TraceStore
  turn: number
}

export interface PhaseSnapshot {
  contractStatus?: string
  objective?: string
  filesRead: number
  filesModified: number
  deliveryStatus: string
  doomLevel: string
  turn: number
}

export class CognitiveLedger {
  private readonly input: LedgerInput

  constructor(input: LedgerInput) {
    this.input = input
  }

  update(partial: Partial<LedgerInput>): CognitiveLedger {
    return new CognitiveLedger({ ...this.input, ...partial })
  }

  getPromptProjection(): string {
    const { contract } = this.input
    if (!contract || contract.status === 'exploring') return ''
    return renderContractProjection(contract)
  }

  getPhaseSnapshot(): PhaseSnapshot {
    const { contract, evidence, trace, turn } = this.input
    const fingerprints = trace.toolFingerprints
    const uniqueFingerprints = new Set(fingerprints)
    const doomLevel = fingerprints.length >= 3 && uniqueFingerprints.size <= 1
      ? 'blocked'
      : fingerprints.length >= 2 && uniqueFingerprints.size <= 1
        ? 'warn'
        : 'none'

    return {
      contractStatus: contract?.status,
      objective: contract?.objective,
      filesRead: evidence.filesRead.size,
      filesModified: evidence.filesModified.size,
      deliveryStatus: evidence.deliveryStatus,
      doomLevel,
      turn,
    }
  }

  getContract(): TaskContract | undefined {
    return this.input.contract
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/cognitive-ledger.test.ts`
预期：5 tests PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/cognitive-ledger.ts src/agent/__tests__/cognitive-ledger.test.ts
git commit -m "feat(agent): add CognitiveLedger — unified read interface over existing stores"
```

---

### 任务 3：AgentLoop 接入 — 首轮提取 TaskContract

**文件：**
- 修改：`src/agent/loop.ts`

- [ ] **步骤 1：读取 loop.ts 理解首轮消息处理位置**

在 `src/agent/loop.ts` 中找到：
- 首轮（turn === 0）处理逻辑
- 用户消息获取位置
- 现有 `promptEngine` 引用

- [ ] **步骤 2：添加 import 和 TaskContract 提取**

在 loop.ts import 区域添加：

```typescript
import { extractTaskContract, advanceContractStatus, type TaskContract } from './task-contract.js'
import { CognitiveLedger } from './cognitive-ledger.js'
```

在 AgentLoop 类中添加字段：

```typescript
private taskContract?: TaskContract
private cognitiveLedger?: CognitiveLedger
```

在首轮处理（turn === 0）的 perception 完成后、buildRequest 之前添加：

```typescript
// Extract TaskContract from first user message
if (turn === 0 && !this.taskContract) {
  const firstUserMsg = messages.find(m => m.role === 'user' && typeof m.content === 'string')
  if (firstUserMsg && typeof firstUserMsg.content === 'string') {
    this.taskContract = extractTaskContract(firstUserMsg.content, 0)
    this.config.promptEngine.setTaskContract(this.taskContract)
  }
}
```

每轮更新 CognitiveLedger（在 buildRequest 之前）：

```typescript
this.cognitiveLedger = new CognitiveLedger({
  contract: this.taskContract,
  evidence: this.evidence.getState(),
  trace: this.traceStore,
  turn,
})
```

注意：具体变量名（`this.evidence` vs `this.evidenceTracker`，`this.traceStore` vs `this.trace`）需要根据 loop.ts 实际命名调整。Worker 应先 Read loop.ts 确认变量名。

- [ ] **步骤 3：在 StarPhase 映射附近添加 contract status 同步**

在已有的 `setPhaseHint` 调用附近，添加 contract status 同步：

```typescript
// Sync contract status with StarPhase
if (this.taskContract) {
  const phaseToContractStatus: Record<string, string> = {
    explore: 'exploring',
    plan: 'planning',
    execute: 'executing',
    verify: 'verifying',
    deliver: 'ready_to_deliver',
  }
  const newStatus = phaseToContractStatus[phaseClass]
  if (newStatus && newStatus !== this.taskContract.status) {
    this.taskContract = advanceContractStatus(this.taskContract, newStatus as any)
    this.config.promptEngine.setTaskContract(this.taskContract)
  }
}
```

- [ ] **步骤 4：运行 typecheck + 测试**

运行：`npx tsc --noEmit && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
预期：0 errors，全量测试通过

- [ ] **步骤 5：Commit**

```bash
git add src/agent/loop.ts
git commit -m "feat(agent): wire TaskContract + CognitiveLedger into AgentLoop"
```

---

### 任务 4：PromptEngine 接入 — TaskContract minimal projection

**文件：**
- 修改：`src/prompt/engine.ts`

- [ ] **步骤 1：添加 setTaskContract 方法**

在 engine.ts 中添加字段和 setter：

```typescript
private taskContract?: TaskContract
```

```typescript
setTaskContract(contract: TaskContract): void {
  this.taskContract = contract
}
```

添加 import：

```typescript
import type { TaskContract } from '../agent/task-contract.js'
import { renderContractProjection } from '../agent/task-contract.js'
```

注意：这会引入 `src/prompt/` → `src/agent/` 的 import。但 TaskContract 是纯数据类型 + 纯函数（零 side effect），这个依赖方向是安全的。如果想更严格地维护边界，可以把 TaskContract interface 和 renderContractProjection 移到 `src/prompt/` 或 `src/shared/`。Worker 可自行判断。

- [ ] **步骤 2：在 buildRequest 中注入 contract projection**

在 buildRequest() 中，找到生成 FRESH volatile 的位置。在 `buildDynamicAppendix(activeCtx)` 调用之前，如果 taskContract 存在且 status 不是 exploring，将 contract projection 注入到 dynamic appendix 的开头。

最简方案：在 dynamicCtx 中添加一个新的可选字段 `_contractProjection`，或直接在 cachedFreshBlock 生成后拼接。

推荐方案：在 buildDynamicAppendix 返回的 appendix 前面拼接 contract projection：

```typescript
const contractProjection = this.taskContract && this.taskContract.status !== 'exploring'
  ? renderContractProjection(this.taskContract)
  : ''

const fullAppendix = contractProjection && activeAppendix
  ? contractProjection + '\n' + activeAppendix
  : contractProjection || activeAppendix

this.cachedFreshBlock = fullAppendix
  ? this.volatileBlock + '\n' + fullAppendix
  : this.volatileBlock
```

同样的逻辑也要应用到 else 分支（无 tracker 时）的 `buildLatestTurnVolatileBlock` 路径。

- [ ] **步骤 3：运行 typecheck + 测试**

运行：`npx tsc --noEmit && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
预期：0 errors，全量测试通过

- [ ] **步骤 4：Commit**

```bash
git add src/prompt/engine.ts
git commit -m "feat(prompt): inject TaskContract minimal projection into agent context"
```

---

### 任务 5：全量验证 + contract 投影大小检查

**文件：** 无新文件

- [ ] **步骤 1：运行 typecheck**

运行：`npx tsc --noEmit`
预期：0 errors

- [ ] **步骤 2：运行全量测试**

运行：`npm test`
预期：全部 PASS

- [ ] **步骤 3：运行 build**

运行：`npm run build`
预期：成功

- [ ] **步骤 4：验证 contract projection 大小**

写一个快速验证脚本或在 node REPL 中：

```typescript
import { extractTaskContract, renderContractProjection } from './src/agent/task-contract.js'
const contract = extractTaskContract('refactor src/auth/middleware.ts and src/auth/types.ts to use zod validation. Don\'t modify the database schema. Must be backwards compatible.')
contract.status = 'executing'
const projection = renderContractProjection(contract)
console.log(projection)
console.log(`Length: ${projection.length} chars, ~${Math.ceil(projection.length / 4)} tokens`)
```

预期：projection < 300 chars（~75 tokens）。这比移出的 ~1,700 tokens 小得多。

---

## 自检结果

**1. 规格覆盖度：**
- TaskContract 创建 ✓（任务 1）
- CognitiveLedger 统一读接口 ✓（任务 2）
- AgentLoop 首轮提取 + 状态同步 ✓（任务 3）
- Prompt minimal projection ✓（任务 4）
- Contract status 跟随 StarPhase ✓（任务 3）
- TUI projection — **未覆盖**，属于后续增强。CognitiveLedger.getPhaseSnapshot() 已提供数据，TUI 消费可在天枢之眼 Starbridge 中接入。

**2. 占位符扫描：** 任务 3 和 4 中变量名标注为"需根据实际代码调整"，因为 loop.ts 和 engine.ts 是大文件。Worker 需先 Read 相关区域。

**3. 类型一致性：**
- `TaskContract` 在 task-contract.ts 定义，loop.ts 和 engine.ts 消费 — 一致
- `CognitiveLedger` 在 cognitive-ledger.ts 定义，loop.ts 消费 — 一致
- `renderContractProjection` 在 task-contract.ts 导出，engine.ts 调用 — 一致
- `EvidenceState` / `TraceStore` 从现有模块 import，cognitive-ledger.ts 使用 — 一致

---

## 依赖关系

```
任务 1（TaskContract）→ 任务 2（CognitiveLedger 使用 TaskContract）
任务 2（CognitiveLedger）→ 任务 3（loop.ts 创建 CognitiveLedger）
任务 1（TaskContract）→ 任务 4（engine.ts 使用 renderContractProjection）
任务 3 + 4 → 任务 5（全量验证）

可并行：
- 任务 1 和 2 可以串行快速完成（都是纯数据结构）
- 任务 3 和 4 可以并行（分别改 loop.ts 和 engine.ts）
```

---

## 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| loop.ts 变量名不确定 | 中 | 低 | Worker 先 Read 相关区域 |
| src/prompt/ → src/agent/ import 方向 | 低 | 中 | TaskContract 是纯数据类型，无副作用。可后续移到 shared/ |
| contract 提取 regex 不准 | 中 | 低 | 保守策略：提取不到就不注入，不影响现有行为 |
| contract projection 增加 volatile 大小 | 低 | 低 | 预期 < 75 tokens，远小于移出的 1,700 tokens |

---

## 明确排除（Phase 1 不做）

| 提议 | 为什么不做 |
|------|-----------|
| Belief 模型 | Phase C，等 CognitiveLedger 稳定 |
| Decision 结构化记录 | Phase C，当前 regex 提取够用 |
| Worker 结果进 ledger | Phase D，Subagent Phase 1 刚稳定 |
| TUI 消费 CognitiveLedger | 后续 Starbridge 任务，本轮只提供数据接口 |
| Success criteria 自动检查 | Phase B 后续，需要 LLM 参与评估 |
| Playbook/Claim 进 CognitiveLedger | Phase 2 增量，本轮先聚合 evidence + trace |

---

## StarSpine Phase 路线图（概览）

```
Phase 1 (本计划): TaskContract + CognitiveLedger query + Prompt projection
Phase 2: CognitiveLedger 扩展 (Claims, Playbook, Decisions 聚合)
Phase 3: Evidence-Gated Execution (Belief 模型 + 高风险动作门控)
Phase 4: Bounded Team Cognition (Worker 结果进 ledger)
```
