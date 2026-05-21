# 三道防线内存安全 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 防止天枢 TUI 在几轮对话后因 messages 数组无界增长导致 512MB RSS 爆炸

**架构：** 三道防线分层防御——入口截断（防止大内容进堆）、轮预算（控制单轮 tool_result 总量）、轮末主动压缩（历史 tool_result 自动降级）。全部复用现有组件，不引入新系统。

**技术栈：** Node.js 22 / TypeScript strict / node:test + node:assert/strict / ESM (.js imports)

---

## 文件结构

| 文件 | 职责 | 操作 |
|------|------|------|
| `src/tools/read-file.ts` | 文件读取工具 | 修改：加 statSync 大小预检 |
| `src/tools/bash.ts` | Shell 执行工具 | 修改：stdout 上限 100K → 32K |
| `src/tools/grep.ts` | 搜索工具 | 修改：输出上限 12K → 8K |
| `src/agent/turn-budget.ts` | 轮预算管理器 | 新建 |
| `src/agent/tool-pipeline.ts` | 工具执行管道 | 修改：集成轮预算检查 |
| `src/agent/loop.ts` | 主循环 | 修改：轮末压缩 + 预算 reset |
| `src/compact/stale-round.ts` | 轮末压缩逻辑 | 新建 |
| `src/tools/__tests__/read-file.test.ts` | read-file 测试 | 修改：加大文件测试 |
| `src/agent/__tests__/turn-budget.test.ts` | 轮预算测试 | 新建 |
| `src/compact/__tests__/stale-round.test.ts` | 轮末压缩测试 | 新建 |

---

## 任务 1：第一道防线 — read_file 大小预检

**文件：**
- 修改：`src/tools/read-file.ts:1,75-103`
- 修改：`src/tools/__tests__/read-file.test.ts`

- [ ] **步骤 1：编写失败的测试 — 大文件无 offset/limit 应报错**

在 `src/tools/__tests__/read-file.test.ts` 中添加：

```typescript
import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFilePayload } from '../read-file.js'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('read-file size guard', () => {
  const testDir = join(tmpdir(), 'rivet-test-read-file-size')

  it('rejects files > 100KB without offset/limit', () => {
    mkdirSync(testDir, { recursive: true })
    const bigFile = join(testDir, 'big.txt')
    writeFileSync(bigFile, 'x'.repeat(150_000))

    assert.throws(
      () => readFilePayload(testDir, { filePath: bigFile }),
      /File too large/,
    )

    rmSync(testDir, { recursive: true, force: true })
  })

  it('allows files > 100KB when offset/limit provided', () => {
    mkdirSync(testDir, { recursive: true })
    const bigFile = join(testDir, 'big-with-offset.txt')
    writeFileSync(bigFile, Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n'))

    const result = readFilePayload(testDir, { filePath: bigFile, offset: 1, limit: 50 })
    assert.ok(result.modelContent.length > 0)
    assert.ok(result.modelContent.length < 8100)

    rmSync(testDir, { recursive: true, force: true })
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`./node_modules/.bin/tsx --test src/tools/__tests__/read-file.test.ts`
预期：FAIL — `readFilePayload` 不会 throw "File too large"

- [ ] **步骤 3：实现大小预检**

修改 `src/tools/read-file.ts`：

在文件顶部 imports 中加入 `statSync`：
```typescript
import { readFileSync, existsSync, statSync } from 'fs'
```

在常量区域加入：
```typescript
const MAX_TOOL_INPUT_BYTES = 100 * 1024 // 100KB
```

在 `readFilePayload` 函数中，`existsSync` 检查之后、`readFileSync` 之前加入：

```typescript
  const fileSize = statSync(filePath).size
  if (fileSize > MAX_TOOL_INPUT_BYTES && !options.offset && !options.limit) {
    const sizeKB = (fileSize / 1024).toFixed(0)
    const estLines = Math.ceil(fileSize / 80)
    throw new Error(
      `File too large (${sizeKB}KB, ~${estLines} lines). ` +
      `Use offset and limit to read specific ranges.`
    )
  }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`./node_modules/.bin/tsx --test src/tools/__tests__/read-file.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/tools/read-file.ts src/tools/__tests__/read-file.test.ts
git commit -m "feat(tools): add file size pre-check to read_file — reject >100KB without offset/limit"
```

---

## 任务 2：第一道防线 — bash stdout 上限收紧

**文件：**
- 修改：`src/tools/bash.ts:75-90`

- [ ] **步骤 1：编写失败的测试**

在 `src/tools/__tests__/bash.test.ts` 中添加（如果文件已存在则追加）：

```typescript
import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'

describe('bash stdout cap', () => {
  it('caps stdout at 32K chars', async () => {
    // Import the tool and execute a command that produces >32K output
    const { BASH_TOOL } = await import('../bash.js')
    const result = await BASH_TOOL.execute({
      toolUseId: 'test-cap',
      input: { command: `python3 -c "print('x' * 50000)"` },
      cwd: process.cwd(),
    })
    // modelContent (from buildModelOutput) should be truncated
    assert.ok(typeof result.content === 'string')
    // The raw stdout buffer should be capped at 32K
    assert.ok(result.content.length <= 40_000) // model output adds header + truncation note
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`./node_modules/.bin/tsx --test src/tools/__tests__/bash.test.ts`
预期：FAIL — stdout 仍然允许 100K

- [ ] **步骤 3：修改 bash.ts stdout 上限**

修改 `src/tools/bash.ts` 第 79-81 行和第 88-90 行：

```typescript
      child.stdout!.on('data', (data: Buffer) => {
        const text = data.toString()
        stdout += text
        params.onOutput?.(text)
        if (stdout.length > 32_000) {
          stdout = stdout.slice(-24_000)
        }
      })

      child.stderr!.on('data', (data: Buffer) => {
        const text = data.toString()
        stderr += text
        params.onOutput?.(text)
        if (stderr.length > 32_000) {
          stderr = stderr.slice(-24_000)
        }
      })
```

- [ ] **步骤 4：运行测试验证通过**

运行：`./node_modules/.bin/tsx --test src/tools/__tests__/bash.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/tools/bash.ts src/tools/__tests__/bash.test.ts
git commit -m "feat(tools): tighten bash stdout cap from 100K to 32K chars"
```

---

## 任务 3：第一道防线 — grep 输出上限收紧

**文件：**
- 修改：`src/tools/grep.ts:73,166`

- [ ] **步骤 1：修改 grep 截断常量**

修改 `src/tools/grep.ts` 第 73 行：

```typescript
      return { content: truncateContent(text, 8000, 4000, 2000) }
```

修改第 166 行（如果存在第二个 truncateContent 调用）：

```typescript
      resolve({ content: truncateContent(lines.join('\n') + suffix, 8000, 4000, 2000) })
```

- [ ] **步骤 2：运行现有 grep 测试验证不破坏**

运行：`./node_modules/.bin/tsx --test src/tools/__tests__/grep.test.ts`
预期：PASS（现有测试不依赖 12K 上限）

- [ ] **步骤 3：Commit**

```bash
git add src/tools/grep.ts
git commit -m "feat(tools): tighten grep output cap from 12K to 8K chars"
```

---

## 任务 4：第二道防线 — TurnBudget 模块

**文件：**
- 新建：`src/agent/turn-budget.ts`
- 新建：`src/agent/__tests__/turn-budget.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `src/agent/__tests__/turn-budget.test.ts`：

```typescript
import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { createTurnBudget, BASE_BUDGET_TOKENS, PRESSURE_BUDGET_TOKENS } from '../turn-budget.js'

describe('TurnBudget', () => {
  it('uses base budget when RSS ratio < 0.7', () => {
    const budget = createTurnBudget(0.5)
    assert.equal(budget.maxTokensPerTurn, BASE_BUDGET_TOKENS)
  })

  it('uses pressure budget when RSS ratio >= 0.7', () => {
    const budget = createTurnBudget(0.75)
    assert.equal(budget.maxTokensPerTurn, PRESSURE_BUDGET_TOKENS)
  })

  it('uses zero budget when RSS ratio >= 0.85', () => {
    const budget = createTurnBudget(0.9)
    assert.equal(budget.maxTokensPerTurn, 0)
  })

  it('tracks consumption and reports exhaustion', () => {
    const budget = createTurnBudget(0.5)
    assert.equal(budget.isExhausted(), false)

    budget.consume(30_000)
    assert.equal(budget.isExhausted(), false)
    assert.equal(budget.usedTokens, 30_000)

    budget.consume(25_000)
    assert.equal(budget.isExhausted(), true)
  })

  it('reset clears used tokens', () => {
    const budget = createTurnBudget(0.5)
    budget.consume(40_000)
    budget.reset()
    assert.equal(budget.usedTokens, 0)
    assert.equal(budget.isExhausted(), false)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`./node_modules/.bin/tsx --test src/agent/__tests__/turn-budget.test.ts`
预期：FAIL — module not found

- [ ] **步骤 3：实现 TurnBudget**

创建 `src/agent/turn-budget.ts`：

```typescript
export const BASE_BUDGET_TOKENS = 50_000
export const PRESSURE_BUDGET_TOKENS = 25_000
const CRITICAL_RSS_RATIO = 0.85

export interface TurnBudget {
  readonly maxTokensPerTurn: number
  readonly usedTokens: number
  isExhausted(): boolean
  consume(tokens: number): void
  reset(): void
}

export function createTurnBudget(rssRatio: number): TurnBudget {
  const maxTokensPerTurn = rssRatio >= CRITICAL_RSS_RATIO
    ? 0
    : rssRatio >= 0.7
      ? PRESSURE_BUDGET_TOKENS
      : BASE_BUDGET_TOKENS
  let used = 0
  return {
    maxTokensPerTurn,
    get usedTokens() { return used },
    isExhausted() { return used >= maxTokensPerTurn },
    consume(tokens: number) { used += tokens },
    reset() { used = 0 },
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`./node_modules/.bin/tsx --test src/agent/__tests__/turn-budget.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/turn-budget.ts src/agent/__tests__/turn-budget.test.ts
git commit -m "feat(agent): add TurnBudget — per-turn token budget with RSS-driven pressure scaling"
```

---
## 任务 5：第二道防线 — tool-pipeline 集成轮预算

**文件：**
- 修改：`src/agent/tool-pipeline.ts:60-100,313-340`

- [ ] **步骤 1：在 ToolPipelineDeps 中加入 turnBudget**

修改 `src/agent/tool-pipeline.ts`，在 `ToolPipelineDeps` 接口中加入：

```typescript
import type { TurnBudget } from './turn-budget.js'

// 在 ToolPipelineDeps 接口中加入：
  turnBudget: TurnBudget
```

- [ ] **步骤 2：在 truncateSuccessfulToolResult 之后加预算检查**

在 `tool-pipeline.ts` 第 327 行（`finalContent = truncateSuccessfulToolResult(...)` 之后）加入：

```typescript
    // Turn budget gate: degrade to reference if budget exhausted
    if (!harnessResult.isError) {
      const tokenEstimate = Math.ceil(finalContent.length / 4)
      deps.turnBudget.consume(tokenEstimate)
      if (deps.turnBudget.isExhausted()) {
        const preview = finalContent.slice(0, 500)
        const refPath = rawToolResult?.rawPath ?? 'unknown'
        finalContent = `<stored ref="${refPath}" chars=${finalContent.length} tool="${tu.name}">\n${preview}\n...(turn budget exceeded — use read_file with offset/limit for full content)</stored>`
      }
    }
```

- [ ] **步骤 3：运行 typecheck 验证编译通过**

运行：`npx tsc --noEmit`
预期：无错误（可能需要在 loop.ts 中传入 turnBudget，下一任务处理）

- [ ] **步骤 4：Commit**

```bash
git add src/agent/tool-pipeline.ts
git commit -m "feat(agent): integrate turn budget gate into tool pipeline"
```

---

## 任务 6：第二道防线 — loop.ts 集成轮预算

**文件：**
- 修改：`src/agent/loop.ts`

- [ ] **步骤 1：在 loop.ts 中创建和管理 turnBudget**

在 loop.ts 的 imports 中加入：

```typescript
import { createTurnBudget, type TurnBudget } from './turn-budget.js'
```

在 AgentLoop 类的私有属性中加入：

```typescript
  private turnBudget: TurnBudget = createTurnBudget(0)
```

- [ ] **步骤 2：每轮开始时 reset 预算**

在 loop.ts 的主循环中（`for (let turn = 0; ...` 循环体开头），在 `const estTokens = ...` 之前加入：

```typescript
        // Reset turn budget with current RSS pressure
        const rssRatio = this.latestResourceSnapshot
          ? this.latestResourceSnapshot.memory.rssBytes / this.latestResourceSnapshot.memory.memoryLimitBytes
          : 0
        this.turnBudget = createTurnBudget(rssRatio)
```

- [ ] **步骤 3：将 turnBudget 传入 tool-pipeline deps**

找到 `executeToolUse` 的调用点，确保 deps 中包含 `turnBudget: this.turnBudget`。

- [ ] **步骤 4：运行 typecheck**

运行：`npx tsc --noEmit`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/loop.ts
git commit -m "feat(agent): wire turn budget into agent loop — reset per turn with RSS ratio"
```

---

## 任务 7：第三道防线 — 轮末主动压缩模块

**文件：**
- 新建：`src/compact/stale-round.ts`
- 新建：`src/compact/__tests__/stale-round.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `src/compact/__tests__/stale-round.test.ts`：

```typescript
import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { compactStaleRounds } from '../stale-round.js'
import type { Message } from '../../api/types.js'

describe('compactStaleRounds', () => {
  function makeToolResultMessage(content: string): Message {
    return {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content }],
    }
  }

  function makeAssistantMessage(text: string): Message {
    return { role: 'assistant', content: [{ type: 'text', text }] }
  }

  it('preserves cache anchor messages (first 2)', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      makeAssistantMessage('hi'),
      makeToolResultMessage('x'.repeat(5000)),
      makeAssistantMessage('done'),
      makeToolResultMessage('y'.repeat(5000)),
      makeAssistantMessage('final'),
    ]
    const result = compactStaleRounds(messages, 1_000_000)
    // First 2 messages unchanged
    assert.strictEqual(result[0], messages[0])
    assert.strictEqual(result[1], messages[1])
  })

  it('compacts tool_result in stale rounds (N-2+) to 1200 chars', () => {
    const messages: Message[] = [
      { role: 'user', content: 'anchor1' },
      makeAssistantMessage('anchor2'),
      // Round 1 (stale — N-2)
      makeToolResultMessage('A'.repeat(5000)),
      makeAssistantMessage('round1'),
      // Round 2 (recent — N-1)
      makeToolResultMessage('B'.repeat(5000)),
      makeAssistantMessage('round2'),
      // Round 3 (current — N)
      makeToolResultMessage('C'.repeat(5000)),
      makeAssistantMessage('round3'),
    ]
    const result = compactStaleRounds(messages, 1_000_000)
    // Stale round tool_result should be compacted
    const staleBlock = (result[2]!.content as any[])[0]
    assert.ok(staleBlock.content.length <= 1400) // 1200 + wrapper overhead
    // Recent rounds should be untouched
    const recentBlock = (result[4]!.content as any[])[0]
    assert.strictEqual(recentBlock.content.length, 5000)
    const currentBlock = (result[6]!.content as any[])[0]
    assert.strictEqual(currentBlock.content.length, 5000)
  })

  it('returns messages unchanged if all are recent', () => {
    const messages: Message[] = [
      { role: 'user', content: 'anchor1' },
      makeAssistantMessage('anchor2'),
      makeToolResultMessage('short'),
      makeAssistantMessage('done'),
    ]
    const result = compactStaleRounds(messages, 1_000_000)
    assert.deepStrictEqual(result, messages)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`./node_modules/.bin/tsx --test src/compact/__tests__/stale-round.test.ts`
预期：FAIL — module not found

- [ ] **步骤 3：实现 stale-round.ts**

创建 `src/compact/stale-round.ts`：

```typescript
import type { Message } from '../api/types.js'
import { CACHE_ANCHOR_MESSAGES, compactThresholds } from './constants.js'

const STALE_PREVIEW_CHARS = 1_200
const RECENT_ROUNDS_TO_KEEP = 2 // keep N and N-1 intact

export function compactStaleRounds(messages: Message[], contextWindow: number): Message[] {
  if (messages.length <= CACHE_ANCHOR_MESSAGES + RECENT_ROUNDS_TO_KEEP * 2) {
    return messages
  }

  // Find boundary: last (RECENT_ROUNDS_TO_KEEP * 2) messages are "recent"
  const recentStart = Math.max(
    CACHE_ANCHOR_MESSAGES,
    messages.length - RECENT_ROUNDS_TO_KEEP * 2,
  )

  let changed = false
  const result = messages.map((msg, idx) => {
    if (idx < CACHE_ANCHOR_MESSAGES || idx >= recentStart) return msg
    if (!Array.isArray(msg.content)) return msg

    let msgChanged = false
    const blocks = msg.content.map((block: any) => {
      if (block.type !== 'tool_result') return block
      if (typeof block.content !== 'string') return block
      if (block.content.length <= STALE_PREVIEW_CHARS) return block

      msgChanged = true
      return {
        ...block,
        content: block.content.slice(0, STALE_PREVIEW_CHARS) +
          `\n<stale-compacted removed_chars="${block.content.length - STALE_PREVIEW_CHARS}" />`,
      }
    })

    if (msgChanged) {
      changed = true
      return { ...msg, content: blocks }
    }
    return msg
  })

  return changed ? result : messages
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`./node_modules/.bin/tsx --test src/compact/__tests__/stale-round.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/compact/stale-round.ts src/compact/__tests__/stale-round.test.ts
git commit -m "feat(compact): add stale-round compaction — truncate N-2+ tool_result to 1200 chars"
```

---
## 任务 8：第三道防线 — loop.ts 集成轮末压缩

**文件：**
- 修改：`src/agent/loop.ts`

- [ ] **步骤 1：在 loop.ts 中 import stale-round**

```typescript
import { compactStaleRounds } from '../compact/stale-round.js'
```

- [ ] **步骤 2：在主循环中加入轮末压缩调用**

在 loop.ts 主循环中，`maybeCompact` 调用之后（约第 692 行 `if (compactResult.compacted) this.lastCompactTurn = turn` 之后）加入：

```typescript
        // Stale round compaction: proactively shrink N-2+ tool_results
        if (!compactResult.compacted) {
          const before = this.session.getMessages()
          const after = compactStaleRounds(before, this.config.contextWindow ?? 1_000_000)
          if (after !== before) {
            this.session.replaceMessages(after)
          }
        }
```

逻辑：如果本轮没有触发 smartCompact/microCompact，则执行轮末压缩。两者互斥避免重复。

- [ ] **步骤 3：运行 typecheck**

运行：`npx tsc --noEmit`
预期：PASS

- [ ] **步骤 4：Commit**

```bash
git add src/agent/loop.ts
git commit -m "feat(agent): wire stale-round compaction into loop — runs when maybeCompact skips"
```

---

## 任务 9：集成测试 — 模拟多轮对话验证内存增长

**文件：**
- 新建：`src/agent/__tests__/memory-safety-integration.test.ts`

- [ ] **步骤 1：编写集成测试**

创建 `src/agent/__tests__/memory-safety-integration.test.ts`：

```typescript
import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { createTurnBudget, BASE_BUDGET_TOKENS } from '../turn-budget.js'
import { compactStaleRounds } from '../../compact/stale-round.js'
import { estimateTokens } from '../../compact/micro.js'
import type { Message } from '../../api/types.js'

describe('memory safety integration', () => {
  it('messages array stays bounded after 10 simulated turns', () => {
    const messages: Message[] = [
      { role: 'user', content: 'initial request' },
      { role: 'assistant', content: [{ type: 'text', text: 'I will help' }] },
    ]

    // Simulate 10 turns, each with 5 tool calls returning 4000 chars
    for (let turn = 0; turn < 10; turn++) {
      const budget = createTurnBudget(0.3) // low pressure

      for (let tool = 0; tool < 5; tool++) {
        const toolContent = `result-${turn}-${tool}: ${'x'.repeat(4000)}`
        const tokenEst = Math.ceil(toolContent.length / 4)
        budget.consume(tokenEst)

        const content = budget.isExhausted()
          ? `<stored ref="/tmp/test" chars=${toolContent.length}>preview</stored>`
          : toolContent

        messages.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: `tu_${turn}_${tool}`, content }],
        })
      }

      messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: `turn ${turn} done` }],
      })

      // Apply stale round compaction
      const compacted = compactStaleRounds(messages, 1_000_000)
      messages.length = 0
      messages.push(...compacted)
    }

    const totalTokens = estimateTokens(messages)
    // Without safety: 10 turns × 5 tools × 4000 chars = 200K chars = ~50K tokens
    // With safety: budget caps + stale compaction should keep it much lower
    assert.ok(totalTokens < 30_000, `Expected <30K tokens, got ${totalTokens}`)
    assert.ok(messages.length > 4, 'Should still have meaningful messages')
  })

  it('turn budget degrades under high RSS pressure', () => {
    const normalBudget = createTurnBudget(0.5)
    const pressureBudget = createTurnBudget(0.75)
    const criticalBudget = createTurnBudget(0.9)

    assert.strictEqual(normalBudget.maxTokensPerTurn, BASE_BUDGET_TOKENS)
    assert.ok(pressureBudget.maxTokensPerTurn < normalBudget.maxTokensPerTurn)
    assert.strictEqual(criticalBudget.maxTokensPerTurn, 0)
  })
})
```

- [ ] **步骤 2：运行集成测试**

运行：`./node_modules/.bin/tsx --test src/agent/__tests__/memory-safety-integration.test.ts`
预期：PASS

- [ ] **步骤 3：运行全量测试确认无回归**

运行：`npm test`
预期：全部通过（2340+ tests）

- [ ] **步骤 4：Commit**

```bash
git add src/agent/__tests__/memory-safety-integration.test.ts
git commit -m "test(agent): add memory safety integration test — verify bounded growth over 10 turns"
```

---

## 任务 10：全量验证 + typecheck

- [ ] **步骤 1：TypeScript 编译检查**

运行：`npx tsc --noEmit`
预期：0 errors

- [ ] **步骤 2：全量测试**

运行：`npm test`
预期：全部通过

- [ ] **步骤 3：手动验证 — 读取大文件**

运行：`node dist/main.js` 然后让模型尝试 `read_file` 一个 >100KB 的文件（不带 offset/limit）
预期：返回 "File too large" 错误提示

---

## 自检结果

**规格覆盖度：**
- ✅ 第一道防线：read_file 大小预检（任务 1）
- ✅ 第一道防线：bash stdout 收紧（任务 2）
- ✅ 第一道防线：grep 输出收紧（任务 3）
- ✅ 第二道防线：TurnBudget 模块（任务 4）
- ✅ 第二道防线：tool-pipeline 集成（任务 5）
- ✅ 第二道防线：loop.ts 集成（任务 6）
- ✅ 第三道防线：stale-round 模块（任务 7）
- ✅ 第三道防线：loop.ts 集成（任务 8）
- ✅ 集成验证（任务 9-10）

**占位符扫描：** 无 TODO/待定

**类型一致性：**
- `TurnBudget` 接口在任务 4 定义，任务 5/6/9 中使用一致
- `compactStaleRounds` 在任务 7 定义，任务 8/9 中使用一致
- `createTurnBudget(rssRatio: number)` 签名在所有引用处一致
