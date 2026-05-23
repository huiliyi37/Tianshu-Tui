# P2-12: 多代理 Context Isolation 策略层实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 定义何时将任务拆分为独立 worker agent（context isolation），以及如何合并结果。基础设施已有（sub-agent + worktree + coordinator），本计划只做策略层。

**架构：** 新建 `SplitPolicy` 判断当前任务是否应拆分为多个 worker。拆分条件基于文件数量、模块边界、任务复杂度。合并策略基于 git merge（worktree 已支持）。

**技术栈：** TypeScript / 现有 `coordinator.ts` + `sub-agent.ts` + `work-order.ts`

**来源**：Devin 生产经验 — 3 个专注代理 > 1 个通才工作 3 倍时间；context isolation 比 sharing 效果好 58%

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `src/agent/split-policy.ts` | 判断是否拆分 + 如何拆分 |
| `src/agent/__tests__/split-policy.test.ts` | 策略测试 |
| `src/agent/coordinator.ts` | 修改：调用 split-policy 决定是否派发 worker |

---

### 任务 1：Split Policy

**文件：**
- 创建：`src/agent/split-policy.ts`
- 测试：`src/agent/__tests__/split-policy.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { shouldSplit, type SplitInput } from '../split-policy.js'

describe('split-policy', () => {
  it('recommends split when task touches 3+ independent modules', () => {
    const input: SplitInput = {
      targetFiles: ['src/api/client.ts', 'src/tui/app.tsx', 'src/agent/loop.ts'],
      estimatedTurns: 10,
      hasTests: true,
    }
    const result = shouldSplit(input)
    assert.equal(result.split, true)
    assert.equal(result.workers.length, 3)
  })

  it('does not split for single-module task', () => {
    const input: SplitInput = {
      targetFiles: ['src/api/client.ts', 'src/api/types.ts'],
      estimatedTurns: 3,
      hasTests: true,
    }
    const result = shouldSplit(input)
    assert.equal(result.split, false)
  })

  it('does not split for short tasks', () => {
    const input: SplitInput = {
      targetFiles: ['src/api/client.ts', 'src/tui/app.tsx', 'src/agent/loop.ts'],
      estimatedTurns: 2,
      hasTests: false,
    }
    const result = shouldSplit(input)
    assert.equal(result.split, false)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/split-policy.test.ts`
预期：FAIL

- [ ] **步骤 3：实现**

```typescript
export interface SplitInput {
  targetFiles: string[]
  estimatedTurns: number
  hasTests: boolean
}

export interface SplitWorker {
  files: string[]
  module: string
}

export interface SplitResult {
  split: boolean
  reason?: string
  workers: SplitWorker[]
}

function extractModule(filePath: string): string {
  const parts = filePath.split('/')
  // src/<module>/... → module is parts[1]
  return parts.length >= 3 ? parts[1] : parts[0]
}

const MIN_TURNS_FOR_SPLIT = 5
const MIN_MODULES_FOR_SPLIT = 3

export function shouldSplit(input: SplitInput): SplitResult {
  if (input.estimatedTurns < MIN_TURNS_FOR_SPLIT) {
    return { split: false, workers: [] }
  }

  const moduleMap = new Map<string, string[]>()
  for (const f of input.targetFiles) {
    const mod = extractModule(f)
    const files = moduleMap.get(mod) ?? []
    files.push(f)
    moduleMap.set(mod, files)
  }

  if (moduleMap.size < MIN_MODULES_FOR_SPLIT) {
    return { split: false, workers: [] }
  }

  const workers: SplitWorker[] = [...moduleMap.entries()].map(([module, files]) => ({
    module,
    files,
  }))

  return {
    split: true,
    reason: `${moduleMap.size} independent modules detected`,
    workers,
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/split-policy.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/split-policy.ts src/agent/__tests__/split-policy.test.ts
git commit -m "feat(agent): add SplitPolicy for context isolation decisions"
```

---

### 任务 2：集成到 Coordinator

**文件：**
- 修改：`src/agent/coordinator.ts`

- [ ] **步骤 1：在 coordinator 的任务分配逻辑中调用 shouldSplit**

在 coordinator 接收到新任务时，先调用 `shouldSplit()`。如果返回 `split: true`，为每个 worker 创建独立的 work-order 并派发到独立 worktree。

```typescript
import { shouldSplit } from './split-policy.js'

// In task dispatch logic:
const splitResult = shouldSplit({
  targetFiles: task.targetFiles ?? [],
  estimatedTurns: task.estimatedTurns ?? 5,
  hasTests: task.hasTests ?? false,
})

if (splitResult.split) {
  for (const worker of splitResult.workers) {
    await this.dispatchWorker({
      ...task,
      targetFiles: worker.files,
      isolatedModule: worker.module,
    })
  }
} else {
  await this.dispatchWorker(task)
}
```

- [ ] **步骤 2：运行 typecheck + coordinator 测试**

运行：`npx tsc --noEmit && npx tsx --test src/agent/__tests__/coordinator.test.ts`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add src/agent/coordinator.ts
git commit -m "feat(agent): integrate SplitPolicy into Coordinator for context isolation"
```
