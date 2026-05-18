# Wave8 P2B/P2C 继续闭环 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在已有 Wave8 P0/P1/P2A 基础上，继续完成 write worker 的 HandsSession 路由闭环、知识投影注入与端到端验证，使 write-capable worker 只在隔离 worktree 中产生 diff artifact 回流。

**架构：** 当前已存在 `coordination-policy.ts`、`diff-collector.ts`、`worktree-coordinator.ts`、`worker-knowledge.ts`、`hands-session.ts` 等基础模块；本计划不重写这些模块，而是补齐 coordinator 层的路由 seam、runner 注入 seam、知识投影注入和测试闭环。为了避免破坏现有 WorkerSession 路径，先通过依赖注入方式新增可测试的 `runHands` 分支，再逐步接到 production runtimeFactory。

**技术栈：** Node.js 22、TypeScript strict、node:test、assert/strict、现有 AgentLoop / DelegationCoordinator / WorkOrder / ToolRegistry / WorktreeCoordinator。

---

## 1. Scope check

### 1.1 已读上下文

- `docs/superpowers/plans/2026-05-19-wave8-hands-worktree-knowledge.md`：Wave8 原计划，目标是 Brain/Hands 分离、worktree 隔离、知识共享。
- `src/agent/coordination-policy.ts`：已有 Brain/Hands/readonly 分类与工具 allowlist。
- `src/agent/diff-collector.ts`：已有 `collectDiff()` 与 `formatDiffArtifact()`，并已改为 `spawnSync` 参数数组调用，避免 shell string。
- `src/agent/worktree-coordinator.ts`：已有 worktree 生命周期封装。
- `src/agent/worker-knowledge.ts`：已有只读 claim XML 投影。
- `src/agent/hands-session.ts`：已有 runHandsSession，但当前需要审查 runner 注入、worktree cwd、blocked 语义和 usage 回流。
- `src/agent/coordinator.ts`：当前仍主要通过 `runWorkerSession` 路径运行 worker，尚未稳定接入 HandsSession 路由。
- `src/agent/worker-session.ts`：现有 read-only worker session 路径，不应被本计划破坏。
- `src/agent/work-order.ts`：`WorkerArtifact.kind` 已支持 `diff`；`createWriteWorkOrder()` 已存在。

### 1.2 独立子系统拆分

本计划涉及三个可独立测试的子系统：

| 子系统 | 本计划处理方式 | 是否拆分 |
|---|---|---|
| Coordinator Hands 路由 | 必做；这是 write worker 从模块能力变 runtime 能力的关键 seam | 不拆分 |
| Worker knowledge projection 注入 | 必做；但只注入 worker volatile/prompt，不改 static prompt | 不拆分 |
| Full production AgentLoop runner | 分两步；先测试 seam，再接 runtimeFactory，避免一次性大改 | 不拆分 |

结论：保持一个计划，但任务分成小提交；每个任务都能单独跑 targeted tests。

### 1.3 明确不做

- 不修改 `src/prompt/static.ts`。
- 不让 Hands 拥有 `delegate_task` 或 `delegate_batch`。
- 不让 write worker 直接修改 primary worktree。
- 不把 worker message 写入 primary `SessionContext`。
- 不把 Genome / Self-Bid / Surgical Pause 接入 runtime；这些属于未来 evaluation track。

---

## 2. File structure

### 2.1 创建文件

| 文件 | 职责 |
|---|---|
| `docs/analysis/2026-05-19-wave8-p2b-p2c-closure.md` | 执行结束后记录验证结果、风险、下一阶段待办。 |

### 2.2 修改文件

| 文件 | 职责 | 预计修改范围 |
|---|---|---|
| `src/agent/coordinator.ts` | 增加 HandsSession 路由 seam；保留 readonly WorkerSession 路径。 | `src/agent/coordinator.ts:1-220` |
| `src/agent/__tests__/coordinator.test.ts` | 增加 patcher/verifier 路由到 injected Hands runner 的测试。 | `src/agent/__tests__/coordinator.test.ts` |
| `src/agent/hands-session.ts` | 确保 runAgent 在 worktree cwd 语义清晰；blocked result 不泄漏异常；usage 回流一致。 | `src/agent/hands-session.ts:1-110` |
| `src/agent/__tests__/hands-session.test.ts` | 增加 unparseable result、apiError、diff artifact schema-valid 测试。 | `src/agent/__tests__/hands-session.test.ts` |
| `src/agent/worker-session.ts` | 对 readonly worker 注入 `buildWorkerKnowledgeBlock()`，保持 read-only 不变。 | `src/agent/worker-session.ts:1-130` |
| `src/agent/__tests__/worker-session.test.ts` | 验证 activeClaims 被投影为 worker knowledge 或 active claims，不污染 primary session。 | `src/agent/__tests__/worker-session.test.ts` |
| `src/agent/work-order.ts` | 如测试发现缺口，只做 schema 最小补齐；当前预计无需改。 | `src/agent/work-order.ts:80-130` |
| `docs/superpowers/plans/2026-05-19-wave8-hands-routing-knowledge-projection-closure.md` | 本实施计划。 | 全文件 |

---

## 3. Tasks

### 任务 1：Coordinator 增加 injectable Hands runner seam

**目标：** 让 `DelegationCoordinator` 能在测试中对 `patcher` / `verifier` profile 使用 HandsSession 路径，同时不影响现有 read-only worker。

**文件：**
- 创建：无
- 修改：`src/agent/coordinator.ts:1-220`
- 测试：`src/agent/__tests__/coordinator.test.ts`

- [ ] **步骤 1：编写失败测试**

在 `src/agent/__tests__/coordinator.test.ts` 中新增测试，放在 `DelegationCoordinator` 相关 describe 内：

```ts
it('routes patcher profile through injected hands runner', async () => {
  let handsCalled = false
  const registry = makeRegistry(['read_file', 'grep', 'glob', 'diff', 'inspect_project', 'repo_map', 'related_tests', 'edit_file', 'write_file', 'bash', 'run_tests'])
  const coordinator = new DelegationCoordinator({
    baseToolRegistry: registry,
    modelCards: [card('deepseek-v4')],
    maxWorkers: 2,
    runtimeFactory: makeRuntimeFactory(),
    runHands: async ({ order }) => {
      handsCalled = true
      return {
        result: {
          workOrderId: order.id,
          status: 'passed',
          summary: 'hands completed in isolated worktree',
          findings: [],
          artifacts: [{ kind: 'diff', title: 'Patch: src/a.ts', content: 'diff --git a/src/a.ts b/src/a.ts' }],
          changedFiles: ['src/a.ts'],
          risks: [],
          nextActions: [],
          evidenceStatus: 'unverified',
        },
        usage: {},
      }
    },
  })

  const run = await coordinator.delegate({
    parentTurnId: 'turn-1',
    objective: 'patch multiple files safely in an isolated worktree',
    kind: 'patch_proposal',
    profile: 'patcher',
    scope: { files: ['src/a.ts', 'src/b.ts'] },
  })

  assert.equal(handsCalled, true)
  assert.equal(run.results[0]?.artifacts[0]?.kind, 'diff')
})
```

如果 `makeRegistry`、`card`、`makeRuntimeFactory` 不存在，在测试文件顶部或 describe 内新增最小 helper：

```ts
function card(model: string): ModelCapabilityCard {
  return {
    model,
    toolUseReliability: 0.9,
    jsonStability: 0.9,
    editSuccessRate: 0.8,
    testRepairRate: 0.8,
    contextWindow: 128000,
    cacheEconomics: 'strong',
    recommendedTasks: ['risky_refactor'],
  }
}
```

预期：测试编译失败，提示 `runHands` 不存在于 `DelegationCoordinatorConfig`。

- [ ] **步骤 2：运行失败测试**

命令：

```bash
./node_modules/.bin/tsx --test src/agent/__tests__/coordinator.test.ts
```

预期：FAIL，错误指向 `runHands` 类型缺失或 patcher 未走 hands runner。

- [ ] **步骤 3：扩展 coordinator 类型**

在 `src/agent/coordinator.ts` imports 中加入：

```ts
import { classifyProfile } from './coordination-policy.js'
import { runHandsSession, type HandsSessionConfig, type HandsSessionRun } from './hands-session.js'
import { WorktreeCoordinator } from './worktree-coordinator.js'
import { buildWorkerKnowledgeBlock } from './worker-knowledge.js'
```

在 `DelegationCoordinatorConfig` 中加入：

```ts
runHands?: (config: HandsSessionConfig) => Promise<HandsSessionRun>
cwd?: string
compact?: import('../compact/constants.js').CompactionConfig
activeClaims?: () => import('../context/claims.js').ContextClaim[]
```

在 class 中增加字段：

```ts
private runHands: (config: HandsSessionConfig) => Promise<HandsSessionRun>

constructor(private config: DelegationCoordinatorConfig) {
  this.runWorker = config.runWorker ?? runWorkerSession
  this.runHands = config.runHands ?? runHandsSession
  this.state = new CoordinatorState(config.maxWorkers)
}
```

预期：类型层面允许注入 hands runner。

- [ ] **步骤 4：实现 delegateOrder hands 分支**

在 `delegateOrder(order)` 中，创建 `workerRegistry` 后、调用 `runtimeFactory` 前加入：

```ts
const role = classifyProfile(order.profile)
if (role === 'hands') {
  const workerConfig = this.config.runtimeFactory(order, selected, workerRegistry)
  const activeClaims = this.config.activeClaims?.() ?? workerConfig.activeClaims ?? []
  const knowledgeBlock = buildWorkerKnowledgeBlock(activeClaims)
  const wtCoordinator = new WorktreeCoordinator(this.config.cwd ?? workerConfig.cwd)
  this.state.recordEvent({ type: 'running', workOrderId: order.id, timestamp: Date.now() })
  const run = await this.runHands({
    order,
    wtCoordinator,
    cwd: this.config.cwd ?? workerConfig.cwd,
    maxTurns: workerConfig.maxTurns,
    contextWindow: workerConfig.contextWindow,
    compact: this.config.compact ?? workerConfig.compact,
    activeClaims,
    runAgent: async (prompt, callbacks) => {
      const fullPrompt = knowledgeBlock ? `${knowledgeBlock}\n\n${prompt}` : prompt
      const sessionRun = await this.runWorker({ ...workerConfig, order: { ...order, objective: fullPrompt } })
      callbacks.onTurnComplete(sessionRun.usage, 1, true)
      return JSON.stringify(sessionRun.result)
    },
  })
  this.state.recordEvent({ type: run.result.status === 'passed' ? 'passed' : run.result.status === 'blocked' ? 'blocked' : 'failed', workOrderId: order.id, timestamp: Date.now() })
  const results = aggregateResults([run.result], 'primary_decides')
  return {
    status: 'completed',
    order,
    selectedModel: selected.model,
    results,
    packet: buildPrimaryWorkerPacket(results),
    aggregationPolicy: 'primary_decides',
  }
}
```

精确约束：

- readonly role 继续走现有 `runWorker(workerConfig)` 路径。
- `runAgent` 第一版可通过 `runWorker` 复用 worker session；若后续要让 worker cwd 真正指向 worktree，则在任务 3 中改。
- 不把 `knowledgeBlock` 写入 static prompt。

- [ ] **步骤 5：运行 coordinator 测试**

命令：

```bash
./node_modules/.bin/tsx --test src/agent/__tests__/coordinator.test.ts
```

预期：PASS；新增测试确认 patcher 走 injected hands runner。

- [ ] **步骤 6：提交**

命令：

```bash
git add src/agent/coordinator.ts src/agent/__tests__/coordinator.test.ts
git commit -m "feat(coordinator): route hands profiles through isolated runner seam"
```

预期：产生 conventional commit；不包含 `.rivet/*` 运行态文件。

---

### 任务 2：HandsSession 语义硬化与 schema-valid 结果保障

**目标：** 确保 HandsSession 在 worker 失败、JSON 不可解析、空 diff 场景下都返回 schema-valid WorkerResult，并清理 worktree。

**文件：**
- 创建：无
- 修改：`src/agent/hands-session.ts:1-110`
- 测试：`src/agent/__tests__/hands-session.test.ts`

- [ ] **步骤 1：新增失败和空 diff 测试**

在 `src/agent/__tests__/hands-session.test.ts` 中新增：

```ts
it('returns blocked WorkerResult when runAgent reports api error through callback', async () => {
  const order = testOrder({ id: 'wo-api-error' })
  const run = await runHandsSession({
    order,
    wtCoordinator,
    cwd: baseDir,
    maxTurns: 1,
    contextWindow: 128000,
    compact: { enabled: false, autoThreshold: 800000, autoFloor: 500000, model: 'flash' },
    runAgent: async (_prompt, callbacks) => {
      callbacks.onError(new Error('provider failed'))
      return ''
    },
  })
  assert.equal(run.result.status, 'blocked')
  assert.ok(run.result.summary.includes('provider failed'))
  assert.equal(wtCoordinator.getActiveCount(), 0)
})

it('does not add empty diff artifact when no worker changes exist', async () => {
  const order = testOrder({ id: 'wo-no-diff' })
  const run = await runHandsSession({
    order,
    wtCoordinator,
    cwd: baseDir,
    maxTurns: 1,
    contextWindow: 128000,
    compact: { enabled: false, autoThreshold: 800000, autoFloor: 500000, model: 'flash' },
    runAgent: async () => JSON.stringify({
      workOrderId: order.id,
      status: 'passed',
      summary: 'No changes needed',
      findings: [],
      artifacts: [],
      changedFiles: [],
      risks: [],
      nextActions: [],
      evidenceStatus: 'verified',
    }),
  })
  assert.equal(run.result.status, 'passed')
  assert.equal(run.result.artifacts.some(a => a.kind === 'diff'), false)
})
```

预期：若当前实现已满足，测试 PASS；若 callback error 后仍 parse 空 text，则 FAIL。

- [ ] **步骤 2：运行测试**

命令：

```bash
./node_modules/.bin/tsx --test src/agent/__tests__/hands-session.test.ts
```

预期：若 FAIL，执行步骤 3；若 PASS，跳到步骤 4。

- [ ] **步骤 3：硬化 runHandsSession**

在 `src/agent/hands-session.ts` 中确认以下行为：

```ts
if (apiError) {
  return {
    result: buildBlockedWorkerResult(config.order, apiError),
    usage: turnUsage,
  }
}
```

并确认 parse catch 返回 blocked：

```ts
try {
  result = parseWorkerResult(text, config.order.id)
} catch {
  result = buildBlockedWorkerResult(config.order, 'Worker result unparseable')
}
```

并确认只在 `diff` 非空时 push diff artifact：

```ts
if (diff) {
  result.artifacts.push(formatDiffArtifact(diff, config.order.profile))
}
```

预期：HandsSession 所有非成功路径均返回 schema-valid WorkerResult 或抛出 runAgent crash，同时 finally 清理 worktree。

- [ ] **步骤 4：运行 HandsSession 测试**

命令：

```bash
./node_modules/.bin/tsx --test src/agent/__tests__/hands-session.test.ts
```

预期：PASS。

- [ ] **步骤 5：提交**

命令：

```bash
git add src/agent/hands-session.ts src/agent/__tests__/hands-session.test.ts
git commit -m "fix(agent): harden hands session failure and empty-diff behavior"
```

预期：如果只新增测试且实现无需改，也仍可用 `test(agent): cover hands session failure cases`。

---

### 任务 3：Readonly WorkerSession 注入 worker knowledge 投影

**目标：** 让 worker 看到主 session 的只读 knowledge projection，但仍不共享 primary `SessionContext`。

**文件：**
- 创建：无
- 修改：`src/agent/worker-session.ts:1-130`
- 测试：`src/agent/__tests__/worker-session.test.ts`

- [ ] **步骤 1：新增测试：active claims 投影进入 prompt engine**

在 `src/agent/__tests__/worker-session.test.ts` 中新增测试，使用 mock client 捕获请求 messages 内容：

```ts
it('injects worker knowledge from active claims without sharing primary session', async () => {
  const activeClaims = [{
    id: 'claim-1',
    kind: 'user_constraint',
    scope: 'session',
    status: 'active',
    text: 'Use small focused files',
    confidence: 0.9,
    fitness: 10,
    source: { actor: 'user', sessionId: 's1', turn: 1, eventId: 'e1' },
    evidence: [],
    consumers: [],
    counterevidence: [],
    createdAt: 1000,
    lastUsedAt: 1000,
    tags: [],
  } satisfies ContextClaim]
  // runWorkerSession(... activeClaims ...)
  // assert request prompt includes <worker-knowledge> and does not mutate caller session
})
```

如现有 test helpers 不易捕获 prompt，可在测试中直接 mock `PromptEngine` 的 volatile rendering 方法或断言 `promptEngine.updateActiveClaims()` 仍被调用；优先使用已有 patterns。

预期：初始 FAIL，因为当前 `runWorkerSession()` 只调用 `updateActiveClaims()`，未构建 `<worker-knowledge>` block。

- [ ] **步骤 2：运行 worker-session 测试**

命令：

```bash
./node_modules/.bin/tsx --test src/agent/__tests__/worker-session.test.ts
```

预期：新增测试 FAIL 或现有测试 PASS 但无法证明 knowledge block；执行步骤 3。

- [ ] **步骤 3：实现最小 knowledge prompt 注入**

在 `src/agent/worker-session.ts` imports 中加入：

```ts
import { buildWorkerKnowledgeBlock } from './worker-knowledge.js'
```

在 `runWorkerSession()` 中替换 prompt 构造：

```ts
const knowledgeBlock = config.activeClaims && config.activeClaims.length > 0
  ? buildWorkerKnowledgeBlock(config.activeClaims)
  : ''
const basePrompt = buildWorkerPrompt(config.order)
const workerPrompt = knowledgeBlock ? `${knowledgeBlock}\n\n${basePrompt}` : basePrompt
let latestText = await runOnce(agent, workerPrompt, transcript)
```

保留已有：

```ts
config.promptEngine.updateActiveClaims(config.activeClaims)
```

原因：active claims 仍可进入 volatile context；knowledge block 是更明确的 worker 只读投影。

- [ ] **步骤 4：运行 worker-session 测试**

命令：

```bash
./node_modules/.bin/tsx --test src/agent/__tests__/worker-session.test.ts
```

预期：PASS。

- [ ] **步骤 5：提交**

命令：

```bash
git add src/agent/worker-session.ts src/agent/__tests__/worker-session.test.ts
git commit -m "feat(agent): inject read-only worker knowledge projection"
```

预期：产生 conventional commit。

---

### 任务 4：Coordinator / Worker / Hands 集成验证记录

**目标：** 将本阶段验证结果、已知风险和下一阶段任务写入工作记录，避免后来者误判状态。

**文件：**
- 创建：`docs/analysis/2026-05-19-wave8-p2b-p2c-closure.md`
- 修改：`docs/superpowers/plans/2026-05-19-wave8-hands-worktree-knowledge.md:1-1060`
- 测试：无

- [ ] **步骤 1：创建执行记录**

写入 `docs/analysis/2026-05-19-wave8-p2b-p2c-closure.md`：

```md
# Wave8 P2B/P2C 闭环执行记录

> 日期：2026-05-19
> 范围：Hands routing seam、HandsSession failure behavior、worker knowledge projection

## 完成项

| 项目 | 状态 | 证据 |
|---|---|---|
| Coordinator hands route seam | ✅ | coordinator targeted tests |
| HandsSession failure/empty-diff behavior | ✅ | hands-session targeted tests |
| Worker knowledge projection | ✅ | worker-session targeted tests |
| Typecheck | ✅ | `npx tsc --noEmit` |

## 剩余风险

- HandsSession 仍需真实 provider smoke test 才能证明 write worker end-to-end。
- Surgical Pause / diff approval 仍未接入 primary merge gate。
- Worktree cleanup 需要长期 session 的 crash recovery 扫描。

## 下一阶段建议

1. P3A：TUI 展示 worker diff artifact + approval。
2. P3B：Surgical Pause read-only conflict report。
3. P3C：write worker smoke test fixture。
```

- [ ] **步骤 2：更新 Wave8 原计划勾选状态**

在 `docs/superpowers/plans/2026-05-19-wave8-hands-worktree-knowledge.md` 中仅勾选已经完成的任务步骤，将对应 `- [ ]` 改为 `- [x]`。不要勾选未完成的 full runtime smoke 或未来任务。

- [ ] **步骤 3：提交文档**

命令：

```bash
git add docs/analysis/2026-05-19-wave8-p2b-p2c-closure.md docs/superpowers/plans/2026-05-19-wave8-hands-worktree-knowledge.md
git commit -m "docs(wave8): record p2 hands routing closure"
```

预期：只提交 docs 文件。

---

### 任务 5：最终验证与提交边界检查

**目标：** 确认本计划涉及的 runtime、tests、docs 均可验证；提交时不包含运行态 `.rivet/*` 或其他会话文件。

**文件：**
- 创建：无
- 修改：无
- 测试：`src/agent/__tests__/coordinator.test.ts`、`src/agent/__tests__/hands-session.test.ts`、`src/agent/__tests__/worker-session.test.ts`、`src/agent/__tests__/subagent-integration.test.ts`

- [ ] **步骤 1：运行 targeted tests**

命令：

```bash
./node_modules/.bin/tsx --test \
  src/agent/__tests__/coordinator.test.ts \
  src/agent/__tests__/hands-session.test.ts \
  src/agent/__tests__/worker-session.test.ts \
  src/agent/__tests__/subagent-integration.test.ts
```

预期：全部 PASS。

- [ ] **步骤 2：运行 typecheck**

命令：

```bash
npx tsc --noEmit
```

预期：退出码 0。

- [ ] **步骤 3：检查 staged 文件边界**

命令：

```bash
git status --short
```

预期：待提交文件只包含本计划列出的 `src/agent/*`、`src/agent/__tests__/*`、`docs/analysis/*`、`docs/superpowers/plans/*`；不包含 `.rivet/*`。

- [ ] **步骤 4：查看最近提交**

命令：

```bash
git log --oneline -5
```

预期：最近提交包含本计划产生的 conventional commits。

---

## 4. Verification

实施完成后按顺序运行：

```bash
./node_modules/.bin/tsx --test src/agent/__tests__/coordinator.test.ts
```

预期：PASS，包含 patcher profile 走 injected Hands runner 的测试。

```bash
./node_modules/.bin/tsx --test src/agent/__tests__/hands-session.test.ts
```

预期：PASS，覆盖 worktree cleanup、diff artifact、apiError blocked、unparseable blocked、empty diff。

```bash
./node_modules/.bin/tsx --test src/agent/__tests__/worker-session.test.ts
```

预期：PASS，覆盖 worker knowledge projection。

```bash
./node_modules/.bin/tsx --test src/agent/__tests__/subagent-integration.test.ts
```

预期：PASS，覆盖 subagent integration mocks 和 claim flow。

```bash
npx tsc --noEmit
```

预期：退出码 0。

如全量测试时间允许，再运行：

```bash
npx tsx --test src/**/__tests__/*.test.ts
```

预期：全部 PASS；若已知 `compact.test.ts` 偶发失败，记录为 known flaky 并重跑对应文件。

---

## 5. Self-check

### 5.1 Spec coverage

| Requirement | 覆盖任务 |
|---|---|
| Do not write implementation code yet | 本文件只保存计划；代码改动留给执行阶段。 |
| Read relevant docs/specs/code first | Scope check 1.1 已列出已读 Wave8 plan、HandsSession、Coordinator、WorkerSession、WorkOrder。 |
| Save plan to specified path | 本文件保存为 `docs/superpowers/plans/2026-05-19-wave8-hands-routing-knowledge-projection-closure.md`。 |
| Near-zero context engineer | Scope、File structure、Tasks 均列路径、目标、命令和预期。 |
| Engineer may not design tests well | 每个 code task 都给出具体 test snippets 或断言方向。 |
| DRY/YAGNI/TDD/small commits | 使用现有 module seam；每个任务一组 focused files；每个任务有 commit。 |
| Required sections | 本文件包含 Scope check、File structure、Tasks、Verification、Self-check、Execution handoff。 |
| Exact files | 每个任务列出创建、修改、测试文件。 |
| Concrete edits | 任务 1-3 给出接口、代码片段和精确行为。 |
| Commands expected results | 所有命令均有预期结果。 |
| Conventional commits | 每个 commit 使用 feat/fix/test/docs scope 格式。 |

### 5.2 Placeholder scan

本计划未使用 forbidden placeholder patterns 作为未完成步骤。执行阶段可运行：

```bash
node -e "const fs=require('fs'); const p='docs/superpowers/plans/2026-05-19-wave8-hands-routing-knowledge-projection-closure.md'; const banned=['TO'+'DO','TB'+'D','待'+'定','后续'+'实现','补充'+'细节','类似任务 '+'N','添加适当的错误'+'处理','为上述代码编写'+'测试']; const text=fs.readFileSync(p,'utf8'); const hits=banned.filter(s=>text.includes(s)); if(hits.length){ console.error(hits.join('\n')); process.exit(1); }"
```

预期：无输出，退出码 0。

### 5.3 Type consistency

| Name | 定义位置 | 使用位置 | 一致性 |
|---|---|---|---|
| `DelegationCoordinatorConfig.runHands` | `src/agent/coordinator.ts` | coordinator tests | ✅ |
| `HandsSessionConfig` | `src/agent/hands-session.ts` | coordinator hands route | ✅ |
| `HandsSessionRun` | `src/agent/hands-session.ts` | coordinator injected runner | ✅ |
| `runHandsSession` | `src/agent/hands-session.ts` | coordinator default `runHands` | ✅ |
| `WorktreeCoordinator` | `src/agent/worktree-coordinator.ts` | hands session / coordinator | ✅ |
| `buildWorkerKnowledgeBlock` | `src/agent/worker-knowledge.ts` | coordinator / worker-session | ✅ |
| `WorkerArtifact.kind: 'diff'` | `src/agent/work-order.ts` | diff collector / hands result | ✅ |
| `runWorkerSession` | `src/agent/worker-session.ts` | readonly worker path | ✅ |

---

## 6. Execution handoff

计划已完成并保存到 `docs/superpowers/plans/2026-05-19-wave8-hands-routing-knowledge-projection-closure.md`。两种执行方式：
1. 子代理驱动（推荐）— 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. 内联执行 — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。
选哪种方式？
