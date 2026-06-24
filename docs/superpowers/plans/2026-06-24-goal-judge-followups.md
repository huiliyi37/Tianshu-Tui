# Goal 完成检测 Judge — 链路后续实现计划

> **面向 AI 代理：** 使用 `executing-plans` 逐任务实现（计划阶段不派子代理）。
> 步骤使用复选框（`- [ ]`）跟踪进度。
> **本计划任务彼此独立、可单独调度。** 不是一条 TDD 链；用户按优先级挑选执行。
> 优先级：任务 1 = P0，任务 2/3 = P1，任务 4/5 = P2。建议从任务 1 起。

**目标：** 把已落地的 Goal Judge（commit `a5061452`）从"只在交互式 TUI 真正生效"补全为"全链路生效 + 可观测 + 提取可靠"，并为浏览器级验收预留入口。

**架构：** Judge 已接在 `turn-orchestrator.ts` 的 goal-achieved 分支（`judgeGoalCompletion`），经 `loop-factory.ts:getGoalJudgeDeps` 从 `coordinatorRef` 拿 spawn 能力。当前断点：headless `--goal` 无 Coordinator → judge 恒 `inconclusive`（accept+warning）= 空转；verdict 不落任何遥测；criteria 提取与主 client 并发且不可见。本计划逐一闭合。

**技术栈：** TypeScript / node:test / Ink 6 / DelegationCoordinator / EvidenceTracker。

**不在本计划范围：**
- 审批模式 / OS 沙箱与 goal 无人值守耦合（Codex 风分级权限 + 网络隔离 + Windows 沙箱）。
- handoff 文档记录的 goal interrupt P0/P1 bug：**状态待确认**（commit `d6d65de3` 修复了 4 个既有失败但未涉及 goal interrupt；执行任务 1 前应先查 session log 确认此 bug 是否仍存在，若存在应先于任务 1 处理）。

---

## 现状基线（调研背书）

- **headless 确无 coordinator**：`src/main.ts` headless 分支用 `createMainAgentConfigInput`（`create-agent-config.ts`）构造 agentCfg，**不设 `coordinatorRef`**；注释明写"无 DelegationCoordinator，reviewDeps 不可用"。故 `loop-factory.ts:getGoalJudgeDeps` 命中 `if (!coordinator) return {}` → `runGoalJudge` 走 `inconclusive` fail-open。判定：headless judge 当前是 no-op。
- **coordinator 构造重**：`src/bootstrap.ts:809` `new DelegationCoordinator({...})` 依赖 `modelCards`(L584-609)、`runtimeFactory`(L648，闭包捕获 `reviewOverrides`/`workerRouting`/`providerHealth`/`banditPromotion` 等 10+ 个变量)、`workerRouting`(L633)、`providerHealth`(L642)、`sessionRegistry`、`efeRouting`、`domainKnowledgeStore`。强行抽成独立工厂会让函数签名臃肿且紧耦合 bootstrap 装配顺序。→ 任务 1 选择**在 headless 构造专用轻量 Coordinator**（同 provider 同 apiKey、无 review override、无 worker routing、无 bandit、无 efe），bootstrap 保持不变。
- **遥测通道现成**：`turn-orchestrator.ts` deps 有 `writeTelemetry`（L162），已在 L648/710/742 使用。judge 复用同一通道即可，无需新管线。
- **criteria 提取并发**：`slash-commands.ts /goal` 与 `main.ts --goal` 都用 `completionFromClient(agent.config.client, model)` —— 与主会话**同一 client 并发 stream**；`agent.config` 另有 `workers.profiles.cheap`（`config/default.ts:163`）可作独立便宜 client 来源。
- **judge verdict 已结构化**：`goal-judge.ts` 的 `GoalJudgeVerdict { overall, criteria:[{criterion,met,evidence}], summary }` 已是可直接喂遥测/交付门禁的形状，无需再造。

---

## 任务

### 任务 1（P0）：构造 headless 专用轻量 Coordinator，让 headless `--goal` 的 judge 真正生效

- [x] 创建 `src/agent/headless-coordinator.ts`（export `createHeadlessCoordinator`）
- [x] 修改 `src/main.ts`（headless `--goal` 分支调用 `createHeadlessCoordinator` 并设 `coordinatorRef`；若 goalJudge 禁用或无 goal 则跳过）
- [x] 测试 `src/agent/__tests__/headless-coordinator.test.ts`

**目标：** headless `--goal` 拥有可 spawn `goal_judge` 的最小 Coordinator，judge 不再恒空转。**不改动 bootstrap**——bootstrap 的 coordinator 构造（`bootstrap.ts:584-829`）闭包捕获 `reviewOverrides`/`workerRouting`/`providerHealth`/`banditPromotion`/`efeRouting`/`domainKnowledgeStore` 等 10+ 个变量，强行抽成共享工厂会把十几项参数压进一个 God 入参类型，收益为负。

**设计决策：两个 coordinator，而非一个共享工厂。**

| 维度 | bootstrap（交互式） | headless `--goal` |
|------|--------------------|--------------------|
| review override | ✅ 不同 provider 避免缓存污染 | ❌ 不需要（同 provider 同 apiKey） |
| workerRouting | ✅ 按 task kind 路由不同 model | ❌ 只需 spawn goal_judge（readonly_plus_test） |
| providerHealth | ✅ 跨 worker 共享健康度 | ❌ 单次 goal 运行不需要 |
| banditPromotion | ✅ modelTier / routing / effort 三 bandit | ❌ headless 无 bandit |
| efeRouting | ✅ 从 agentLoop 取 signals | ❌ 无 agentLoop |
| sessionRegistry | ✅ resume/session 管理 | ❌ 不需要 |

headless 唯一需要的：`runtimeFactory` 能用同 provider 同 apiKey 构造 `goal_judge` 的 StreamClient，并通过 `coordinator.delegate()` 派出 judge worker。

**实现：**
```typescript
// src/agent/headless-coordinator.ts
import { DelegationCoordinator } from './coordinator.js'
import type { ModelCapabilityCard, WorkerRuntimeFactory } from './coordinator.js'
import type { ProviderConfig } from '../config/schema.js'
import type { ToolRegistry } from '../tools/registry.js'
import { createProviderClient } from '../api/provider-client.js'
import { resolveCapabilities } from '../api/provider-capabilities.js'
import { PromptEngine } from '../prompt/engine.js'
import { profileRegistry } from './profile-registry.js'
import type { AuthProvider } from '../api/auth.js'

export interface HeadlessCoordinatorInput {
  toolRegistry: ToolRegistry
  provider: ProviderConfig
  providerName: string
  apiKey: string
  auth?: AuthProvider
  cwd: string
  sessionId?: string
}

/** Build modelCards from a provider's models (reused from bootstrap.ts:584-609). */
export function buildModelCards(provider: ProviderConfig): ModelCapabilityCard[] {
  return provider.models.map(m => {
    const isPro = m.id.includes('pro') || m.alias?.includes('pro')
    const isFlash = m.id.includes('flash') || m.alias?.includes('flash')
    if (isPro || (!isFlash && !isPro)) {
      return {
        model: m.id,
        toolUseReliability: 0.8, jsonStability: 0.8,
        editSuccessRate: 0.7, testRepairRate: 0.6,
        contextWindow: m.contextWindow, cacheEconomics: 'strong' as const,
        recommendedTasks: ['code_search', 'code_edit', 'test_failure_diagnosis', 'risky_refactor'],
      }
    }
    return {
      model: m.id,
      toolUseReliability: 0.6, jsonStability: 0.65,
      editSuccessRate: 0.5, testRepairRate: 0.45,
      contextWindow: m.contextWindow, cacheEconomics: 'strong' as const,
      recommendedTasks: ['repo_summarization', 'compaction'],
    }
  })
}

/**
 * Build a minimal DelegationCoordinator for headless goal mode.
 * Only supports spawning read-only workers (goal_judge) — no review
 * overrides, no worker routing, no bandit, no session registry.
 */
export function createHeadlessCoordinator(input: HeadlessCoordinatorInput): DelegationCoordinator {
  const modelCards = buildModelCards(input.provider)
  const primaryModel = input.provider.models[0]
  const runtimeFactory: WorkerRuntimeFactory = (order, card, workerRegistry) => {
    const isWrite = profileRegistry.listWriteProfiles().includes(order.profile)
    const modelSpec = input.provider.models.find(
      m => m.id === card.model || m.alias === card.model,
    )
    const ctxWindow = modelSpec?.contextWindow ?? card.contextWindow
    const maxTokens = isWrite
      ? Math.min(8192, modelSpec?.maxTokens ?? ctxWindow)
      : Math.min(4096, modelSpec?.maxTokens ?? ctxWindow)
    return {
      order,
      client: createProviderClient(input.provider, resolveCapabilities(input.providerName, input.provider.capabilities), {
        apiKey: input.apiKey, model: card.model, reasoningEffort: undefined,
        maxTokens, thinkingBudget: isWrite ? 8192 : 4096, auth: input.auth,
      }),
      promptEngine: new PromptEngine({
        model: card.model, maxTokens,
        staticCtx: { tools: workerRegistry.getDefinitions() },
        volatileCtx: { cwd: input.cwd },
      }),
      toolRegistry: workerRegistry,
      cwd: input.cwd, maxTurns: 8,
      contextWindow: ctxWindow,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      activeClaims: [],
    }
  }
  return new DelegationCoordinator({
    baseToolRegistry: input.toolRegistry,
    modelCards,
    maxWorkers: 1,  // headless goal only ever spawns goal_judge
    runtimeFactory,
    maxDelegationDepth: 1,
    sessionId: input.sessionId,
  })
}
```
```typescript
// src/main.ts — headless --goal 分支，在 createAgent 内 agent 创建后：
if (parsed.goal && agent.config.goalJudge?.enabled !== false) {
  const { createHeadlessCoordinator } = await import('./agent/headless-coordinator.js')
  const coordinator = createHeadlessCoordinator({
    toolRegistry,
    provider: prov,
    providerName: provider,
    apiKey: key,
    auth,
    cwd: process.cwd(),
    sessionId,
  })
  agent.config.coordinatorRef = () => coordinator
}
```

**验证：**
```bash
npx tsc --noEmit  # 期望：headless-coordinator.ts 零新增错误
npm exec -- tsx --test src/agent/__tests__/headless-coordinator.test.ts  # 期望全部通过
# 手动：rivet --goal "给 X 加单测并全绿" --budget 20，观察 stderr 出现 goal_judge worker 派发 + verdict
```

**提交：**
```bash
git add src/agent/headless-coordinator.ts src/agent/__tests__/headless-coordinator.test.ts src/main.ts
git commit -m "feat(goal): wire headless DelegationCoordinator into --goal so the judge runs (任务 1/5)"
```

---

### 任务 2（P1）：judge verdict 遥测 + verdict 可观测性

- [x] 修改 `src/agent/turn-orchestrator.ts`（`judgeGoalCompletion` 内 emit 遥测）
- [x] 修改 `src/agent/loop-factory.ts`（如需补 verdict 持久化 dep）
- [x] 测试 `src/agent/__tests__/turn-orchestrator-goal.test.ts`（扩展：断言遥测被调用）

**目标：** 每次 judge 运行落一条结构化遥测（overall / met / unmet / judgeRuns / 是否 accepted-as-unverified），并在 TUI 出一行 verdict 摘要，使 `maxRuns` 等参数可基于数据调优、可度量假完成拦截率。

**调研背书：**（无删除/改行为，纯新增）
- `writeTelemetry`：`turn-orchestrator.ts:162` 已是 deps 字段，L648/710/742 已用同形 `{ kind, ... }` entry。judge 复用，不新增管线。

**实现：**

`judgeGoalCompletion` 当前为三路多出口（每个分支直接 return）。为了在所有出口前统一 emit 遥测，需重构为单出口：用一个局部变量记录 `action` 和 `acceptedUnverified`，在 return 前统一写遥测。

控制流重构：

```typescript
// src/agent/turn-orchestrator.ts — judgeGoalCompletion 重构：
private async judgeGoalCompletion(
  tracker: GoalTracker,
  signal: AbortSignal | undefined,
): Promise<{ action: 'accept' | 'continue'; reminder: string }> {
  // ... 前置判断不变 ...

  const verdict = await rejectOnAbort(runGoalJudge(judgeDeps, { ... }), signal!, 'goal-judge')

  let action: 'accept' | 'continue'
  let reminder: string
  let acceptedUnverified = false

  if (verdict.overall === 'verified') {
    action = 'accept'
    reminder = achievedReminder(' Judge 已独立核验全部验收项。')
    // acceptedUnverified 保持 false
  } else if (verdict.overall === 'rejected') {
    if (tracker.getJudgeRuns() < tracker.getMaxJudgeRuns()) {
      action = 'continue'
      reminder = /* 驳回继续 */ ''
      // acceptedUnverified 不适用（未 accept）
    } else {
      action = 'accept'
      reminder = achievedReminder(/* cap 警告 */)
      acceptedUnverified = true
    }
  } else {
    // inconclusive
    action = 'accept'
    reminder = achievedReminder(/* 未验证警告 */)
    acceptedUnverified = true
  }

  // 单出口 emit——仅 accept 路写遥测（continue 路不算完成判定，不写 verdict）
  if (action === 'accept') {
    this.deps.writeTelemetry({
      kind: 'goal_judge_verdict',
      overall: verdict.overall,
      judgeRuns: tracker.getJudgeRuns(),
      maxJudgeRuns: tracker.getMaxJudgeRuns(),
      criteriaTotal: verdict.criteria.length,
      criteriaMet: verdict.criteria.filter(c => c.met === true).length,
      criteriaUnmet: verdict.criteria.filter(c => c.met === false).length,
      acceptedUnverified,
      iteration: tracker.getIteration(),
    })
  }

  return { action, reminder }
}
```

**验证：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/agent/__tests__/turn-orchestrator-goal.test.ts  # 期望全绿，新增断言：mock writeTelemetry 收到 goal_judge_verdict
```

**提交：**
```bash
git add src/agent/turn-orchestrator.ts src/agent/loop-factory.ts src/agent/__tests__/turn-orchestrator-goal.test.ts
git commit -m "feat(goal): emit goal_judge_verdict telemetry for tuning & observability (任务 2/5)"
```

---

### 任务 3（P1）：criteria 提取硬化 —— 独立便宜 client + 可见可编辑 + 降级提示

- [x] 修改 `src/agent/goal-criteria.ts`（`completionFromClient` 支持注入独立 client/model；新增从 worker profile 取 cheap client 的 helper）
- [x] 修改 `src/tui/slash-commands.ts`（`/goal` 用独立 cheap client；新增 `/goal-criteria` 查看/微调）
- [x] 修改 `src/main.ts`（`--goal` 同样用独立 client；提取失败 stderr 明确降级提示）
- [x] 测试 `src/agent/__tests__/goal-criteria.test.ts`（扩展：独立 client 注入路径）

**目标：** criteria 提取不再与主会话 client 并发争用；用户可见并能微调将据以判定的验收项；提取降级时有明确提示而非静默。

**调研背书：**
- `slash-commands.ts /goal` 与 `main.ts --goal` 现用 `completionFromClient(agent.config.client, model)`：与主会话同 client 并发 stream，存在 lifecycle controller 争用风险。改用 `cfg.workers.profiles.cheap`（`config/default.ts:163`，provider=minimax/model=MiniMax-M2.7）解析出的独立 client。
- `completionFromClient` 当前签名 `(client, model, maxTokens)`：保持兼容，新增一个 `cheapCompletionFromConfig(cfg, providers)` helper 构造独立 client；调用方改用之。

**实现：**
```typescript
// src/agent/goal-criteria.ts — 新增（构造独立便宜 client，复用 create-agent-config 的 cross-provider 工厂）
export function cheapCompletionFromWorkers(
  workerProfiles: Record<string, { provider: string; model: string }>,
  providers: Record<string, ProviderConfig>,
  fallback: { client: StreamClient; model: string },
): CompletionFn {
  const cheap = workerProfiles.cheap
  // 解析 cheap.provider 的 apiKey → 造 StreamClient；失败回退 fallback。
}
```
```typescript
// src/tui/slash-commands.ts — 新增 /goal-criteria 命令：打印 tracker.getSuccessCriteria()，
// 支持 "/goal-criteria set <json array>" 覆盖 tracker.setSuccessCriteria(...)。
```

**验证：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/agent/__tests__/goal-criteria.test.ts  # 期望全绿
# 手动：/goal 后立刻 /goal-criteria 查看；提取失败时 TUI/stderr 显示"已降级为宽判"
```

**提交：**
```bash
git add src/agent/goal-criteria.ts src/tui/slash-commands.ts src/main.ts src/agent/__tests__/goal-criteria.test.ts
git commit -m "feat(goal): harden criteria extraction — dedicated cheap client + /goal-criteria edit (任务 3/5)"
```

---

### 任务 4（P2）：Phase 2 浏览器/接口级验收（goal_judge UI·API·DB 验证）

- [x] 修改 `src/agent/profile-registry.ts`（`goal_judge` 在 `browser` 开启时追加 `web_fetch`/`browser`）
- [x] 修改 `src/agent/loop-factory.ts`（按 `goalJudge.browser` 决定是否给 judge 加浏览器工具）
- [x] 修改 `src/agent/goal-judge.ts`（objective 注入 criterion 类型路由提示）
- [x] 测试 `src/agent/__tests__/goal-judge.test.ts`（扩展：browser 开关下 allowedTools 含浏览器工具）

**目标：** UI/web 类目标用真实浏览器/接口验收（Anthropic evaluator 风格），静态证据够不到的行为类 criterion 也能被独立核验。

**调研背书：**
- `src/tools/browser.ts` 已存在但默认禁用（需 `npm i -D playwright` + `browserTool:true` + `RIVET_BROWSER_ALLOWLIST`）；MCP `@playwright/mcp` 经 `src/mcp/manager.ts` 已支持。三选一接入，默认走最轻的 `web_fetch`+`bash curl`。
- `agent.goal.judge.browser` 开关已在 commit `a5061452` 的 schema 落地（`config/schema.ts`），当前未被读 —— 本任务把它接到 judge 工具集。
- **安全约束**：`web_fetch`/`browser` 的 approval 机制依赖交互式 TUI 弹窗。headless `--goal` 下 approval 要么自动通过（`dangerously-skip-permissions`）要么卡死。本任务限定浏览器验证**仅在 TUI 交互模式启用**；headless 下 `browser: true` 触发配置警告并降级为 `web_fetch`（只读 URL），不开放浏览器工具。不新增 profile——直接在 `getGoalJudgeDeps` 中按 `isHeadless` 判断降级。

**实现：**
```typescript
// src/agent/loop-factory.ts getGoalJudgeDeps —— 若 self.config.goalJudge?.browser：
// 仅在交互式 TUI 模式启用浏览器工具；headless 降级为 web_fetch 只读 URL。
// 通过 spawnJudge 的 DelegationRequest 传 toolWhitelist 追加 web_fetch。
// fail-closed：headless 下 browser=true 写 stderr 警告 "goal-judge browser disabled in headless mode"。
```

**验证：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/agent/__tests__/goal-judge.test.ts  # 期望全绿
# 手动：agent.goal.judge.browser=true 下 /goal "页面 X 点 Y 显示 Z"，观察 judge 用 web_fetch/browser 核验
```

**提交：**
```bash
git add src/agent/profile-registry.ts src/agent/loop-factory.ts src/agent/goal-judge.ts src/agent/__tests__/goal-judge.test.ts
git commit -m "feat(goal): phase-2 browser/API verification for goal_judge (任务 4/5)"
```

---

### 任务 5（P2）：judge ↔ deliver L3 联动收紧

- [x] **前置**：读 `src/agent/delivery-gate-v2.ts` 的 `VerificationMetadata` 类型，确认能否承载 `GoalJudgeVerdict.criteria` 的 criterion-level 证据。若兼容→走证据注入路径；若不兼容→降级为遥测关联（judge verdict 仅写入 GoalTracker，deliver_task 通过 `isGoalAchieved` 标记触发 L3 升级，不做 criterion 级透传）。
- [x] 修改 `src/agent/turn-orchestrator.ts`（`verified`/`rejected` 时把 `GoalJudgeVerdict` 存到 GoalTracker，新增 `setLastVerdict`/`getLastVerdict`）
- [x] 修改 `src/agent/deliver-task.ts`（接收 judge verdict 作为验证证据，减少 L3 对功能完整性的重复判断）
- [x] 测试 `src/agent/__tests__/deliver-task.test.ts`（扩展：judge verified 证据通过 `isGoalAchieved` + `getLastVerdict` 影响 L3 升级）

**目标：** judge `verified` 后不只是文字提示模型去 `deliver_task`，而是把 verdict 直接作为交付门禁证据。当前 `deliver-task.ts` 的 `isGoalAchieved` 标记已触发 L3 自动升级（Review Squadron 代码审查）；judge verdict 应替代 L3 对**功能完整性**的判断，让 L3 聚焦代码质量——二者互补而非重复。

**现有关联（无需改动）：** `deliver-task.ts` 的 `isGoalActive`→skipAutoReview（避免 goal 循环被 review worker 阻塞）；`isGoalAchieved`→L3 升级。本任务在此基础上加 judge verdict 证据层。

**调研背书：**
- `DeliveryGateV2.assess(externalVerifications: VerificationMetadata[], ...)` 签名的 `VerificationMetadata` 类型需在执行前读源码确认字段结构。若不支持 criterion 级证据，降级为 GoalTracker 标记联动（`isGoalAchieved` + L3），不做 `VerificationMetadata` 改造。
- 关键补漏：当前 judge verdict 只在 `judgeGoalCompletion` 的栈帧里存在，`deliver_task` 看不到。必须先让 GoalTracker 持有 verdict（新增 `setLastVerdict`/`getLastVerdict`），`deliver_task` 才能取到。

**实现：**
```typescript
// src/agent/goal-tracker.ts — 新增：
private _lastVerdict: GoalJudgeVerdict | null = null
setLastVerdict(v: GoalJudgeVerdict) { this._lastVerdict = v }
getLastVerdict(): GoalJudgeVerdict | null { return this._lastVerdict }

// src/agent/turn-orchestrator.ts — judgeGoalCompletion 单出口 emit 前：
if (verdict.overall === 'verified' || (verdict.overall === 'rejected' && atCap)) {
  tracker.setLastVerdict(verdict)
}

// src/agent/deliver-task.ts — 在 goalAchieved 分支取 tracker.getLastVerdict()，
// 兼容路径：若 VerificationMetadata 可承载→注入为 externalVerifications；
// 不兼容路径：仅通过 isGoalAchieved 触发 L3 升级（现有逻辑，无需改动）。
```

**验证：**
```bash
npx tsc --noEmit
npm exec -- tsx --test src/agent/__tests__/deliver-task.test.ts  # 期望全绿
```

**提交：**
```bash
git add src/agent/turn-orchestrator.ts src/agent/deliver-task.ts src/agent/__tests__/deliver-task.test.ts
git commit -m "feat(goal): feed judge verdict into deliver L3 gate to cut duplicate review (任务 5/5)"
```

---

## 跨任务架构补漏

### 补漏 A：verdict 持久化（任务 2 ↔ 5 之间）

**问题**：judge 跑完 → verdict 只在 `judgeGoalCompletion` 的栈帧里 → 生成 `reminder` 字符串注入会话 → 后续 `deliver_task` 只看到模型是否调用了它，看不到 verdict 结构。任务 5 若要把 verdict 喂给门禁，必须先让 GoalTracker 持有 verdict。

**方案**：已在任务 5 中补入 `GoalTracker.setLastVerdict`/`getLastVerdict`。任务 2 的遥测 emit 与任务 5 的门禁透传共享同一持久化源（GoalTracker）。

### 补漏 B：criteria 提取 client 生命周期（任务 3）

**问题**：即使任务 3 用独立 cheap client，`slash-commands.ts /goal` 提取时 agent loop 可能正在跑，两个 `StreamClient.stream()` 共享 Node.js 默认 HTTP 连接池，存在 socket 层面隐式争用。非阻塞，但需标注。

**方案**：任务 3 实现时在 criteria 提取调用处加注释标注"已知限制：与主会话共享 HTTP 连接池，极端并发下可能有 socket 排队延迟"。

### 补漏 C：`cheapCompletionFromWorkers` 分层（任务 3）

**问题**：计划伪代码中 `cheapCompletionFromWorkers` 同时负责 client 构造和 completion 调用。现有 `completionFromClient` 已能把 `StreamClient` 转为 `CompletionFn`——新 helper 只需负责"解析 cheap profile → 构造独立 `StreamClient`"，然后复用 `completionFromClient`。

**方案**：实施时拆为两层——`buildCheapClient(cfg, providers)` 返回 `{ client, model }`，调用方用 `completionFromClient(buildCheapClient(...))` 组合，保持 concern 分离。

---

## 自检

1. **规格覆盖**：P0(headless judge 生效)=任务1；P1(遥测)=任务2；P1(criteria 硬化)=任务3；P2(浏览器)=任务4；P2(deliver 联动)=任务5。沙箱耦合/interrupt bug 显式划出范围。✅
2. **占位符扫描**：任务 4/5 含安全降级路径与前置确认步骤——这是**有意的执行期决策点**，已附调研背书与降级方案，非 TODO 占位。任务 1-3 路径/签名具体。✅
3. **类型一致性**：`GoalJudgeVerdict`/`GoalJudgeDeps`/`coordinatorRef` 沿用 commit `a5061452` 已定义类型；`CompletionFn` 已在 `goal-criteria.ts` 中定义（`completionFromClient` 使用），任务 3 不改其签名。`VerificationMetadata`（`delivery-gate-v2.ts`）需在任务 5 前置步骤中确认兼容性。跨任务一致。✅
4. **调研背书**：任务 1（行为不变，headless 新增 coordinator 路径）、任务 4/5 改行为均附背书与风险；任务 2/3 为纯新增。✅
5. **跨任务补漏**：verdict 持久化（A）、client 生命周期标注（B）、函数分层（C）均已记录，无遗漏依赖。✅

## 执行交接

计划已保存到 `docs/superpowers/plans/2026-06-24-goal-judge-followups.md`。

执行方式：使用 `executing-plans` 在当前会话中逐任务执行。任务彼此独立，可按优先级单独挑选（建议 任务1 → 2 → 3 → 4/5）。
