# 反锚定引擎集成实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 Rebook 因果解耦机制 + CTM 调研的推理时增强方案原生集成到天枢 TUI，使 agent loop 具备模型级反锚定能力

**架构：** 三阶段渐进集成——Phase 1 harness 层反锚定 hooks（今天可做），Phase 2 推理时 MCTS 规划（RAP 式多路径探索），Phase 3 连续思考支持（等模型能力就绪后对接）

**技术栈：** TypeScript / Node.js 22 / Ink 6 / node:test / 现有 RuntimeHookPipeline

**前置文档：** [CTM 反锚定研究报告](../specs/2026-05-31-ctm-anti-anchoring-research.md)

---

## 设计原则

1. **从 Rebook 搬运核心抽象，不搬领域词汇**
   - SeedVault → AnchorVault（封存任务锚点）
   - SeedProjectionScorer → AnchorProjectionDetector（检测输出对锚点的投影率）
   - ContextFirewall → PhaseContextFilter（按 hook 阶段过滤上下文）

2. **不改 agent loop 主流程，通过 hook 注入**
   - 所有反锚定逻辑作为 RuntimeHook 插入
   - 可开关、可配置阈值、不影响现有行为

3. **渐进生效**
   - Phase 1 只做检测 + 警告（不阻断）
   - 阈值调优后再切换为阻断 + 触发发散

---

## 文件结构

```
src/agent/hooks/
├── anchor-vault-hook.ts       # AnchorVault: 封存/解封任务锚点
├── projection-detector-hook.ts # 检测输出对锚点的投影率
├── blind-exploration-hook.ts   # seedFree 探索阶段控制
└── mcts-planning-hook.ts       # Phase 2: 多路径规划

src/agent/
├── anchor-vault.ts             # AnchorVault 服务（seal/unseal/strip）
├── projection-scorer.ts        # n-gram 投影率评分
└── mcts-planner.ts             # Phase 2: MCTS 规划器

src/agent/__tests__/
├── anchor-vault.test.ts
├── projection-scorer.test.ts
├── blind-exploration-hook.test.ts
└── mcts-planner.test.ts
```

---

## Phase 1：Harness 层反锚定（可立即实施）

### 核心映射

| Rebook 概念 | 天枢集成 | 触发时机 |
|-------------|----------|----------|
| SeedVault.seal() | AnchorVault.seal(userMessage) | preTurn hook，首轮 |
| SeedVault.strip() | PhaseContextFilter.strip(ctx, phase) | afterPerception hook |
| 投影率检测 | AnchorProjectionDetector.score(output, anchor) | postTool hook |
| 删除测试 | AnchorProjectionDetector.deletionTest(plan) | postTurn hook（规划完成时） |
| seedFree step | BlindExplorationHook（不注入 anchor 的探索 turn） | preTurn hook，配置条件 |

---

### 任务 1：AnchorVault 服务

**文件：**
- 创建：`src/agent/anchor-vault.ts`
- 测试：`src/agent/__tests__/anchor-vault.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AnchorVault } from '../anchor-vault.js'

describe('AnchorVault', () => {
  it('seal extracts key phrases from user message', () => {
    const vault = new AnchorVault()
    const sealed = vault.seal('帮我重构 auth 模块，要支持 OAuth2 和 SAML')
    assert.ok(sealed.phrases.length > 0)
    assert.ok(sealed.phrases.some(p => p.includes('auth') || p.includes('OAuth2')))
  })

  it('strip removes anchor phrases from context string', () => {
    const vault = new AnchorVault()
    const sealed = vault.seal('重构 auth 模块支持 OAuth2')
    const ctx = '当前正在分析 auth 模块的 OAuth2 实现'
    const stripped = vault.strip(ctx, sealed)
    assert.ok(!stripped.includes('auth'))
    assert.ok(!stripped.includes('OAuth2'))
  })

  it('unseal restores original phrases', () => {
    const vault = new AnchorVault()
    const sealed = vault.seal('重构 auth 模块')
    const phrases = vault.unseal(sealed)
    assert.ok(phrases.some(p => p.includes('auth')))
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test src/agent/__tests__/anchor-vault.test.ts`
预期：FAIL，"Cannot find module '../anchor-vault.js'"

- [ ] **步骤 3：实现 AnchorVault**

```typescript
// src/agent/anchor-vault.ts

export interface SealedAnchor {
  phrases: string[]
  original: string
  sealedAt: number
}

export class AnchorVault {
  /**
   * Extract key phrases (nouns, identifiers, domain terms) from user message.
   * These are the "seeds" that can anchor/lock the model's attention.
   */
  seal(userMessage: string): SealedAnchor {
    // Extract: identifiers (camelCase, PascalCase, snake_case), quoted terms,
    // CJK noun phrases, technical terms (2+ chars, not stopwords)
    const identifiers = userMessage.match(/[a-zA-Z_][a-zA-Z0-9_]{2,}/g) ?? []
    const cjkTerms = userMessage.match(/[一-鿿]{2,6}/g) ?? []
    const phrases = [...new Set([...identifiers, ...cjkTerms])]
    return { phrases, original: userMessage, sealedAt: Date.now() }
  }

  /** Remove anchor phrases from a context string. */
  strip(context: string, sealed: SealedAnchor): string {
    let result = context
    for (const phrase of sealed.phrases) {
      result = result.replaceAll(phrase, '')
    }
    return result.replace(/\s{2,}/g, ' ').trim()
  }

  /** Restore sealed phrases for injection phase. */
  unseal(sealed: SealedAnchor): string[] {
    return sealed.phrases
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test src/agent/__tests__/anchor-vault.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/anchor-vault.ts src/agent/__tests__/anchor-vault.test.ts
git commit -m "feat(agent): add AnchorVault — seal/strip/unseal task anchor phrases"
```

---

### 任务 2：投影率检测器

**文件：**
- 创建：`src/agent/projection-scorer.ts`
- 测试：`src/agent/__tests__/projection-scorer.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ProjectionScorer } from '../projection-scorer.js'

describe('ProjectionScorer', () => {
  it('returns low score when output is independent of anchor', () => {
    const scorer = new ProjectionScorer()
    const anchor = ['auth', 'OAuth2', '重构']
    const output = '文件系统使用 inode 管理元数据，ext4 支持日志'
    const score = scorer.score(output, anchor)
    assert.ok(score < 0.1)
  })

  it('returns high score when output is dominated by anchor terms', () => {
    const scorer = new ProjectionScorer()
    const anchor = ['auth', 'OAuth2', '重构']
    const output = '重构 auth 需要先理解 OAuth2 的 auth flow，auth 模块重构方案如下'
    const score = scorer.score(output, anchor)
    assert.ok(score > 0.3)
  })

  it('deletionTest returns true when plan collapses without anchor', () => {
    const scorer = new ProjectionScorer()
    const anchor = ['auth', 'OAuth2']
    const plan = 'Step 1: 分析 auth 接口\nStep 2: 实现 OAuth2 flow\nStep 3: 测试 auth'
    assert.ok(scorer.deletionTest(plan, anchor))
  })

  it('deletionTest returns false when plan is self-coherent', () => {
    const scorer = new ProjectionScorer()
    const anchor = ['auth', 'OAuth2']
    const plan = 'Step 1: 定义接口契约\nStep 2: 实现 token 刷新\nStep 3: 集成测试覆盖'
    assert.ok(!scorer.deletionTest(plan, anchor))
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test src/agent/__tests__/projection-scorer.test.ts`
预期：FAIL

- [ ] **步骤 3：实现 ProjectionScorer**

```typescript
// src/agent/projection-scorer.ts

export class ProjectionScorer {
  /**
   * Score how much an output is a "projection" of anchor phrases.
   * Uses weighted bigram overlap. Returns 0.0-1.0.
   * < 0.3 = independent thinking. > 0.3 = anchor-dominated.
   */
  score(output: string, anchorPhrases: string[]): number {
    if (!output || !anchorPhrases.length) return 0
    const outputLower = output.toLowerCase()
    const outputLen = outputLower.length || 1
    let totalOverlap = 0
    for (const phrase of anchorPhrases) {
      const phraseLower = phrase.toLowerCase()
      let idx = 0
      let count = 0
      while ((idx = outputLower.indexOf(phraseLower, idx)) !== -1) {
        count++
        idx += phraseLower.length
      }
      totalOverlap += count * phraseLower.length
    }
    return Math.min(1, totalOverlap / outputLen)
  }

  /**
   * Deletion test: remove all anchor phrases from plan text.
   * If remaining text loses coherence (< 50% of original length after cleanup),
   * the plan is just a projection of the anchor — it collapses without it.
   */
  deletionTest(plan: string, anchorPhrases: string[]): boolean {
    let stripped = plan
    for (const phrase of anchorPhrases) {
      stripped = stripped.replaceAll(new RegExp(phrase, 'gi'), '')
    }
    stripped = stripped.replace(/\s{2,}/g, ' ').trim()
    // If more than 50% of content was anchor phrases, it's a projection
    return stripped.length < plan.length * 0.5
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test src/agent/__tests__/projection-scorer.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/projection-scorer.ts src/agent/__tests__/projection-scorer.test.ts
git commit -m "feat(agent): add ProjectionScorer — detect anchor-dominated output"
```

---

### 任务 3：Projection Detector Hook（接入 RuntimeHookPipeline）

**文件：**
- 创建：`src/agent/hooks/projection-detector-hook.ts`
- 修改：`src/agent/runtime-hooks.ts`（注册 hook）

- [ ] **步骤 1：编写 hook**

```typescript
// src/agent/hooks/projection-detector-hook.ts
import type { PostToolRuntimeHook } from '../runtime-hooks.js'
import { AnchorVault, type SealedAnchor } from '../anchor-vault.js'
import { ProjectionScorer } from '../projection-scorer.js'

const PROJECTION_THRESHOLD = 0.3

export function createProjectionDetectorHook(): PostToolRuntimeHook {
  const vault = new AnchorVault()
  const scorer = new ProjectionScorer()
  let sealed: SealedAnchor | null = null

  return {
    name: 'projection-detector',
    phase: 'postTool',
    run(ctx) {
      // Seal anchor on first user message
      if (!sealed && ctx.userMessage) {
        sealed = vault.seal(ctx.userMessage)
      }
      if (!sealed) return

      // Score current tool output against anchor
      const output = ctx.toolResult?.content
      if (typeof output !== 'string') return

      const score = scorer.score(output, sealed.phrases)
      if (score > PROJECTION_THRESHOLD) {
        ctx.addWarning(
          `[anti-anchor] projection score ${score.toFixed(2)} > ${PROJECTION_THRESHOLD}. ` +
          `Output may be anchor-dominated. Consider exploring alternative angles.`
        )
      }
    },
  }
}
```

- [ ] **步骤 2：注册到 RuntimeHookPipeline**

在 `src/agent/runtime-hooks.ts` 的 hook 注册列表中添加：
```typescript
import { createProjectionDetectorHook } from './hooks/projection-detector-hook.js'
// ... in hook registration:
createProjectionDetectorHook(),
```

- [ ] **步骤 3：Commit**

```bash
git add src/agent/hooks/projection-detector-hook.ts src/agent/runtime-hooks.ts
git commit -m "feat(agent): add projection-detector hook — warn on anchor-dominated output"
```

---

### 任务 4：Blind Exploration Hook（seedFree 探索阶段）

**文件：**
- 创建：`src/agent/hooks/blind-exploration-hook.ts`

- [ ] **步骤 1：实现 hook**

```typescript
// src/agent/hooks/blind-exploration-hook.ts
import type { PreTurnRuntimeHook } from '../runtime-hooks.js'
import { AnchorVault, type SealedAnchor } from '../anchor-vault.js'

/**
 * Blind Exploration Hook — implements the "seedFree" concept from Rebook.
 *
 * On configurable turns (e.g. turn 1 of a planning task), strips anchor
 * phrases from the context so the model explores the problem space
 * without being locked to the user's first framing.
 *
 * Maps to: CTM's decoupled internal ticks / COCONUT's latent-space reasoning /
 * Pause tokens' extra computation before committing.
 */
export function createBlindExplorationHook(opts: {
  enabledOnTurns?: number[]  // which turns to activate (default: [1])
  taskTypes?: string[]       // only for planning/exploration tasks
}): PreTurnRuntimeHook {
  const vault = new AnchorVault()
  const activeTurns = new Set(opts.enabledOnTurns ?? [1])
  let sealed: SealedAnchor | null = null

  return {
    name: 'blind-exploration',
    phase: 'preTurn',
    run(ctx) {
      // Seal on first encounter
      if (!sealed && ctx.userMessage) {
        sealed = vault.seal(ctx.userMessage)
      }
      if (!sealed) return
      if (!activeTurns.has(ctx.turnNumber)) return

      // Strip anchor from system context for this turn
      if (ctx.systemContext) {
        ctx.systemContext = vault.strip(ctx.systemContext, sealed)
      }

      // Inject exploration directive
      ctx.addSystemNote(
        '[blind-exploration] This turn: explore the problem space broadly. ' +
        'Do not fixate on the most obvious interpretation. ' +
        'Consider alternative framings, adjacent problems, and non-obvious angles.'
      )
    },
  }
}
```

- [ ] **步骤 2：Commit**

```bash
git add src/agent/hooks/blind-exploration-hook.ts
git commit -m "feat(agent): add blind-exploration hook — seedFree exploration turns"
```

---

## Phase 2：推理时 MCTS 规划（RAP 式多路径探索）

### 设计

在 agent loop 的规划阶段，不直接让模型输出计划，而是：

1. 用 3-5 次轻量 API 调用生成候选路径（exploration）
2. 对每条路径用启发式评估（reward estimation）
3. 选最优路径执行（exploitation）
4. 如果执行中发现路径不好，回溯到分支点（backtrack）

```
用户任务 → [AnchorVault.seal]
         → [Blind Exploration: 生成 3-5 条候选路径]
         → [Reward Scoring: 评估每条路径]
         → [Select: 选最优]
         → [Execute: 正常 agent loop]
         → [PostTurn: deletionTest 验证计划独立性]
```

### 任务 5：MCTS Planner 核心

**文件：**
- 创建：`src/agent/mcts-planner.ts`
- 测试：`src/agent/__tests__/mcts-planner.test.ts`

- [ ] **步骤 1：编写测试**

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MCTSPlanner, type PlanCandidate } from '../mcts-planner.js'

describe('MCTSPlanner', () => {
  it('generates multiple candidate paths', async () => {
    const mockExplore = async (prompt: string) => `Path: ${prompt.slice(0, 10)}`
    const planner = new MCTSPlanner({ explore: mockExplore, branches: 3 })
    const candidates = await planner.expand('重构 auth 模块')
    assert.equal(candidates.length, 3)
  })

  it('scores candidates by independence from anchor', async () => {
    const planner = new MCTSPlanner({
      explore: async () => 'independent analysis of token refresh patterns',
      branches: 2,
    })
    const candidates = await planner.expand('auth OAuth2')
    const scored = planner.score(candidates, ['auth', 'OAuth2'])
    assert.ok(scored.every(c => c.projectionScore < 0.3))
  })

  it('selects lowest-projection candidate', async () => {
    const candidates: PlanCandidate[] = [
      { text: 'auth auth auth', projectionScore: 0.8 },
      { text: 'token refresh via PKCE flow', projectionScore: 0.1 },
    ]
    const best = MCTSPlanner.select(candidates)
    assert.ok(best.text.includes('PKCE'))
  })
})
```

- [ ] **步骤 2：实现**

```typescript
// src/agent/mcts-planner.ts
import { ProjectionScorer } from './projection-scorer.js'

export interface PlanCandidate {
  text: string
  projectionScore: number
}

interface MCTSPlannerOpts {
  explore: (prompt: string) => Promise<string>
  branches?: number
}

export class MCTSPlanner {
  private explore: (prompt: string) => Promise<string>
  private branches: number
  private scorer = new ProjectionScorer()

  constructor(opts: MCTSPlannerOpts) {
    this.explore = opts.explore
    this.branches = opts.branches ?? 3
  }

  /** Generate N candidate paths by calling explore with varied prompts. */
  async expand(task: string): Promise<PlanCandidate[]> {
    const angles = this.generateAngles(task)
    const results = await Promise.all(
      angles.slice(0, this.branches).map(angle => this.explore(angle))
    )
    return results.map(text => ({ text, projectionScore: 0 }))
  }

  /** Score each candidate's independence from anchor phrases. */
  score(candidates: PlanCandidate[], anchorPhrases: string[]): PlanCandidate[] {
    return candidates.map(c => ({
      ...c,
      projectionScore: this.scorer.score(c.text, anchorPhrases),
    }))
  }

  /** Select the candidate with lowest projection (most independent thinking). */
  static select(candidates: PlanCandidate[]): PlanCandidate {
    return candidates.reduce((best, c) =>
      c.projectionScore < best.projectionScore ? c : best
    )
  }

  private generateAngles(task: string): string[] {
    return [
      `Explore the problem space around: ${task}. What are non-obvious aspects?`,
      `What would a contrarian approach to this look like? ${task}`,
      `Ignore the obvious solution. What adjacent problems exist near: ${task}`,
      `What constraints are implicit but unstated in: ${task}`,
      `What would fail first if we naively implement: ${task}`,
    ]
  }
}
```

- [ ] **步骤 3：运行测试**

运行：`node --test src/agent/__tests__/mcts-planner.test.ts`
预期：PASS

- [ ] **步骤 4：Commit**

```bash
git add src/agent/mcts-planner.ts src/agent/__tests__/mcts-planner.test.ts
git commit -m "feat(agent): add MCTSPlanner — multi-path exploration for task planning"
```

---

## Phase 3：连续思考对接（未来，等模型能力就绪）

### 设计方向

当 DeepSeek V4 或后续模型支持以下能力时对接：

| 模型能力 | 天枢对接方式 |
|----------|-------------|
| COCONUT 式 `<bot>`/`<eot>` 潜空间推理 | API 参数：`latent_reasoning: true`，不消耗输出 token |
| CTM 式 adaptive compute | API 参数：`min_ticks` / `max_ticks`，控制内部循环次数 |
| Pause tokens | 在 prompt 中注入 `<pause>` tokens（如果模型支持） |
| Quiet-STaR 内部 rationale | API 返回 `internal_rationale` 字段供 hook 检查 |

### 任务 6（Future）：Latent Reasoning API 适配

预留接口，不实现：

```typescript
// src/api/latent-reasoning.ts (future)
export interface LatentReasoningConfig {
  enabled: boolean
  minTicks?: number   // CTM adaptive compute lower bound
  maxTicks?: number   // CTM adaptive compute upper bound
  latentMode?: 'coconut' | 'pause' | 'quiet-star'
}
```

当模型 API 支持时，在 `src/api/client.ts` 的请求构建中注入这些参数。

---

## 集成架构总览

```
User Message
    │
    ▼
┌─────────────────────────────────────────────┐
│ preTurn: AnchorVault.seal() + BlindExploration │
│   → 封存锚点，探索 turn 不注入完整任务描述      │
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│ afterPerception: PhaseContextFilter            │
│   → 按当前 phase 过滤上下文可见性              │
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│ Agent Loop (normal tool calls)                 │
│   → MCTSPlanner.expand() on planning turns     │
│   → Normal execution on non-planning turns     │
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│ postTool: ProjectionDetector.score()           │
│   → 检测输出投影率，超阈值警告/触发发散         │
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│ postTurn: deletionTest()                       │
│   → 规划完成时验证计划独立性                    │
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│ [Future] Latent Reasoning API                  │
│   → COCONUT/CTM/Pause 模型原生支持时对接       │
└─────────────────────────────────────────────┘
```

---

## 退出条件与风险

| 风险 | 应对 |
|------|------|
| 投影率检测误报（正常输出也包含任务关键词） | Phase 1 只警告不阻断；调优阈值后再切换 |
| Blind exploration 导致模型跑偏 | 只在 turn 1 激活；turn 2+ 恢复正常上下文 |
| MCTS 多次 API 调用增加延迟 | 用轻量 prompt + 低 max_tokens 探索；只在规划阶段激活 |
| 模型不支持 latent reasoning API | Phase 3 是预留接口，不阻塞 Phase 1-2 |

---

## 实施优先级

| Phase | 内容 | 依赖 | 预估 |
|-------|------|------|------|
| 1.1 | AnchorVault + ProjectionScorer | 无 | 1h |
| 1.2 | projection-detector-hook | 1.1 | 30min |
| 1.3 | blind-exploration-hook | 1.1 | 30min |
| 2.1 | MCTSPlanner | 1.1 | 2h |
| 2.2 | mcts-planning-hook 接入 agent loop | 2.1 + 1.2 | 1h |
| 3.x | Latent Reasoning API 对接 | 模型支持 | TBD |
