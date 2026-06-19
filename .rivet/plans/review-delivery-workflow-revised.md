> **Status: ARCHIVED** — 2026-06-19 (审计/复盘文档)

# Review & Delivery Workflow — 修订方案

> 基于天枢审计文档（review-delivery-workflow-audit.md）修订
> 方法论：天璇（跨域收敛 + 反证）、贪狼（半接诊断 + 联合之道）、瑶光（归族 + 复现即证）
> 日期：2026-06-15

---

## 0. 修订核心判断

### 三个问题归为一族（瑶光归族之道）

审计文档列了三个"独立问题"（A/B/C），但从瑶光的归族视角看，它们是**同一架构缺陷的三个症状面**：

```
根因：审查（review）与交付（deliver_task）的操作耦合
  ├─ 入口耦合 → 症状 A：/review 只能走 deliver_task，regex 卡死附加参数
  ├─ 状态耦合 → 症状 B：审查进度被 deliver_task 的单个 await 吞掉
  └─ 输出耦合 → 症状 C：审查结果混入 deliver_task 大量输出中
```

**因此方案不应是"三个独立优化方向"，应是"一条链上的三个解耦节点"——必须一起修才能闭环。** 只修 A 不修 B，用户依然遭遇审查黑盒；只修 B 不修 C，审查结果依然被淹没。

### routeReviewWorkflow 是活能力，不是技术债（贪狼联合之道）

`team-orchestrate.ts:200` 已经独立调用 `routeReviewWorkflow(change, reviewDeps, { maxRounds: 3 })`——这证明该函数可以脱离 deliver_task 独立工作。

贪狼的诊断：这是"够到了没接完的能力"——输入端接了 deliver_task 一个消费者，但 `/review` slash command 的独立入口、进度回调、输出隔离都没接完。联合的方向是**向已有底座收敛**（暴露 routeReviewWorkflow），不是另造新工具。

### 审计方案方向正确，三处修订（天璇反证 + 温跃层）

天璇的反证杀掉了原方案中我最兴奋的假设——"方向 2b 新建独立工具"。反证：如果用户大多数时候还是通过 deliver_task 触发审查（因为 commit 是主要交付路径），新工具就是"多一个没人用的入口"。温跃层在 `routeReviewWorkflow` 这个函数本身——**接口已存在，入口未暴露**。

修订：
1. **方向 1**（修 regex）→ 保留，最小止血
2. **方向 2a**（进度可见）→ 提升为第一优先级（ROI 最高，0 架构改动）
3. **方向 2b**（独立工具）→ 降级为"暴露已有路径"——`/review` 直接调 routeReviewWorkflow，不新建工具
4. **方向 3**（结构化输出）→ 合并进 2b

---

## 1. 已验证的代码事实（瑶光复现之道）

| 断裂点 | 文件:行号 | 已确认 |
|--------|----------|--------|
| regex `$` 锚点 | `slash-commands.ts:196` | ✅ `/^\/review(\s+max)?$/i` |
| review 嵌入 deliver_task | `deliver-task.ts:596` | ✅ `await Promise.race([route(...), timeoutPromise])` |
| 独立调用先例 | `team-orchestrate.ts:200` | ✅ `routeReviewWorkflow(change, reviewDeps, { maxRounds: 3 })` |
| review 结果追加到 lines | `deliver-task.ts` L596 后 | ✅ 与 commit/cohesion/recovery 输出混在一起 |

---

## 2. 修订方案：三波解耦

### Wave 1：止血 — 修 regex + 进度可见（方向 1 + 方向 2a 合并）

**为什么合并**：单独修 regex 只是让参数能传进来，但用户传了参数后依然遭遇审查黑盒。两个改动在同一文件域内，合并为一个提交，blame 范围最小。

**改动 A — regex 修复**

文件：`src/tui/slash-commands.ts:196`

```
当前：  /^\/review(\s+max)?$/i
改为：  /^\/review(\s+max)?(\s|$)/i
```

匹配后提取 `max` 后面的自由文本作为审查描述：

```typescript
const reviewMatch = input.match(/^\/review(\s+(max))?(\s+(.*))?$/i)
if (reviewMatch) {
  const isMax = !!reviewMatch[2]
  const focusText = reviewMatch[4]?.trim()  // 附加描述
  const level = isMax ? 'L3' : 'L2'
  const focusInstruction = focusText
    ? ` Focus specifically on: ${focusText}.`
    : ''
  return `Run code review on the current uncommitted changes: call deliver_task with commit=true and review_level="${level}". This triggers ${levelLabel}.${focusInstruction}`
}
```

**改动 B — 进度可见（通过 onOutput streaming 回调）**

文件：`src/agent/deliver-task.ts` L552-596 之间（commit 完成后、审查 await 之前）

**关键发现**：`ToolCallParams` 有 `onOutput?: (chunk: string) => void` 字段（types.ts:9），`tool-pipeline.ts:449` 把它桥接到 `callbacks.onToolResult`——这意味着 deliver_task 的 execute 可以通过 `params.onOutput?.()` 在审查 await 之前推送一条**实时可见**的中间消息，不需要等 tool result 一次性返回。

```typescript
// commit 完成后、审查 await 之前
const budgetSec = Math.round(reviewWorkflowBudgetMs(reviewMode, change.scale) / 1000)
params.onOutput?.(`\n⏳ Post-commit review starting (${reviewMode} ${change.scale}, ≤${budgetSec}s)...\n`)
```

注意 `reviewWorkflowBudgetMs` 签名是 `(mode: ReviewMode, tier?: ReviewScale)`——接受 mode 和 tier，不接受 ChangeSet。正确调用方式见上方（传入 `reviewMode` 和 `change.scale`）。

**验证**：`onOutput` 在 tool-pipeline.ts:449 被桥接为 `callbacks.onToolResult(tu.id, tu.name, chunk)`——chunk 会实时出现在 TUI 的工具输出区域，不等最终 result。

**改动 C — 静默丢弃防护**

文件：`src/tui/slash-commands.ts` `resolveAppPromptInput` 最终 `return null` 之前

审计文档观测 1 指出：不匹配的 `/review` 输入会被 `resolveAppPromptInput` 返回 null → TUI 解释为 blocked → 用户消息凭空消失。Wave 1 的 regex 修复了匹配，但仍然需要处理"以 /review 开头但不匹配"的边界：

```typescript
// 在最终 return null 之前
if (input.toLowerCase().startsWith('/review')) {
  // 能走到这里说明 regex 没匹配——可能是拼写错误或格式问题
  return `User typed "${input}" which looks like a /review command but didn't match the expected format. ` +
    `Usage: /review [max] [focus description]. Run /review max to trigger L3 Review Squadron.`
}
```

**Wave 1 的实际价值**：regex 修复让参数能传进来；onOutput 进度标记在审查开始时**实时可见**；静默丢弃防护消除消息凭空消失。

### Wave 2：解耦入口 — `/review` 独立路径（完整落地方案）

**核心决策**：不新建工具，暴露已有的 routeReviewWorkflow。

#### reviewDeps 可达性追踪（已确认）

```
bootstrap.ts
  → 创建 coordinator (DelegationCoordinator)
  → coordinator 传给 createAgentRuntime → AgentLoop.config
  → AgentLoop 构造 deliver-task.ts 时传入 reviewDeps:
       ctx.routeReviewWorkflow = createCoordinatorReviewDeps(coordinator, {...})
  → deliver-task.ts execute() 通过 params → ctx.reviewDeps 获取

slash-commands.ts 的 SlashHandlerContext
  → 有 agent (AgentLoop) ✓  （agent 持有 coordinator）
  → 有 session ✓
  → 没有 coordinator ✗
  → 没有 reviewDeps ✗
```

**结论**：SlashHandlerContext 没有 reviewDeps，但有 agent。通过 agent 可以获取 coordinator 构造 reviewDeps。但更干净的路径是：在 main.tsx/main.ts 构造 SlashHandlerContext 时直接注入一个 `runReview` 回调。

#### 改动 1：SlashHandlerContext 新增可选字段

文件：`src/tui/slash-commands.ts`

```typescript
export interface SlashHandlerContext {
  // ...existing fields...
  /** 独立审查回调——/review 不经过 deliver_task 直接调 routeReviewWorkflow */
  runReview?: (change: ChangeSet, mode: ReviewMode, focus?: string) => Promise<ReviewOutcome>
}
```

#### 改动 2：main.tsx / main.ts 注入 runReview

在构造 SlashHandlerContext 时，用 coordinator 构造 reviewDeps 并注入：

```typescript
import { createCoordinatorReviewDeps } from './agent/review-coordinator-deps.js'
import { routeReviewWorkflow } from './agent/review-router.js'

// coordinator 在 bootstrap 中已创建
const reviewDeps = createCoordinatorReviewDeps(coordinator, {
  parentTurnId: 'slash-review',
  reviewDepth: 0,
})

// 注入到 SlashHandlerContext
runReview: async (change, mode, focus) => {
  const focused = focus
    ? { ...change, /* focus 注入到 files 或作为 metadata */ }
    : change
  return routeReviewWorkflow(focused, reviewDeps, { mode })
}
```

**注意**：main.ts (T9) 和 main-ink.tsx (Ink) 都需要注入。T9 入口在 `app.setSlashHandler` 之前构造；Ink 入口在 Root 组件的 slashCtx 中。

#### 改动 3：slash-commands.ts 的 `/review` 分支

```typescript
case '/review': {
  const isMax = parts[1]?.toLowerCase() === 'max'
  const focus = parts.slice(isMax ? 2 : 1).join(' ').trim()

  if (!ctx.runReview) {
    pushStatic(createLogEntry({ type: 'system',
      content: 'Review infrastructure not available.' }))
    setIsStreaming(false)
    return true
  }

  // 从 git diff 构造 ChangeSet
  const dirtyFiles = ctx.agent.getCurrentDirtyFiles?.() ?? []
  if (dirtyFiles.length === 0) {
    pushStatic(createLogEntry({ type: 'system',
      content: 'No uncommitted changes to review.' }))
    setIsStreaming(false)
    return true
  }

  const change: ChangeSet = {
    files: dirtyFiles,
    crossModule: isCrossModule(dirtyFiles),  // 自动分级
    isFix: isFixContext(/* 最近 commit message 或用户输入 */),  // 不能硬编码 false
    ...(isMax ? { forceLevel: 'L3' } : {}),   // /review max 强制 L3
  }

  const budgetSec = Math.round(reviewWorkflowBudgetMs('manual', isMax ? 'L3' : undefined) / 1000)
  pushStatic(createLogEntry({ type: 'system',
    content: `⏳ Review starting (${isMax ? 'L3 Squadron' : 'auto-classify'}, ≤${budgetSec}s)...` }))

  try {
    const outcome = await ctx.runReview(change, 'manual', focus || undefined)
    const icon = outcome.verdict === 'verified' ? '🟢'
               : outcome.verdict === 'rejected' ? '🔴' : '🟡'
    pushStatic(createLogEntry({ type: 'system',
      content: `${icon} Review [${outcome.tier}]: ${outcome.verdict}${outcome.evidence ? '\n' + outcome.evidence : ''}` }))
  } catch (err) {
    pushStatic(createLogEntry({ type: 'system',
      content: `Review failed: ${(err as Error).message}` }))
  }
  setIsStreaming(false)
  return true
}
```

#### 改动 4：resolveAppPromptInput 清理策略（已确认优先级）

**调用优先级**（app.tsx:811-814 已确认）：
```
L811: if (await handleSlashCommand(slashCtx)) return  // 先
L814: const promptInput = resolveAppPromptInput(...)   // 后（仅 handleSlashCommand 返回 false 时）
```

Wave 2 后 `/review` 在 `handleSlashCommand` 中 return true → `resolveAppPromptInput` 不再被调用。

**策略：保留 resolveAppPromptInput 的 review 分支作为 fallback。** 当 `ctx.runReview` 不可用时（未注入），`handleSlashCommand` 的 `/review` 分支 return false → 走到 `resolveAppPromptInput` → 映射为 deliver_task（旧行为）。两条路径自然互斥，不需要删除。

但 Wave 1 的 regex 修复仍需要——因为 fallback 路径的 `resolveAppPromptInput` 也需要正确匹配 `/review max <desc>`。

#### 分级机制（自动，无需手动判断）

| 用户输入 | forceLevel | routeReviewWorkflow 内部行为 |
|---------|-----------|---------------------------|
| `/review` | 无 | mode=manual → classifyChangeScale 自动分级 |
| `/review max` | L3 | mode=manual → forceLevel 覆盖 → 强制 L3 Squadron |
| `/review max 检查锚点漂移` | L3 + focus | 同上，focus 注入到 inspector objective |
| deliver_task 内部 | 无 | mode=auto → wiring inspector（轻量，≤180s） |

classifyChangeScale 用结构性信号自动判断：
- **文件数 >=5** → L3
- **跨模块**（不同顶层目录）→ L3
- **安全边界**（path-validate/sandbox/permissions）→ L3
- **依赖/配置文件**（package.json/tsconfig）→ L2
- **其他** → L1（nudge，不 spawn worker）

**用户不需要手动选级别**——`/review` 自动判断，`/review max` 是覆盖。

### Wave 3：进度 streaming + 输出隔离（方向 2a 完整版 + 方向 3）

**为什么推迟**：真正的进度 streaming 需要 deliver_task 或独立审查入口通过 callback/onProgress 回调实时推送中间状态到 TUI。这需要：
1. `routeReviewWorkflow` 支持 onProgress 回调（当前不支持）
2. TUI 层（Ink app.tsx 或 T9 engine app.ts）接收 callback 并渲染
3. 可能需要新的 TUI 状态（reviewing）和渲染区域

这是跨 3 层（agent/tui/engine）的系统级改动，应作为独立 plan 处理。

---

## 3. 安全不变量

| # | 不变量 | 理由 |
|---|--------|------|
| 1 | 审查后置不回退 | commit 在审查前完成，审查结果 advisory 不 block（a0f5d2a2 决策） |
| 2 | 深度自适应保留 | classifyChangeScale + isTrivialChange 不受影响 |
| 3 | 前缀缓存保护 | 审查不写 static prompt/tool definition |
| 4 | routeReviewWorkflow 签名不变 | 不改已有消费者（deliver_task + team_orchestrate） |
| 5 | regex 修改不破坏其他命令 | 只改 review 分支，其他命令不受影响 |

---

## 4. 反证测试表（瑶光之道）

| 偷懒实现 | 会红的测试 |
|----------|----------|
| 只修 regex 但不提取 focusText | `/review max 检查锚点漂移` 的描述被丢弃 → 用户附加文本无效 |
| 进度标记用 lines.push 而非 onOutput | 标记和结果一起输出，用户等待期间看不到 → 仍是黑盒 |
| `/review` 独立路径不检查 reviewDeps 可用性 | reviewDeps undefined → routeReviewWorkflow 崩溃 |
| regex 改为 `(\s\|$)` 但忘处理 `/reviewmax`（无空格） | `/reviewmax` 误匹配 → 非 review 命令被拦截 |
| `/review 检查锚点漂移`（无 max，有描述）被 blocked | regex `(\s+(max))?` 贪婪匹配截断 group 4 → 用户描述丢失 |
| isFix 硬编码 false | fix commit 后 `/review` 审查丢失 isFix 信号 → classifyChangeScale 行为偏差 |
| reviewWorkflowBudgetMs 传 ChangeSet 而非 mode+tier | 返回 NaN/undefined → 预算显示错误 |
| `/review` 不匹配时静默 return null | 用户消息凭空消失 → 无错误提示 |

---

## 5. 涉及文件

| Wave | 文件 | 改动 |
|------|------|------|
| 1 | `src/tui/slash-commands.ts` | regex 修改 + focusText 提取 |
| 1 | `src/agent/deliver-task.ts` | 进度标记行 |
| 2 | `src/tui/slash-commands.ts` | `/review` 独立路径（待确认 reviewDeps 可用性） |
| 3 | `src/agent/review-router.ts` | onProgress 回调 |
| 3 | `src/tui/app.tsx` 或 `src/tui/engine/app.ts` | 审查进度渲染 |

---

## 6. 原方案 vs 修订方案差异

| 原方案 | 修订方案 | 修订理由 |
|--------|---------|---------|
| 三个独立优化方向 | 一条链的三个解耦节点 | 瑶光归族：同一架构缺陷的三个症状面 |
| 方向 2b 新建 review_changes 工具 | 降级为暴露已有 routeReviewWorkflow | 贪狼联合：不另造，向已有底座收敛 |
| 方向 2a "轻量" | 提升为第一优先级 | 天璇反证：这是 ROI 最高的改动 |
| 方向 3 独立做 | 合并进 Wave 2/3 | 不需要独立做——输出隔离是解耦的自然结果 |
| 待确认问题 3 个 | 保留，但加入一个新确认项 | SlashHandlerContext 中 reviewDeps 的可用性 |

---

## 7. 原审计文档的优势保留（天璇万物为一）

审计文档做得好的地方不破坏：
1. **数据流图准确** — 端到端路径无误
2. **优势清单完整** — 5 条现有架构优势都是真实的
3. **代码索引精确** — 文件/行号都经得起验证
4. **中性归因** — "历史产物"而非"设计错误"
5. **待确认问题有价值** — 特别是"是否默认不提交"这个语义问题
