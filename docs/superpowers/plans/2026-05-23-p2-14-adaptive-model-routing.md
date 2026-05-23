# P2-14: Adaptive Model Routing (Flash/Pro) 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 基于任务复杂度自动在 DeepSeek V4 Flash（便宜 12x）和 Pro（thinking）之间路由，简单任务用 Flash 省钱，复杂任务用 Pro 保质量。

**架构：** 扩展现有 `AdaptiveRouter`，新增 `TaskComplexityClassifier` 根据用户消息和工具调用模式判断复杂度。在 AgentLoop 的 turn 开始时决定本轮使用哪个模型。

**技术栈：** TypeScript / 现有 `adaptive-routing.ts` + `trace-store.ts`

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `src/agent/task-complexity.ts` | 任务复杂度分类器 |
| `src/agent/__tests__/task-complexity.test.ts` | 分类器测试 |
| `src/agent/adaptive-routing.ts` | 扩展：加入复杂度感知路由 |
| `src/agent/__tests__/adaptive-routing.test.ts` | 路由测试 |

---

### 任务 1：任务复杂度分类器

**文件：**
- 创建：`src/agent/task-complexity.ts`
- 测试：`src/agent/__tests__/task-complexity.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyComplexity, type ComplexityLevel } from '../task-complexity.js'

describe('task-complexity', () => {
  it('classifies simple read operations as low', () => {
    const result = classifyComplexity({
      userMessage: 'read the file src/foo.ts',
      recentTools: ['read_file', 'read_file'],
      turnCount: 2,
    })
    assert.equal(result, 'low')
  })

  it('classifies debugging with multiple failures as high', () => {
    const result = classifyComplexity({
      userMessage: 'fix this test that keeps failing',
      recentTools: ['bash', 'edit_file', 'bash', 'edit_file', 'bash'],
      turnCount: 8,
    })
    assert.equal(result, 'high')
  })

  it('classifies architecture questions as high', () => {
    const result = classifyComplexity({
      userMessage: 'refactor the entire module to use dependency injection',
      recentTools: [],
      turnCount: 1,
    })
    assert.equal(result, 'high')
  })

  it('classifies single file edits as low', () => {
    const result = classifyComplexity({
      userMessage: 'rename this variable from foo to bar',
      recentTools: ['read_file'],
      turnCount: 1,
    })
    assert.equal(result, 'low')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/task-complexity.test.ts`
预期：FAIL

- [ ] **步骤 3：实现分类器**

```typescript
export type ComplexityLevel = 'low' | 'high'

export interface ComplexityInput {
  userMessage: string
  recentTools: string[]
  turnCount: number
}

const HIGH_KEYWORDS = /refactor|architect|debug|redesign|migrate|fix.*fail|multiple.*file/i
const WRITE_TOOLS = new Set(['edit_file', 'write_file', 'bash'])

export function classifyComplexity(input: ComplexityInput): ComplexityLevel {
  if (HIGH_KEYWORDS.test(input.userMessage)) return 'high'

  const writeCount = input.recentTools.filter(t => WRITE_TOOLS.has(t)).length
  if (writeCount >= 3 && input.turnCount >= 5) return 'high'

  return 'low'
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/task-complexity.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/task-complexity.ts src/agent/__tests__/task-complexity.test.ts
git commit -m "feat(agent): add task complexity classifier for model routing"
```

---

### 任务 2：扩展 AdaptiveRouter 支持复杂度感知

**文件：**
- 修改：`src/agent/adaptive-routing.ts`
- 创建：`src/agent/__tests__/adaptive-routing.test.ts`

- [ ] **步骤 1：编写测试**

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AdaptiveRouter } from '../adaptive-routing.js'
import { selectModelForComplexity } from '../adaptive-routing.js'

describe('selectModelForComplexity', () => {
  it('returns flash model for low complexity', () => {
    const result = selectModelForComplexity('low', {
      flash: 'deepseek-v4-flash',
      pro: 'deepseek-v4-pro',
    })
    assert.equal(result, 'deepseek-v4-flash')
  })

  it('returns pro model for high complexity', () => {
    const result = selectModelForComplexity('high', {
      flash: 'deepseek-v4-flash',
      pro: 'deepseek-v4-pro',
    })
    assert.equal(result, 'deepseek-v4-pro')
  })
})
```

- [ ] **步骤 2：实现**

在 `adaptive-routing.ts` 末尾添加：

```typescript
import type { ComplexityLevel } from './task-complexity.js'

export interface ModelTier {
  flash: string
  pro: string
}

export function selectModelForComplexity(complexity: ComplexityLevel, tier: ModelTier): string {
  return complexity === 'high' ? tier.pro : tier.flash
}
```

- [ ] **步骤 3：运行测试**

运行：`npx tsx --test src/agent/__tests__/adaptive-routing.test.ts`
预期：PASS

- [ ] **步骤 4：Commit**

```bash
git add src/agent/adaptive-routing.ts src/agent/__tests__/adaptive-routing.test.ts
git commit -m "feat(agent): extend AdaptiveRouter with complexity-aware model selection"
```

---

### 任务 3：集成到 AgentLoop

**文件：**
- 修改：`src/agent/loop.ts`（turn 开始时调用分类器 + 路由）

- [ ] **步骤 1：在 turn 开始时调用复杂度分类**

在 AgentLoop 的 turn 处理逻辑中，API 调用前，添加模型选择：

```typescript
import { classifyComplexity } from './task-complexity.js'
import { selectModelForComplexity, type ModelTier } from './adaptive-routing.js'

// Before API call in turn processing:
const complexity = classifyComplexity({
  userMessage: lastUserMessage,
  recentTools: recentToolHistory.map(h => h.tool),
  turnCount: this.turnCount,
})
const modelTier: ModelTier | undefined = this.config.modelTier
const selectedModel = modelTier
  ? selectModelForComplexity(complexity, modelTier)
  : this.config.model
```

注意：`modelTier` 是可选配置。未配置时不做路由，使用默认 model。

- [ ] **步骤 2：在 config schema 中添加 modelTier**

在 `src/config/schema.ts` 中添加：

```typescript
modelTier: z.object({
  flash: z.string(),
  pro: z.string(),
}).optional(),
```

- [ ] **步骤 3：运行 typecheck + 全量测试**

运行：`npx tsc --noEmit && npm test`
预期：PASS

- [ ] **步骤 4：Commit**

```bash
git add src/agent/loop.ts src/config/schema.ts
git commit -m "feat(agent): integrate adaptive model routing into AgentLoop"
```
