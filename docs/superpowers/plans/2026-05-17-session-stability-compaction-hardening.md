# 会话稳定性三层加固 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 消除 Rivet 会话 compaction 的三个已知缺陷——Tier 3 分发空洞、compaction 后状态丢失、doom loop 被动告警

**架构：** 三阶段改进：(1) 让 Tier 3（88%）真正触发 reactive round summarization 而非和 Tier 2 走相同路径；(2) compaction 前后保护 durable claims 不丢失；(3) doom loop 从被动告警升级为主动打断 + 强制 compaction

**技术栈：** TypeScript, Vitest, 现有 compact-policy / smartCompact / trace-store / claim-store 基础设施

---

## 文件结构

| 文件 | 职责 | 变更类型 |
|------|------|----------|
| `src/context/compact-policy.ts` | compaction tier 判定 | 修改：Tier 3 返回 `reactive` 标记 |
| `src/compact/types.ts` | compact decision 类型 | 修改：加 `reactive` 字段 |
| `src/agent/loop.ts:414-435` | compaction 分发逻辑 | 修改：Tier 3 走 reactive 路径 |
| `src/compact/auto.ts:129` | smartCompact | 修改：接受 `reactive` 选项 |
| `src/context/claim-store.ts:213` | durable claims 查询 | 新增：`snapshotDurableClaims()` |
| `src/compact/snapshot.ts` | protected state 快照 | 新建：compaction 前后状态同步 |
| `src/compact/__tests__/snapshot.test.ts` | 快照测试 | 新建 |
| `src/agent/trace-store.ts:88` | doom loop 检测 | 已有，无需修改 |
| `src/agent/loop.ts` turn end | doom loop 打断 | 修改：turn end 检查 + 强制 compaction |

---

## Phase 1：Tier 3 compaction 生效

### 任务 1：CompactDecision 类型加 reactive 标记

**文件：**
- 修改：`src/compact/types.ts`

- [ ] **步骤 1：修改 CompactDecision 类型**

读取 `src/compact/types.ts`，找到 `CompactDecision` 类型，加 `reactive` 字段：

```typescript
export interface CompactDecision {
  tier: CompactTier
  reason: string
  shouldCompact: boolean
  reactive?: boolean  // Tier 3: reactive round summarization
}
```

- [ ] **步骤 2：运行 typecheck 确认无破坏**

运行：`npx tsc --noEmit`
预期：PASS（新字段是 optional，不影响现有调用）

- [ ] **步骤 3：Commit**

```bash
git add src/compact/types.ts
git commit -m "refactor(compact): add reactive flag to CompactDecision type"
```

### 任务 2：decideCompactTier 为 Tier 3 设置 reactive 标记

**文件：**
- 修改：`src/context/compact-policy.ts:18-33`
- 测试：`src/context/__tests__/compact-policy.test.ts`（如不存在则新建）

- [ ] **步骤 1：编写失败的测试**

```typescript
import { describe, it, expect } from 'vitest'
import { decideCompactTier, tierForRatio } from '../compact-policy.js'

describe('decideCompactTier', () => {
  it('marks tier 3 as reactive', () => {
    const result = decideCompactTier({
      estimatedTokens: 8800,
      maxTokens: 10000,
      turn: 5,
      failures: { consecutiveFailures: 0 },
    })
    expect(result.tier).toBe(3)
    expect(result.reactive).toBe(true)
    expect(result.shouldCompact).toBe(true)
  })

  it('does not mark tier 2 as reactive', () => {
    const result = decideCompactTier({
      estimatedTokens: 7800,
      maxTokens: 10000,
      turn: 5,
      failures: { consecutiveFailures: 0 },
    })
    expect(result.tier).toBe(2)
    expect(result.reactive).toBeFalsy()
  })

  it('does not mark tier 4 as reactive', () => {
    const result = decideCompactTier({
      estimatedTokens: 9500,
      maxTokens: 10000,
      turn: 5,
      failures: { consecutiveFailures: 0 },
    })
    expect(result.tier).toBe(4)
    expect(result.reactive).toBeFalsy()
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/context/__tests__/compact-policy.test.ts`
预期：FAIL — `expected undefined to be true`

- [ ] **步骤 3：修改 decideCompactTier**

```typescript
export function decideCompactTier(input: CompactPolicyInput): CompactDecision {
  if (input.failures.disabledUntilTurn !== undefined && input.turn < input.failures.disabledUntilTurn) {
    return { tier: 0, reason: 'automatic compact circuit breaker is open', shouldCompact: false }
  }
  const ratio = input.maxTokens > 0 ? input.estimatedTokens / input.maxTokens : 1
  const tier = tierForRatio(ratio)
  return {
    tier,
    reason: reasonForTier(tier),
    shouldCompact: tier > 0,
    reactive: tier === 3,
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/context/__tests__/compact-policy.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/context/compact-policy.ts src/context/__tests__/compact-policy.test.ts
git commit -m "fix(compact): mark tier 3 as reactive in decideCompactTier"
```

### 任务 3：smartCompact 接受 reactive 选项

**文件：**
- 修改：`src/compact/auto.ts:129-200`

- [ ] **步骤 1：给 smartCompact 加 options 参数**

当前签名：`smartCompact(client, messages, tokenCount, contextWindow, compactModel)`

改为：

```typescript
export interface SmartCompactOptions {
  reactive?: boolean  // Tier 3: 更激进的 round selection
}

export async function smartCompact(
  client: StreamClient,
  messages: Message[],
  tokenCount: number,
  contextWindow: number,
  compactModel: string,
  options?: SmartCompactOptions,
): Promise<CompactResult> {
```

- [ ] **步骤 2：在 selectReactiveCompactRounds 调用处使用 reactive 选项**

找到 `auto.ts:178` 的 `selectReactiveCompactRounds` 调用，改为：

```typescript
  const selectedRounds = selectReactiveCompactRounds(messages, {
    anchorMessages: CACHE_ANCHOR_MESSAGES,
    recentMessages: options?.reactive ? 2 : KEEP_RECENT_MESSAGES,  // reactive 模式多保留近期消息
  })
```

- [ ] **步骤 3：运行 typecheck**

运行：`npx tsc --noEmit`
预期：PASS（新参数 optional，不破坏现有调用）

- [ ] **步骤 4：Commit**

```bash
git add src/compact/auto.ts
git commit -m "feat(compact): smartCompact accepts reactive option for aggressive round selection"
```

### 任务 4：loop.ts Tier 3 分发逻辑

**文件：**
- 修改：`src/agent/loop.ts:414-435`

- [ ] **步骤 1：修改 compactMessages 和分发逻辑**

在 `AgentLoop` 类中，修改 `compactMessages` 方法签名，加 `reactive` 参数：

```typescript
  private async compactMessages(
    messages: Message[],
    tokenCount: number,
    reactive = false,
  ): Promise<{ messages: Message[] }> {
    if (this.config.compactClient && this.config.compactModel) {
      const result = await smartCompact(
        this.config.compactClient,
        messages,
        tokenCount,
        this.config.contextWindow,
        this.config.compactModel,
        { reactive },
      )
      return { messages: result.messages }
    }
    return microCompact(messages, this.config.contextWindow, tokenCount)
  }
```

然后修改 turn loop 里的分发逻辑（line 414-435）：

```typescript
        if (compactDecision.shouldCompact) {
          const beforeTokens = estTokens
          try {
            const { messages: compacted } = await this.compactMessages(
              messages,
              estTokens,
              compactDecision.reactive,
            )
            this.session.replaceMessages(compacted)
            this.session.markCompacted(turn)
            const afterTokens = this.session.getEstimatedTokens()
            this.session.recordCompactEvent({
              turn: this.session.getTurnCount(),
              tier: compactDecision.reactive ? 3 : (this.config.compactClient ? 2 : 1),
              reason: `auto compact: ${compactDecision.reason}`,
              beforeTokens,
              afterTokens,
              createdAt: Date.now(),
            })
            this.compactFailures = recordCompactSuccess(this.compactFailures)
            this.refreshLedger()
          } catch (err) {
            this.compactFailures = recordCompactFailure(this.compactFailures, this.session.getTurnCount())
            throw err
          }
        }
```

- [ ] **步骤 2：运行 typecheck**

运行：`npx tsc --noEmit`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add src/agent/loop.ts
git commit -m "fix(compact): tier 3 now routes to reactive compact instead of same path as tier 2"
```

---

## Phase 2：Protected state compaction-safe zone

### 任务 5：claimStore 快照接口

**文件：**
- 修改：`src/context/claim-store.ts`
- 新建：`src/compact/snapshot.ts`
- 新建：`src/compact/__tests__/snapshot.test.ts`

- [ ] **步骤 1：在 claim-store.ts 加 snapshotDurableClaims**

找到 `ContextClaimStore` 类，加方法：

```typescript
  snapshotDurableClaims(): ContextClaim[] {
    return this.getDurableClaims()  // 复用已有方法
  }

  reinjectClaims(claims: ContextClaim[]): void {
    for (const claim of claims) {
      if (claim.status === 'durable') {
        this.propose({
          kind: claim.kind,
          scope: claim.scope,
          text: claim.text,
          confidence: claim.confidence,
          fitness: claim.fitness,
          source: claim.source,
          createdAt: claim.createdAt,
          tags: [...(claim.tags ?? []), 'compaction-survivor'],
        })
      }
    }
  }
```

- [ ] **步骤 2：编写快照测试**

```typescript
import { describe, it, expect } from 'vitest'
import { ContextClaimStore } from '../../context/claim-store.js'
import { snapshotBeforeCompact, reinjectAfterCompact } from '../snapshot.js'

describe('compaction snapshot', () => {
  it('preserves durable claims across compaction', () => {
    const store = new ContextClaimStore('test-session')
    // Propose some claims
    store.propose({
      kind: 'user_constraint',
      scope: 'session',
      text: 'Never use rm -rf',
      confidence: 1.0,
      fitness: 5,
      source: { actor: 'user', sessionId: 'test', turn: 1, eventId: 'u1' },
      createdAt: Date.now(),
    })
    // Promote to durable
    store.promoteEligibleClaims()
    const before = store.snapshotDurableClaims()
    expect(before.length).toBeGreaterThanOrEqual(1)

    // Simulate compaction: snapshot + reinject
    const snapshot = snapshotBeforeCompact(store)
    // After compaction, reinject
    reinjectAfterCompact(store, snapshot)
    const after = store.listActiveClaims()
    expect(after.some(c => c.text === 'Never use rm -rf')).toBe(true)
  })
})
```

- [ ] **步骤 3：运行测试验证失败**

运行：`npx vitest run src/compact/__tests__/snapshot.test.ts`
预期：FAIL — `snapshotBeforeCompact` 不存在

- [ ] **步骤 4���实现 snapshot.ts**

```typescript
import type { ContextClaimStore } from '../context/claim-store.js'
import type { ContextClaim } from '../context/types.js'

export interface CompactSnapshot {
  durableClaims: ContextClaim[]
}

export function snapshotBeforeCompact(store: ContextClaimStore): CompactSnapshot {
  return {
    durableClaims: store.snapshotDurableClaims(),
  }
}

export function reinjectAfterCompact(store: ContextClaimStore, snapshot: CompactSnapshot): void {
  store.reinjectClaims(snapshot.durableClaims)
}
```

- [ ] **步骤 5：运行测试验证通过**

运行：`npx vitest run src/compact/__tests__/snapshot.test.ts`
预期：PASS

- [ ] **步骤 6：Commit**

```bash
git add src/context/claim-store.ts src/compact/snapshot.ts src/compact/__tests__/snapshot.test.ts
git commit -m "feat(compact): add durable claim snapshot/reinject for compaction safety"
```

### 任务 6：在 smartCompact 中使用快照

**文件：**
- 修改：`src/compact/auto.ts:129-200`
- 修改：`src/agent/loop.ts:250-265`

- [ ] **步骤 1：修改 compactMessages 集成快照**

在 `loop.ts` 的 `compactMessages` 方法中，加 claim 快照逻辑：

```typescript
  private async compactMessages(
    messages: Message[],
    tokenCount: number,
    reactive = false,
  ): Promise<{ messages: Message[] }> {
    // Snapshot durable claims before compaction
    const snapshot = this.config.contextClaimStore
      ? snapshotBeforeCompact(this.config.contextClaimStore)
      : null

    let result: { messages: Message[] }
    if (this.config.compactClient && this.config.compactModel) {
      const compactResult = await smartCompact(
        this.config.compactClient,
        messages,
        tokenCount,
        this.config.contextWindow,
        this.config.compactModel,
        { reactive },
      )
      result = { messages: compactResult.messages }
    } else {
      result = await microCompact(messages, this.config.contextWindow, tokenCount)
    }

    // Reinject durable claims after compaction
    if (snapshot && this.config.contextClaimStore) {
      reinjectAfterCompact(this.config.contextClaimStore, snapshot)
    }

    return result
  }
```

- [ ] **步骤 2：运行 typecheck**

运行：`npx tsc --noEmit`
预期：PASS

- [ ] **步骤 3：运行全量测试**

运行：`npx vitest run`
预期：无新增失败

- [ ] **步骤 4：Commit**

```bash
git add src/agent/loop.ts
git commit -m "feat(compact): inject durable claim snapshot around compaction calls"
```

---

## Phase 3：Doom loop 主动打断

### 任务 7：turn end 加 doom loop 检查

**文件：**
- 修改：`src/agent/loop.ts` turn end 逻辑

- [ ] **步骤 1：在 turn end 处加 doom loop 检查**

找到 turn loop 的 end 部分（在 `processTurnEnd` 调用附近），加检查：

```typescript
        // Doom loop detection: if same tool+input repeats 3+ times, inject repair hint
        const currentFingerprints = this.traceStore.toolFingerprints
        const doomLevel = getDoomLoopLevel(currentFingerprints)
        if (doomLevel === 'blocked') {
          this.repairHintTracker.setHint('检测到重复操作循环。请换一种方法或询问用户确认方向。')
          // If blocked for 2+ consecutive turns, force reactive compaction
          if (this.consecutiveDoomLoops >= 1) {
            this.config.promptEngine.setCerebellarHint(
              'Doom loop detected. Breaking cycle by forcing context refresh.',
            )
            // Force a reactive compact on next turn
            this.forceReactiveCompact = true
          }
          this.consecutiveDoomLoops++
        } else {
          this.consecutiveDoomLoops = 0
        }
```

- [ ] **步骤 2：在 AgentLoop 类加新字段**

```typescript
  private consecutiveDoomLoops = 0
  private forceReactiveCompact = false
```

- [ ] **步骤 3：在 turn loop 开头检查 forceReactiveCompact**

在 turn loop 的 compaction 检查之前，加：

```typescript
        // Force reactive compact if doom loop triggered it
        if (this.forceReactiveCompact) {
          this.forceReactiveCompact = false
          const messages = this.session.getMessages()
          const estTokens = this.session.getEstimatedTokens()
          try {
            const { messages: compacted } = await this.compactMessages(messages, estTokens, true)
            this.session.replaceMessages(compacted)
            this.session.markCompacted(turn)
            this.session.recordCompactEvent({
              turn: this.session.getTurnCount(),
              tier: 3,
              reason: 'doom loop forced reactive compact',
              beforeTokens: estTokens,
              afterTokens: this.session.getEstimatedTokens(),
              createdAt: Date.now(),
            })
            this.compactFailures = recordCompactSuccess(this.compactFailures)
            this.refreshLedger()
          } catch {
            this.compactFailures = recordCompactFailure(this.compactFailures, this.session.getTurnCount())
          }
        }
```

- [ ] **步骤 4：运行 typecheck**

运行：`npx tsc --noEmit`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/agent/loop.ts
git commit -m "feat(agent): doom loop active break with forced reactive compaction"
```

### 任务 8：全量验证

- [ ] **步骤 1：运行全量测试**

运行：`npx vitest run`
预期：无新增失败

- [ ] **步骤 2：运行 typecheck**

运行：`npx tsc --noEmit`
预期：PASS

- [ ] **步骤 3：运行 build**

运行：`npm run build`
预期：PASS

- [ ] **步骤 4：最终 Commit**

```bash
git add -A
git commit -m "feat(compact): session stability hardening — tier 3 reactive, protected state, doom loop break

Three-layer compaction hardening:
1. Tier 3 (88%) now triggers reactive round summarization instead of same path as tier 2
2. Durable claims survive compaction via snapshot/reinject mechanism
3. Doom loop detection upgrades from passive warning to active break + forced compaction

Based on Hermes/OpenCode/claude-code-haha architecture analysis."
```

---

## 自检

**1. 规格覆盖度：**
- Tier 3 compaction 生效 ✓（任务 1-4）
- Protected state compaction-safe zone ✓（任务 5-6）
- Doom loop 主动打断 ✓（任务 7）
- 全量验证 ✓（任务 8）

**2. 占位符扫描：** 无 "TODO"、"待定"、"后续实现"。所有步骤都有代码。

**3. 类型一致性：**
- `CompactDecision.reactive` 在 types.ts 定义，在 compact-policy.ts 设置，在 loop.ts 读取 ✓
- `SmartCompactOptions` 在 auto.ts 定义，在 loop.ts 使用 ✓
- `CompactSnapshot` 在 snapshot.ts 定义，在 loop.ts 使用 ✓
- `consecutiveDoomLoops` / `forceReactiveCompact` 在 loop.ts 内部使用 ✓
