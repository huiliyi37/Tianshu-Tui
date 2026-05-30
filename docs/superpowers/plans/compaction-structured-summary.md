# Compaction 结构化摘要 — 实现计划

> **面向 AI 代理：** 使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在普通 compaction（非紧急 session-split）时注入结构化摘要，替代纯截断；并将摘要写入 claim-store 供跨 turn 查询。

**架构：** 复用已有的 `buildStructuredHandoff`（9 段结构），取其 goals/progress/active-files/errors 四字段子集作为 compact 摘要格式。在 `compaction-controller.ts` 的 micro-compact 路径后追加摘要消息，通过 `SessionContext` 的 claim-store 持久化。不新增 LLM 调用——纯确定性提取。

**技术栈：** TypeScript strict，现有 `extractTaskState` + `buildStructuredHandoff` + claim-store infra

---

## 1. Scope check

本计划只做 **compaction 摘要**（Phase 2 唯一剩余项）。以下已确认不在本计划范围：

- ❌ 触发机制改为 size-gated → **已存在**：`decideCompactTier()` 用 `estimatedTokens / maxTokens` 比率
- ❌ cache TTL 对齐 → **已存在**：`adaptiveCompactPolicyRatios()` 基于 cache hit rate 动态调整
- ❌ hook 输出折叠 → Phase 1 已做完
- ❌ 跨模型独立审查 → Phase 3，条件性，需先确认用户配多模型

## 2. File structure

| 文件 | 职责 | 操作 |
|------|------|------|
| `src/agent/compaction-controller.ts` | 核心：compact 后注入摘要消息 | 修改 |
| `src/agent/task-state.ts` | 已有 `extractTaskState`，提取四字段数据 | 不改 |
| `src/context/claim-store.ts` | 已有 claim-store，存储摘要 claim | 不改（仅用其 API）|
| `src/agent/__tests__/compaction-handoff.test.ts` | 扩展：验证摘要消息注入 | 修改 |
| `src/agent/__tests__/compaction-controller.test.ts` | 扩展：验证 compact 后摘要插入位置 | 修改 |

不改的文件（只读调用）：
- `src/compact/micro.ts` — 继续用 `microCompactOai` 截断旧消息
- `src/context/compact-policy.ts` — `decideCompactTier` 触发逻辑不变

## 3. Research endorsement

### 3.1 `buildStructuredHandoff` 现状

- **位置**：`src/agent/compaction-controller.ts:57`
- **调用者**：仅 `trySessionSplit`（compaction-controller.ts:361），在 86% 上下文阈值触发
- **输入**：`StructuredHandoffInput` { taskState, turnCount, filesSeen, reasoningSnippet, errorCount, errors, toolHistory }
- **输出**：9 段 `<session-handoff>` XML 包裹文本
- **已有 4 字段**：
  - goals → `taskState.current` + `taskState.completed` + `taskState.remaining`
  - progress → `taskState.current`（当前工作）
  - active-files → `filesSeen`（最多 15 个）
  - failing-tests/errors → `errors`（最多 8 条）

### 3.2 `extractTaskState` 现状

- **位置**：`src/agent/task-state.ts:17`
- **调用者**：`compaction-controller.ts` 的 `maybeCompact` 路径
- **输出**：`TaskState { completed, current, remaining, decisions }`
- **数据来源**：trajectory entries + 模型最后一段文本（正则提取 "下一步"、"决策"、"发现"）

### 3.3 为什么不在常规 compact 用完整 handoff？

- 完整 9 段 handoff（含"最近工具轨迹"、"附录推理摘要"）体积较大（500-1500 tokens），在 60-86% 窗口时收益小于纯截断
- 4 字段子集（goals/progress/files/errors）体积 ~150-400 tokens，适合作为 compact 摘要
- 决定：**用 4 字段子集，不使用完整 9 段**

### 3.4 claim-store 写入

- `ContextClaimStore.propose(proposal)` 接受 `ClaimProposal` 类型
- 摘要 claim 的 kind 应为 `decision` 或新增 `compact_summary`
- scope 为 `session`，confidence 固定 0.9（确定性提取，非 LLM 生成）
- 已有 claim store 持久化到 `.rivet/sessions/<id>.claims.jsonl`

## 4. Tasks

### Task 1：新增 `buildCompactSummary` 函数

**创建/修改**：`src/agent/compaction-controller.ts`（在 `buildStructuredHandoff` 之后添加新函数）

**操作**：新增一个轻量函数，复用 `StructuredHandoffInput` 但只输出 4 字段：

```typescript
export function buildCompactSummary(input: StructuredHandoffInput): string {
  const taskState = input.taskState
  const parts: string[] = []
  
  // Goals：当前目标 + 剩余待办
  parts.push(`## Goals`)
  parts.push(`- Current: ${taskState.current || '（无记录）'}`)
  if (taskState.remaining.length > 0) {
    for (const item of taskState.remaining.slice(0, 5)) parts.push(`- [ ] ${item}`)
  }
  
  // Progress：已完成
  parts.push('', `## Progress`)
  if (taskState.completed.length > 0) {
    for (const item of taskState.completed.slice(-5)) parts.push(`- [x] ${item}`)
  } else {
    parts.push('-（无记录）')
  }
  
  // Active files
  parts.push('', `## Active Files`)
  if (input.filesSeen.length > 0) {
    for (const file of input.filesSeen.slice(0, 10)) parts.push(`- ${file}`)
  } else {
    parts.push('-（无记录）')
  }
  
  // Failing tests / errors
  parts.push('', `## Errors`)
  if (input.errors.length > 0) {
    for (const error of input.errors.slice(0, 5)) {
      parts.push(`- [Turn ${error.turn}] ${error.tool} ${error.target}: ${error.summary}`)
    }
  } else {
    parts.push('-（无错误）')
  }
  
  return `<compact-summary>\n${parts.join('\n')}\n</compact-summary>`
}
```

**为什么是确定性**：所有字段来自 `extractTaskState`（正则提取）和 trajectory（非 LLM 生成），零 LLM 成本。

### Task 2：在 `maybeCompact` 路径注入摘要消息

**修改**：`src/agent/compaction-controller.ts:215-240`（`maybeCompact` 函数中 micro-compact 之后）

**操作**：在 `this.deps.session.replaceMessages(compacted)` 之后，在压缩后的消息列表末尾追加一条 `user` 角色的摘要消息：

```typescript
// 在 replaceMessages 之后、markCompacted 之前插入
const taskState = extractTaskState(
  this.deps.getTrajectoryEntries(),
  this.deps.getStreamedText(),
)
const compactSummary = buildCompactSummary({
  taskState: { current: taskState.current, completed: taskState.completed, remaining: taskState.remaining, decisions: taskState.decisions },
  turnCount: this.deps.session.getTurnCount(),
  filesSeen: [...new Set(compacted.filter(m => m.role === 'tool').flatMap(m => {
    const matches = m.content.match(/(?:\/[^\s\n"'`{}()[\]]+\.[a-z]{1,6})\b/g)
    return matches ?? []
  }))],
  reasoningSnippet: '',
  errorCount: 0,
  errors: [],
  toolHistory: [],
})

// 追加摘要消息到 compacted 列表末尾
compacted.push({ role: 'user', content: compactSummary })
```

**位置约束**：摘要消息必须在 CACHE_ANCHOR_MESSAGES 之后插入（不破坏 prefix cache 前缀）。当前 `CACHE_ANCHOR_MESSAGES = 2`，摘要消息在末尾，安全。

**降级**：只在 compact tier ≥ 2 时注入摘要（tier 0-1 不注入，保持轻量）。tier 2+ 对应 ≥ 78% context（cache-preserving 策略），此时上下文已有压力，摘要收益 > 开销。

### Task 3：摘要写入 claim-store

**修改**：`src/agent/compaction-controller.ts`（Task 2 同一位置）

**操作**：在注入摘要消息后，若 `this.deps.session.getClaimStore?.()` 存在，写入一条 `compact_summary` claim：

```typescript
// 在 Task 2 的 compactSummary 构建后追加
const claimStore = this.deps.session.getClaimStore?.()
if (claimStore) {
  claimStore.propose({
    kind: 'decision',
    scope: 'session',
    text: `Compaction summary at turn ${this.deps.session.getTurnCount()}: ${taskState.current}`,
    confidence: 0.9,
    fitness: 5,
    source: { actor: 'system', sessionId: this.deps.session.getSessionId(), turn: this.deps.session.getTurnCount(), eventId: `compact-${Date.now()}` },
    evidence: [{
      id: `compact-summary-${Date.now()}`,
      kind: 'system' as const,
      summary: compactSummary.slice(0, 500),
      createdAt: Date.now(),
    }],
    createdAt: Date.now(),
    tags: ['compaction', 'summary'],
  })
}
```

**注意**：需要确认 `SessionContext` 是否有 `getClaimStore()` 和 `getSessionId()` 方法。若没有，需要添加（最小侵入）。

### Task 4：测试

**修改**：`src/agent/__tests__/compaction-controller.test.ts`

**新增测试用例**：

```typescript
it('P2: injects compact summary message after micro-compact at tier 2+', async () => {
  // 构造一个挤压到 tier 2 的 session 状态
  // 断言 compacted messages 中包含一条 role='user' 且 content 含 '<compact-summary>' 的消息
  // 断言该消息在 CACHE_ANCHOR_MESSAGES 之后的位置
})

it('P2: does NOT inject summary at tier 0-1', async () => {
  // 低压力 session，compact 后不应有 summary 消息
})
```

**修改**：`src/agent/__tests__/compaction-handoff.test.ts`

**新增测试用例**：

```typescript
it('buildCompactSummary includes four required fields', () => {
  const summary = buildCompactSummary({...})
  assert.ok(summary.includes('Goals'))
  assert.ok(summary.includes('Progress'))
  assert.ok(summary.includes('Active Files'))
  assert.ok(summary.includes('Errors'))
})
```

## 5. Verification

```bash
# 1. Typecheck
npx tsc --noEmit
# 期望：零错误

# 2. 相关测试套件
npm exec -- tsx --test src/agent/__tests__/compaction-controller.test.ts src/agent/__tests__/compaction-handoff.test.ts
# 期望：全部通过（包括新增的 P2 用例）

# 3. 全量回归（可选）
npm exec -- tsx --test src/**/__tests__/*.test.ts
# 期望：无回归
```

## 6. Self-check

### Spec coverage

| 需求 | 任务 |
|------|------|
| 四字段结构化摘要 | Task 1 (`buildCompactSummary`) |
| 摘要注入 compact 流程 | Task 2 |
| 摘要可被 claim-store 查询 | Task 3 |
| 不破坏 prefix cache | Task 2 位置约束（ANCHOR 之后） |
| 零 LLM 成本 | 设计约束（纯确定性提取） |

### Placeholder scan

- ✅ 无 TODO/TBD/待定
- ✅ 无 "添加适当的错误处理" 模糊描述
- ✅ 无 "类似任务 N" 引用
- ✅ 所有函数/类型在 task 中有定义或引用已有代码

### Type consistency

- `buildCompactSummary` 输入类型 `StructuredHandoffInput`（已有，compaction-controller.ts:22）
- `extractTaskState` 返回 `TaskState`（已有，task-state.ts:5）
- `claimStore.propose()` 接受 `ClaimProposal`（已有 API）
- Tiers：0=none, 1=watch, 2=compact, 3=reactive, 4=ceiling（compact-policy.ts 定义）

## 7. Execution handoff

计划已完成并保存到 `docs/superpowers/plans/compaction-structured-summary.md`。两种执行方式：

1. 子代理驱动（推荐）— 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. 内联执行 — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？
