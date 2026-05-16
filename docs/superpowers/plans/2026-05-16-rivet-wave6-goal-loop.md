# Wave 6: Goal Loop 实施计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让用户输入 `rivet --goal "make all tests pass" --budget 50`，agent 自主循环直到目标达成或 budget 耗尽，无需人工审批。对标 Codex `/goal` 功能。

**架构：** Goal Loop 建立在 headless 模式之上，增加循环控制层（exit condition check + budget gate + undo safety net）。

**技术栈：** TypeScript, existing headless.ts + AgentLoop + FileHistory infrastructure

**前置条件：** Wave 5 完成（per-call undo 作为安全保底）✅

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/goal-loop.ts` | Goal loop 核心：循环调用 agent.run()，检查退出条件，budget 管控 |
| `src/__tests__/goal-loop.test.ts` | Goal loop 单元测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/headless.ts` | 增加 goal/budget 到 HeadlessCliArgs，parseCliArgs 解析 --goal/--budget |
| `src/main.tsx` | 增加 --goal 路由，调用 goal loop |

---

## 任务 1：扩展 HeadlessCliArgs + parseCliArgs

**文件：**
- 修改：`src/headless.ts`
- 测试：`src/__tests__/headless.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// 在 src/__tests__/headless.test.ts 的 'headless CLI parsing' describe 中追加
it('recognizes --goal with --budget', () => {
  assert.deepEqual(
    parseCliArgs(['--goal', 'make tests pass', '--budget', '20']),
    { headless: true, prompt: undefined, json: false, streamJson: false, goal: 'make tests pass', budget: 20 }
  )
})

it('--goal defaults budget to 100', () => {
  const result = parseCliArgs(['--goal', 'fix lint'])
  assert.equal(result.goal, 'fix lint')
  assert.equal(result.budget, 100)
})
```

- [ ] **步骤 2：运行测试确认失败**

运行：`npm test -- src/__tests__/headless.test.ts`
预期：FAIL（goal/budget 字段不存在）

- [ ] **步骤 3：扩展 HeadlessCliArgs 和 parseCliArgs**

```typescript
// src/headless.ts — 修改 interface
export interface HeadlessCliArgs {
  headless: boolean
  prompt?: string
  json: boolean
  streamJson: boolean
  goal?: string
  budget?: number
}

// src/headless.ts — 修改 parseCliArgs
export function parseCliArgs(args: string[]): HeadlessCliArgs {
  const printIndex = args.findIndex(arg => arg === '-p' || arg === '--print')
  const goalIndex = args.findIndex(arg => arg === '--goal')
  const json = args.includes('--json')
  const streamJson = args.includes('--stream-json')

  if (goalIndex >= 0) {
    const goal = args[goalIndex + 1]
    const budgetIndex = args.indexOf('--budget')
    const budget = budgetIndex >= 0 ? parseInt(args[budgetIndex + 1]!, 10) : 100
    return { headless: true, prompt: undefined, json, streamJson, goal, budget }
  }

  if (printIndex === -1) return { headless: false, json, streamJson }
  const prompt = args[printIndex + 1]
  return { headless: true, prompt, json, streamJson }
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`npm test -- src/__tests__/headless.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/headless.ts src/__tests__/headless.test.ts
git commit -m "feat(goal): extend HeadlessCliArgs with --goal and --budget flags"
```

---

## 任务 2：Goal Loop 核心实现

**文件：**
- 创建：`src/goal-loop.ts`
- 创建：`src/__tests__/goal-loop.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/__tests__/goal-loop.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runGoalLoop, type GoalLoopConfig } from '../goal-loop.js'

describe('Goal Loop', () => {
  it('exits when goal is achieved (agent returns done)', async () => {
    let runCount = 0
    const config: GoalLoopConfig = {
      goal: 'fix the bug',
      budget: 10,
      createAgent: () => ({
        run: async (_prompt, callbacks) => {
          runCount++
          callbacks.onTextDelta('Fixed the bug. All tests pass.')
          callbacks.onTurnComplete({ input_tokens: 100, output_tokens: 50 }, runCount)
        },
      }),
      checkGoalAchieved: (text) => text.includes('All tests pass'),
    }
    const result = await runGoalLoop(config)
    assert.equal(result.achieved, true)
    assert.equal(result.iterations, 1)
    assert.equal(result.exitReason, 'goal_achieved')
  })

  it('exits when budget exhausted', async () => {
    let runCount = 0
    const config: GoalLoopConfig = {
      goal: 'impossible task',
      budget: 3,
      createAgent: () => ({
        run: async (_prompt, callbacks) => {
          runCount++
          callbacks.onTextDelta('Still working...')
          callbacks.onTurnComplete({ input_tokens: 1000, output_tokens: 500 }, runCount)
        },
      }),
      checkGoalAchieved: () => false,
    }
    const result = await runGoalLoop(config)
    assert.equal(result.achieved, false)
    assert.equal(result.iterations, 3)
    assert.equal(result.exitReason, 'budget_exhausted')
  })

  it('exits on consecutive failures', async () => {
    let runCount = 0
    const config: GoalLoopConfig = {
      goal: 'fix it',
      budget: 10,
      createAgent: () => ({
        run: async (_prompt, callbacks) => {
          runCount++
          callbacks.onError(new Error('API timeout'))
        },
      }),
      checkGoalAchieved: () => false,
    }
    const result = await runGoalLoop(config)
    assert.equal(result.achieved, false)
    assert.equal(result.exitReason, 'consecutive_failures')
    assert.ok(result.iterations <= 3)
  })
})
```

- [ ] **步骤 2：运行测试确认失败**

运行：`npm test -- src/__tests__/goal-loop.test.ts`
预期：FAIL（模块不存在）

- [ ] **步骤 3：实现 goal-loop.ts**

```typescript
// src/goal-loop.ts
import type { AgentCallbacks } from './agent/loop.js'
import type { Usage } from './api/types.js'

export interface GoalLoopAgent {
  run(prompt: string, callbacks: AgentCallbacks): Promise<void>
}

export interface GoalLoopConfig {
  goal: string
  budget: number
  createAgent: () => GoalLoopAgent | { run: (p: string, cb: AgentCallbacks) => Promise<void> }
  checkGoalAchieved: (lastOutput: string) => boolean
  onIteration?: (iteration: number, text: string, usage: Partial<Usage>) => void
}

export interface GoalLoopResult {
  achieved: boolean
  iterations: number
  exitReason: 'goal_achieved' | 'budget_exhausted' | 'consecutive_failures' | 'aborted'
  totalUsage: { input_tokens: number; output_tokens: number }
  lastOutput: string
}

export async function runGoalLoop(config: GoalLoopConfig): Promise<GoalLoopResult> {
  const agent = config.createAgent()
  let iterations = 0
  let consecutiveFailures = 0
  let lastOutput = ''
  const totalUsage = { input_tokens: 0, output_tokens: 0 }

  while (iterations < config.budget) {
    iterations++
    let text = ''
    let error: string | undefined
    let turnUsage: Partial<Usage> = {}

    const prompt = iterations === 1
      ? `Goal: ${config.goal}\n\nWork toward this goal. When complete, clearly state the goal is achieved.`
      : `Goal: ${config.goal}\n\nPrevious attempt output:\n${lastOutput.slice(-2000)}\n\nContinue working toward the goal.`

    await agent.run(prompt, {
      onTextDelta: (delta) => { text += delta },
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: (_id, _name, result, isError) => { if (isError) error = result },
      onTurnComplete: (usage) => { turnUsage = usage },
      onError: (err) => { error = err.message },
      onAbort: () => { error = 'aborted' },
      onApprovalRequired: async () => false,
    })

    totalUsage.input_tokens += turnUsage.input_tokens ?? 0
    totalUsage.output_tokens += turnUsage.output_tokens ?? 0
    lastOutput = text
    config.onIteration?.(iterations, text, turnUsage)

    if (error === 'aborted') {
      return { achieved: false, iterations, exitReason: 'aborted', totalUsage, lastOutput }
    }

    if (error) {
      consecutiveFailures++
      if (consecutiveFailures >= 3) {
        return { achieved: false, iterations, exitReason: 'consecutive_failures', totalUsage, lastOutput }
      }
      continue
    }

    consecutiveFailures = 0

    if (config.checkGoalAchieved(text)) {
      return { achieved: true, iterations, exitReason: 'goal_achieved', totalUsage, lastOutput }
    }
  }

  return { achieved: false, iterations, exitReason: 'budget_exhausted', totalUsage, lastOutput }
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`npm test -- src/__tests__/goal-loop.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/goal-loop.ts src/__tests__/goal-loop.test.ts
git commit -m "feat(goal): goal loop core — budget-capped autonomous iteration with failure circuit breaker"
```

---

## 任务 3：接线到 main.tsx

**文件：**
- 修改：`src/main.tsx`

- [ ] **步骤 1：在 main() 中添加 --goal 路由**

```typescript
// src/main.tsx — 在 'rivet serve' 路由之后，config 加载之前添加

// rivet --goal "text" [--budget N] — Goal Loop (autonomous)
if (args.includes('--goal')) {
  const { parseCliArgs } = await import('./headless.js')
  const { runGoalLoop } = await import('./goal-loop.js')
  const parsed = parseCliArgs(args)
  if (!parsed.goal) {
    console.error('--goal requires a goal description')
    process.exit(2)
  }

  const config = loadConfig()
  const provider = config.provider.providers[config.provider.default]
  if (!provider) { console.error('Provider not configured'); process.exit(1) }
  const apiKey = provider.apiKey ?? process.env[provider.apiKeyEnv ?? '']
  if (!apiKey) { console.error('API key not configured'); process.exit(1) }

  const currentModel = provider.models[0]!
  const result = await runGoalLoop({
    goal: parsed.goal,
    budget: parsed.budget ?? 100,
    createAgent: () => {
      const { createDeepSeekClient } = await import('./api/deepseek.js')
      const { PromptEngine } = await import('./prompt/engine.js')
      const { AgentLoop } = await import('./agent/loop.js')
      const { SessionContext } = await import('./agent/context.js')
      const { createDefaultToolRegistry } = await import('./tools/default-registry.js')

      const toolRegistry = createDefaultToolRegistry()
      const client = createDeepSeekClient({ apiKey, model: currentModel.id, reasoningEffort: currentModel.reasoningEffort, maxTokens: currentModel.maxTokens, thinkingBudget: 16000 })
      const promptEngine = new PromptEngine({ model: currentModel.id, maxTokens: currentModel.maxTokens, staticCtx: { tools: toolRegistry.getDefinitions() }, volatileCtx: { cwd: process.cwd() } })
      const session = new SessionContext()
      return new AgentLoop({ client, promptEngine, toolRegistry, maxTurns: 25, contextWindow: currentModel.contextWindow, compact: config.compact, approvalMode: 'auto-accept', sessionId: crypto.randomUUID() }, session, process.cwd())
    },
    checkGoalAchieved: (text) => {
      const lower = text.toLowerCase()
      return lower.includes('goal achieved') || lower.includes('all tests pass') || lower.includes('task complete')
    },
    onIteration: (i, _text, usage) => {
      console.log(`[Goal Loop] Iteration ${i} — ${usage.input_tokens ?? 0} in / ${usage.output_tokens ?? 0} out`)
    },
  })

  console.log(`\n[Goal Loop] ${result.achieved ? '✓ Goal achieved' : '✗ Goal not achieved'}`)
  console.log(`  Iterations: ${result.iterations}`)
  console.log(`  Exit reason: ${result.exitReason}`)
  console.log(`  Total tokens: ${result.totalUsage.input_tokens} in / ${result.totalUsage.output_tokens} out`)
  process.exit(result.achieved ? 0 : 1)
}
```

注意：上面的 `createAgent` 使用了 top-level await import。实际实现时需要调整为同步 import 或在 async IIFE 中。

- [ ] **步骤 2：运行 typecheck**

运行：`npx tsc --noEmit`
预期：无新错误

- [ ] **步骤 3：手动验证 CLI help**

在 `--help` 输出中添加 `--goal` 说明：
```
    rivet --goal "text"  Autonomous goal loop (budget-capped)
```

- [ ] **步骤 4：Commit**

```bash
git add src/main.tsx
git commit -m "feat(goal): wire --goal CLI flag to goal loop in main.tsx"
```

---

## 任务 4：Exit Condition 增强

**文件：**
- 修改：`src/goal-loop.ts`
- 测试：`src/__tests__/goal-loop.test.ts`

- [ ] **步骤 1：添加 test-runner 退出条件测试**

```typescript
it('detects goal achieved via test runner output', async () => {
  const config: GoalLoopConfig = {
    goal: 'make tests pass',
    budget: 5,
    createAgent: () => ({
      run: async (_prompt, callbacks) => {
        callbacks.onToolResult('t1', 'run_tests', 'Tests: 50 pass, 0 fail', false)
        callbacks.onTextDelta('All tests are passing now.')
        callbacks.onTurnComplete({ input_tokens: 200, output_tokens: 100 }, 1)
      },
    }),
    checkGoalAchieved: (text) => text.includes('All tests') && text.includes('pass'),
  }
  const result = await runGoalLoop(config)
  assert.equal(result.achieved, true)
})
```

- [ ] **步骤 2：运行测试**

运行：`npm test -- src/__tests__/goal-loop.test.ts`
预期：PASS

- [ ] **步骤 3：添加 tool_result 到 goal check 上下文**

修改 `runGoalLoop` 使 `checkGoalAchieved` 也能看到 tool results：

```typescript
// 在 callbacks 中收集 tool results
let toolResults: string[] = []
// ...
onToolResult: (_id, _name, result, isError) => {
  if (!isError) toolResults.push(result.slice(0, 500))
  if (isError) error = result
},
// ...
// 检查时合并 text + tool results
const fullContext = text + '\n' + toolResults.join('\n')
if (config.checkGoalAchieved(fullContext)) { ... }
```

- [ ] **步骤 4：Commit**

```bash
git add src/goal-loop.ts src/__tests__/goal-loop.test.ts
git commit -m "feat(goal): include tool_result context in goal achievement check"
```

---

## 任务 5：NDJSON 输出 + 集成测试

**文件：**
- 修改：`src/goal-loop.ts`
- 创建：`src/__tests__/goal-loop-integration.test.ts`

- [ ] **步骤 1：添加 --stream-json 支持**

当 `streamJson: true` 时，每次迭代输出 NDJSON 事件：

```typescript
// goal-loop.ts — onIteration 默认行为
if (config.streamJson) {
  process.stdout.write(JSON.stringify({
    type: 'goal_iteration',
    iteration: iterations,
    achieved: false,
    usage: turnUsage,
    text: text.slice(0, 500),
  }) + '\n')
}
```

- [ ] **步骤 2：集成测试**

```typescript
// src/__tests__/goal-loop-integration.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runGoalLoop } from '../goal-loop.js'

describe('Goal Loop integration', () => {
  it('multi-iteration convergence', async () => {
    let iteration = 0
    const result = await runGoalLoop({
      goal: 'count to 3',
      budget: 10,
      createAgent: () => ({
        run: async (_prompt, callbacks) => {
          iteration++
          callbacks.onTextDelta(iteration >= 3 ? 'Goal achieved! Counted to 3.' : `Count: ${iteration}`)
          callbacks.onTurnComplete({ input_tokens: 50, output_tokens: 20 }, iteration)
        },
      }),
      checkGoalAchieved: (text) => text.includes('Goal achieved'),
    })
    assert.equal(result.achieved, true)
    assert.equal(result.iterations, 3)
    assert.equal(result.exitReason, 'goal_achieved')
  })

  it('respects budget even when making progress', async () => {
    const result = await runGoalLoop({
      goal: 'infinite task',
      budget: 5,
      createAgent: () => ({
        run: async (_prompt, callbacks) => {
          callbacks.onTextDelta('Making progress...')
          callbacks.onTurnComplete({ input_tokens: 100, output_tokens: 50 }, 1)
        },
      }),
      checkGoalAchieved: () => false,
    })
    assert.equal(result.achieved, false)
    assert.equal(result.iterations, 5)
    assert.equal(result.exitReason, 'budget_exhausted')
  })
})
```

- [ ] **步骤 3：运行全部测试**

运行：`npm test`
预期：全部通过（750+）

- [ ] **步骤 4：Commit**

```bash
git add src/goal-loop.ts src/__tests__/goal-loop-integration.test.ts
git commit -m "feat(goal): NDJSON streaming + integration tests for multi-iteration convergence"
```

---

## 验收标准

| 标准 | 验证方法 |
|------|---------|
| `rivet --goal "text"` 启动自主循环 | CLI 解析正确，进入 goal loop |
| 目标达成时自动退出 (exit 0) | agent 输出包含 "goal achieved" → 退出 |
| budget 耗尽时退出 (exit 1) | 迭代次数 = budget 后退出 |
| 连续 3 次失败时退出 | API 错误 3 次 → circuit breaker |
| NDJSON 流式输出 | `--stream-json` 每次迭代输出一行 JSON |
| 所有测试通过 | npm test: 750+ pass, 0 fail |
| undo 安全网可用 | goal loop 中 FileHistory 正常记录快照 |
