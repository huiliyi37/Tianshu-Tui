# Team Mode V2 落地实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把已建好却完全未接线的确定性 team 引擎（team-plan / team-grouping / team-perspectives / team-orchestrator，45 测试绿、零活消费者）通过一个 `team_orchestrate` 工具接进 `/team` 活路径，让 `/team`（标准）与 `/team max`（多视角规划）真正跑通"解析/合并 → 分波 → 派发 → 审查门"。

**架构：** 沿用 `2026-06-07-team-mode-phased-implementation.md` 早已定下的 **Phase 4（接线）** 方向——引擎做成主控 LLM 可调用的工具，主控仍负责编排决策与集成，工具提供确定性的解析/分组/冲突串行/依赖校验/视角合并。关键决策：(1) 引擎经 `team_orchestrate` 工具接入，复用 `_coordinatorRef.delegateBatch` 闭包（与 `delegate_batch` 工具同构）；(2) 多波次由主控驱动重入（`fromWave` 参数 + 工具间集成 diff），不内置自动 merge（Phase 7 后置）；(3) 审查门复用现成 `routeReviewWorkflow` + `createCoordinatorReviewDeps`，对 feature/refactor 也生效，不依赖 `fix:` commit；(4) 模型路由复用现有 CapabilityTask 路由（planner=`plan`→`code_edit`，executor=`patch_proposal`→`risky_refactor` 天然分流），仅补 config + 文档。**明确范围外：** V3 worker 星域认知注入（`systemPromptSuffix` 接进 worker prompt）不在本计划。

**技术栈：** TypeScript strict / Node.js 22 / ESM（import 带 `.js`）/ node:test + node:assert/strict / zod。所有新代码遵循不可变模式与"零硬编码状态码（用 classifyApiError）"约定。

---

## 1. 范围检查

本计划只覆盖**一个子系统**：`/team` 的引擎接线与编排闭环（V2 的 P0/P1）。它独立可工作、可测试：完成后 `/team <plan.md>` 与 `/team max <objective>` 端到端跑通。

**明确不在本计划（后置，各自独立）：**
- V3 worker 星域认知注入（`star-domain.ts:systemPromptSuffix` 接进 worker、星域知识库）——见 `2026-06-07-team-mode-v3-worker-stardomain.md`
- Review Squadron 姿态轴 Inspector——见 `2026-06-07-review-squadron-stance-axis-proposal.md`
- 自动 merge / cherry-pick 闭环（Phase 7）——worker 仍只返回 diff，主控集成
- TaskBoard TUI 面板（Phase C / P2）
- 改变全局模型选择默认值（仅做 config 可路由，不动 `recommendModelForTask` 默认）

---

## 2. 文件结构

| 文件 | 动作 | 职责 |
|------|------|------|
| `src/tools/team-orchestrate.ts` | **创建** | `createTeamOrchestrateTool(coordinator)`：解析输入、读 planPath（路径校验）、调 `runTeamSkeleton`、最后一波后跑审查门、格式化 ToolResult。引擎的唯一活入口。 |
| `src/tools/__tests__/team-orchestrate.test.ts` | **创建** | 工具单测：标准派发、路径越界拦截、fromWave 续派、审查门触发。 |
| `src/agent/team-orchestrator.ts` | 修改 | max 分支由"空转 return"改为"派 3 planner → 合并 → 分波 → 派首波"；抽 `dispatchWaveAt` 统一标准/max 的按索引派发；`TeamRunInput` 加 `fromWave`。 |
| `src/agent/team-perspectives.ts` | 修改 | 新增 `buildPlannerObjective()`（视角姿态 + schema 指令）与 `parsePerspectiveResult()`（从 WorkerResult artifact 提取 TeamPerspectivePlan，优雅降级）。 |
| `src/agent/__tests__/team-orchestrator.test.ts` | 修改 | 重写 max 分支测试（行为已变：现在会派 planner）；新增 fromWave 续派测试。 |
| `src/agent/__tests__/team-perspectives.test.ts` | 修改 | 新增 `buildPlannerObjective` / `parsePerspectiveResult` 测试。 |
| `src/workflows/ecosystem-workflows.ts` | 修改 | `buildTeamWorkflowPrompt` 改为引导主控**先调 `team_orchestrate`**，再集成/验证/审查/deliver；保留 `delegate_batch` 字样。 |
| `src/workflows/__tests__/ecosystem-workflows.test.ts` | 修改 | prompt 新增 `team_orchestrate` 断言；保留既有断言。 |
| `src/tui/__tests__/slash-commands.test.ts` | 修改 | 同步：prompt 含 `team_orchestrate`；保留 `delegate_batch`。 |
| `src/main.tsx` | 修改 | 注册 `team_orchestrate` 工具，注入 `{ delegate, delegateBatch }`（复用 `_coordinatorRef` 闭包）。 |
| `src/tui/slash-commands.ts` | 修改 | `/help` 文案补一行说明 `/team` 走 team_orchestrate（可选，纯文案）。 |
| `docs/...config 示例` | 修改 | Task 5：在 v2-status 或新 README 段记录 `workers.routing` 让规划走强模型、执行可走 flash。 |

---

## 3. 调研背书（行为变更 / 删除项）

每条都已 grep 核实，列出调用方、存在理由、边界风险：

1. **`team-orchestrator.ts` max 分支当前"空转 return"（行 131-141）改为派 planner。**
   - 调用方：`runTeamSkeleton` 仅被 `team-orchestrator.test.ts` 与（Task 1 后）`team_orchestrate` 工具调用。grep 确认无其它活调用方。
   - 存在理由：phased 文档 Phase 3 故意"先不暴露为工具"、max"先返回 planning brief"（行 246）。这是分阶段产物，Phase 4 接线时本就该改。
   - 边界风险：**`team-orchestrator.test.ts:106-118` 断言 `called===false` / `dispatched===0` 会失败**——Task 2 必须同步重写该测试（行为真实改变，非测试错误）。

2. **`buildTeamWorkflowPrompt`（ecosystem-workflows.ts:266-296）改写。**
   - 调用方：`resolveEcosystemWorkflowInput`（同文件）→ `resolveAppPromptInput`（slash-commands.ts:176）→ `app.tsx`。
   - 边界风险：`ecosystem-workflows.test.ts:92` 与 `slash-commands.test.ts:124` 断言 prompt 含 `'delegate_batch'`，`*:102/133` 断言含 `'/team max'`。**改写时必须保留这两个子串**（worker 仍叫 delegate_batch；模式标签仍是 /team max），否则测试红。Task 1 同时给这两个测试补 `team_orchestrate` 断言。

3. **`runTeamSkeleton` 加 `fromWave` 参数（Task 3）。** 向后兼容（可选，默认 0 = 现有"派首波"行为）。现有 wave 测试（`team-orchestrator.test.ts:121-214`）断言首波派发，默认 fromWave=0 行为不变 → 不破。

4. **不删除任何东西。** `selectDispatchableTeamTasks` / `teamTasksToDelegationRequests`（legacy fallback）保留——它们仍是"无结构化计划"时的降级路径（team-orchestrator.ts:148-176）。

---

## 4. 任务

### 任务 1：`team_orchestrate` 工具 —— 给引擎通电（keystone）

完成后 `/team <plan.md>` 端到端跑通：解析 → 分组 → 派首波。这是 V2 第一次真实落地。

**文件：**
- 创建：`src/tools/team-orchestrate.ts`
- 创建：`src/tools/__tests__/team-orchestrate.test.ts`
- 修改：`src/main.tsx:182-190` 附近（紧接 `createDelegateBatchTool` 注册之后）
- 修改：`src/workflows/ecosystem-workflows.ts:266-296`（`buildTeamWorkflowPrompt`）
- 修改：`src/workflows/__tests__/ecosystem-workflows.test.ts`、`src/tui/__tests__/slash-commands.test.ts`

- [x] **步骤 1：编写失败的工具测试**

创建 `src/tools/__tests__/team-orchestrate.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTeamOrchestrateTool } from '../team-orchestrate.js'
import type { CoordinatorRun, DelegationRequest } from '../../agent/coordinator.js'

function stubRun(packet = 'stub'): CoordinatorRun {
  return { status: 'completed', results: [], packet }
}

test('team_orchestrate dispatches a standard plan first wave', async () => {
  let captured: DelegationRequest[] = []
  const tool = createTeamOrchestrateTool({
    delegate: async () => stubRun(),
    delegateBatch: async (requests) => { captured = requests; return stubRun('dispatched') },
  })
  const md = '### Task 1: edit foo\n\nModify `src/agent/foo.ts`\n\n### Task 2: edit bar\n\nModify `src/agent/bar.ts`'
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'execute the plan deliberately', planMarkdown: undefined },
    cwd: process.cwd(),
    toolUseId: 'tu-1',
  } as never)
  assert.equal(result.isError, false)
  assert.equal(captured.length, 2)
  assert.match(result.content, /2 dispatched/)
})

test('team_orchestrate blocks a planPath outside the project', async () => {
  const tool = createTeamOrchestrateTool({
    delegate: async () => stubRun(),
    delegateBatch: async () => stubRun(),
  })
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'x', planPath: '/etc/passwd' },
    cwd: process.cwd(),
    toolUseId: 'tu-2',
  } as never)
  assert.equal(result.isError, true)
  assert.match(result.content, /outside project|blocked/i)
})
```

注意：上面标准测试用 `planMarkdown` 直接传 markdown（避免文件 IO）。这要求工具 input 同时支持 `planMarkdown`（内联）与 `planPath`（文件）。

- [x] **步骤 2：运行测试确认失败**

运行：`npm exec -- tsx --test src/tools/__tests__/team-orchestrate.test.ts`
预期：FAIL，报错 `Cannot find module '../team-orchestrate.js'`。

- [x] **步骤 3：实现 `team_orchestrate` 工具**

创建 `src/tools/team-orchestrate.ts`：

```ts
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import type { CoordinatorRun, DelegationRequest } from '../agent/coordinator.js'
import type { AggregationPolicy } from '../agent/work-order.js'
import { runTeamSkeleton, type TeamRunSummary } from '../agent/team-orchestrator.js'
import { validatePathSafe } from './path-validate.js'
import type { Tool, ToolCallParams, ToolResult } from './types.js'

/** Coordinator surface the team tool needs. `delegate` is used by the review
 *  gate (Task 4); `delegateBatch` drives planner fanout + wave dispatch. */
export interface TeamOrchestrateCoordinator {
  delegate(request: DelegationRequest, abortSignal?: AbortSignal): Promise<CoordinatorRun>
  delegateBatch(
    requests: DelegationRequest[],
    policy?: AggregationPolicy,
    abortSignal?: AbortSignal,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<CoordinatorRun>
}

const inputSchema = z.object({
  mode: z.enum(['standard', 'max']).default('standard'),
  objective: z.string().min(1),
  planPath: z.string().optional(),
  planMarkdown: z.string().optional(),
  maxParallel: z.number().int().min(1).max(5).optional(),
})

export function formatTeamSummary(summary: TeamRunSummary): string {
  const lines: string[] = [
    `team ${summary.mode}: ${summary.dispatched} dispatched, ${summary.waves.length} waves, ${summary.blocked.length} blocked`,
  ]
  if (summary.waves.length > 0) {
    lines.push('Waves:')
    for (const w of summary.waves) lines.push(`  ${w.id} [${w.risk}] ${w.taskIds.join(', ')} — ${w.reason}`)
  }
  if (summary.blocked.length > 0) {
    lines.push('Blocked:')
    for (const b of summary.blocked) lines.push(`  - ${b}`)
  }
  lines.push('', summary.packet)
  return lines.join('\n')
}

export function createTeamOrchestrateTool(coordinator: TeamOrchestrateCoordinator): Tool {
  return {
    definition: {
      name: 'team_orchestrate',
      description:
        'Run the deterministic team orchestrator: parse a plan (standard) or fan out 3 perspective planners (max), group tasks into waves respecting file conflicts and dependencies, and dispatch the first ready wave of workers. Returns the wave schedule and dispatch summary. Does NOT auto-commit — the main controller integrates worker diffs.',
      input_schema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['standard', 'max'], description: 'standard: execute an existing plan. max: multi-perspective planning first.' },
          objective: { type: 'string', description: 'The mission statement.' },
          planPath: { type: 'string', description: 'Optional path to a Markdown plan inside the project (standard mode).' },
          planMarkdown: { type: 'string', description: 'Optional inline Markdown plan (standard mode); takes precedence over planPath.' },
          maxParallel: { type: 'number', description: 'Max parallel workers per wave (1-5, default 3).' },
        },
        required: ['objective'],
      },
    },
    async execute(params: ToolCallParams): Promise<ToolResult> {
      const parsed = inputSchema.safeParse(params.input)
      if (!parsed.success) return { content: `Invalid input: ${parsed.error.message}`, isError: true }
      const { mode, objective, planPath, planMarkdown, maxParallel } = parsed.data

      let markdown = planMarkdown
      if (!markdown && planPath) {
        const safe = validatePathSafe(params.cwd, planPath)
        if (!safe.ok) return { content: `team_orchestrate blocked: ${safe.error}`, isError: true }
        try {
          markdown = readFileSync(safe.path, 'utf8')
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { content: `team_orchestrate blocked: cannot read planPath "${planPath}": ${msg}`, isError: true }
        }
      }

      let summary: TeamRunSummary
      try {
        summary = await runTeamSkeleton(
          { mode, objective, planMarkdown: markdown, maxParallel, parentTurnId: params.toolUseId, abortSignal: params.abortSignal },
          {
            delegateBatch: (requests, policy, abortSignal, onProgress) =>
              coordinator.delegateBatch(requests, policy, abortSignal, onProgress),
          },
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: `team_orchestrate failed: ${msg}`, isError: true }
      }

      return {
        content: formatTeamSummary(summary),
        uiContent: `team ${mode}: ${summary.dispatched} dispatched / ${summary.blocked.length} blocked`,
        isError: false,
      }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    timeoutMs: () => 600_000,
  }
}
```

- [x] **步骤 4：运行测试确认通过**

运行：`npm exec -- tsx --test src/tools/__tests__/team-orchestrate.test.ts`
预期：PASS（2 测试）。

- [x] **步骤 5：注册工具到 main.tsx**

在 `src/main.tsx` 顶部 import 区加：

```ts
import { createTeamOrchestrateTool } from './tools/team-orchestrate.js'
```

在 `reg.register(createDelegateBatchTool({...}))` 块之后（约行 190）加：

```ts
reg.register(createTeamOrchestrateTool({
  delegate: async (request, abortSignal) => {
    if (!_coordinatorRef) throw new Error('DelegationCoordinator not initialized')
    return _coordinatorRef.delegate(request, abortSignal)
  },
  delegateBatch: async (requests, policy, abortSignal, onProgress) => {
    if (!_coordinatorRef) throw new Error('DelegationCoordinator not initialized')
    return _coordinatorRef.delegateBatch(requests, policy, abortSignal, onProgress)
  },
}))
```

- [x] **步骤 6：改写 buildTeamWorkflowPrompt 引导调用工具**

在 `src/workflows/ecosystem-workflows.ts` 的 `buildTeamWorkflowPrompt` 中，把"Suggested phases"段替换为（**保留** `delegate_batch` 字样以兼容现有断言）：

```ts
  return `我正在使用 ${modeLabel} 团队模式核心骨架执行任务。

User objective:
${objective}

Operating contract:
- User explicitly triggered team mode; do not ask whether to use it.
${planInstruction}
- Main controller (current session) owns integration, verification, and final deliver_task.
- MVP safety boundary: workers do NOT auto-commit/auto-merge. Treat worker output as patchSummary/diff evidence; integrate deliberately.

Suggested phases:
1. Call the team_orchestrate tool with { mode: '${options.mode}', objective, planPath? } to deterministically parse/group and dispatch the first wave. It serializes same-file writes and validates dependencies for you.
2. Inspect the returned worker diffs/findings (these come from delegate_batch workers under the hood); integrate the changes into the working tree.
3. To run the next wave, call team_orchestrate again with the same args plus fromWave: <previous+1> AFTER integrating the prior wave's diffs.
4. On the final wave, team_orchestrate runs the review gate automatically (L1/L2/L3 by change scale); address any blocking findings.
5. Verify with evidence (targeted tests + npx tsc --noEmit), then deliver_task with a checklist.
`
```

> 注：步骤 3/4 提到的 `fromWave` 与自动审查门分别在任务 3、任务 4 落地；此处先写入引导文案，工具届时即支持。

- [x] **步骤 7：更新 prompt 测试**

`src/workflows/__tests__/ecosystem-workflows.test.ts`：在"resolves /team into a team-mode workflow prompt"用例追加：

```ts
    assert.ok(resolved?.prompt.includes('team_orchestrate'))
```

`src/tui/__tests__/slash-commands.test.ts`：在"resolves /team into a team workflow prompt"用例追加：

```ts
    assert.ok(resolved.includes('team_orchestrate'))
```

（既有 `delegate_batch` / `/team max` 断言保持不变——新 prompt 已保留这些子串。）

- [x] **步骤 8：运行受影响测试 + 类型检查**

运行：
```bash
npm exec -- tsx --test src/tools/__tests__/team-orchestrate.test.ts src/workflows/__tests__/ecosystem-workflows.test.ts src/tui/__tests__/slash-commands.test.ts
npx tsc --noEmit
```
预期：全 PASS，tsc 0 error。

- [x] **步骤 9：Commit**

```bash
git add src/tools/team-orchestrate.ts src/tools/__tests__/team-orchestrate.test.ts src/main.tsx src/workflows/ecosystem-workflows.ts src/workflows/__tests__/ecosystem-workflows.test.ts src/tui/__tests__/slash-commands.test.ts
git commit -m "feat(team): wire engine into live path via team_orchestrate tool"
```

---

### 任务 2：max 模式 planner 扇出 + 视角解析

完成后 `/team max <objective>` 派 3 个视角 planner → 解析其结构化输出 → `mergePerspectives` → 分波 → 派首波。**机制落地，不评判视角质量**（视角是否真分化属 V3，不在此）。

**文件：**
- 修改：`src/agent/team-perspectives.ts`（新增 `buildPlannerObjective`、`parsePerspectiveResult`）
- 修改：`src/agent/team-orchestrator.ts`（max 分支重写）
- 修改：`src/agent/__tests__/team-perspectives.test.ts`、`src/agent/__tests__/team-orchestrator.test.ts`

- [x] **步骤 1：编写失败的视角解析测试**

`src/agent/__tests__/team-perspectives.test.ts` 顶部补 import 并新增：

```ts
import { buildPlannerObjective, parsePerspectiveResult } from '../team-perspectives.js'
import type { WorkerResult } from '../work-order.js'

test('buildPlannerObjective carries perspective + schema instruction', () => {
  const obj = buildPlannerObjective('tianquan', 'refactor the loop')
  assert.match(obj, /天权/)
  assert.match(obj, /perspective-plan/)
  assert.match(obj, /refactor the loop/)
})

test('parsePerspectiveResult extracts embedded plan from artifact', () => {
  const plan = {
    perspective: 'tianquan',
    summary: 's',
    tasks: [{ id: 'T1', title: 't', objective: 'o', files: ['src/a.ts'], profile: 'patcher', kind: 'patch_proposal', verification: [], dependsOn: [], riskTier: 'low', touchSet: ['src/a.ts'] }],
  }
  const result: WorkerResult = {
    workOrderId: 'team:planner-tianquan', status: 'passed', summary: 'done',
    findings: [], artifacts: [{ kind: 'note', title: 'perspective-plan', content: JSON.stringify(plan) }],
    changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'verified',
  }
  const parsed = parsePerspectiveResult('tianquan', result)
  assert.equal(parsed.tasks.length, 1)
  assert.equal(parsed.tasks[0]!.id, 'T1')
})

test('parsePerspectiveResult degrades gracefully without artifact', () => {
  const result: WorkerResult = {
    workOrderId: 'x', status: 'passed', summary: 'sum',
    findings: [], artifacts: [], changedFiles: [], risks: ['r1'], nextActions: [], evidenceStatus: 'verified',
  }
  const parsed = parsePerspectiveResult('tianfu', result)
  assert.equal(parsed.perspective, 'tianfu')
  assert.deepEqual(parsed.blockers, ['r1'])
})
```

- [x] **步骤 2：运行确认失败**

运行：`npm exec -- tsx --test src/agent/__tests__/team-perspectives.test.ts`
预期：FAIL，`buildPlannerObjective is not a function`。

- [x] **步骤 3：实现两个 helper**

在 `src/agent/team-perspectives.ts` 顶部补 import：

```ts
import type { TeamTask, RiskItem } from './team-plan.js'
import type { WorkerResult } from './work-order.js'
```

在文件末尾追加：

```ts
// ── Planner fanout helpers (max mode) ───────────────────────────────────────

const PERSPECTIVE_BRIEFS: Record<TeamPerspectivePlan['perspective'], string> = {
  tianquan: '你是天权 planner。职责：依赖分析、任务拆解、执行顺序，产出任务主图。',
  tianfu: '你是天府 risk reviewer。职责：风险评估、验证门禁、回归测试、串行约束；遇歧义 fail-closed。',
  tianxuan: '你是天璇 challenger。职责：定向反证、盲区发现、备选方案；质疑前提。',
}

/** Build the objective for one perspective planner. The stance rides in the
 *  objective text; the worker is read-only and embeds its plan as an artifact. */
export function buildPlannerObjective(
  perspective: TeamPerspectivePlan['perspective'],
  mission: string,
): string {
  return [
    PERSPECTIVE_BRIEFS[perspective],
    '',
    `Mission: ${mission}`,
    '',
    'Read the relevant code, then return a JSON WorkerResult whose `artifacts` contains ONE entry:',
    '{ "kind": "note", "title": "perspective-plan", "content": "<a JSON string of your TeamPerspectivePlan>" }',
    '',
    'TeamPerspectivePlan = { perspective, summary, tasks, dependencyNotes, risks, verification, blockers, alternatives }.',
    'Each task = { id, title, objective, files, profile, kind, verification, dependsOn, riskTier, touchSet }.',
    `Set perspective to "${perspective}".`,
  ].join('\n')
}

/** Parse a planner WorkerResult back into a TeamPerspectivePlan. Reads the
 *  embedded `perspective-plan` artifact; falls back to a degraded plan that
 *  carries the worker summary + risks as blockers (graceful degradation). */
export function parsePerspectiveResult(
  perspective: TeamPerspectivePlan['perspective'],
  result: WorkerResult,
): TeamPerspectivePlan {
  const artifact = result.artifacts.find(a => a.title === 'perspective-plan')
  if (artifact) {
    try {
      const raw = JSON.parse(artifact.content) as Parameters<typeof normalizePerspective>[1]
      return normalizePerspective(perspective, raw)
    } catch {
      // malformed JSON — fall through to degraded plan
    }
  }
  return normalizePerspective(perspective, { summary: result.summary, blockers: result.risks })
}
```

- [x] **步骤 4：运行确认通过**

运行：`npm exec -- tsx --test src/agent/__tests__/team-perspectives.test.ts`
预期：PASS。

- [x] **步骤 5：重写 team-orchestrator max 分支**

在 `src/agent/team-orchestrator.ts` 顶部补 import：

```ts
import { mergePerspectives, normalizePerspective, buildPlannerObjective, parsePerspectiveResult, type TeamPerspectivePlan } from './team-perspectives.js'
```

把 max 早退块（行 131-141）替换为：

```ts
  // max mode: fan out 3 perspective planners, merge deterministically, then
  // group + dispatch the first wave like standard mode.
  if (input.mode === 'max') {
    const perspectives = ['tianquan', 'tianfu', 'tianxuan'] as const
    const plannerRequests: DelegationRequest[] = perspectives.map(p => ({
      parentTurnId: `team:planner-${p}`,
      objective: buildPlannerObjective(p, input.objective),
      kind: 'plan',
      profile: 'reviewer', // read-only; stance carried via objective
      scope: {},
    }))
    const plannerRun = await deps.delegateBatch(plannerRequests, 'all_required', input.abortSignal)

    const planFor = (p: TeamPerspectivePlan['perspective']): TeamPerspectivePlan => {
      const res = plannerRun.results.find(r => r.workOrderId.includes(`planner-${p}`))
      return res ? parsePerspectiveResult(p, res) : normalizePerspective(p, {})
    }
    const merged = mergePerspectives(planFor('tianquan'), planFor('tianfu'), planFor('tianxuan'))
    const mergedTasks = merged.tasks

    const waves = groupTeamTasks(mergedTasks)
    const taskMap = new Map(mergedTasks.map(t => [t.id, t]))
    if (waves.length === 0) {
      return {
        mode: input.mode, planned: [], tasks: mergedTasks, waves: [], dispatched: 0,
        blocked: ['max planning produced no dispatchable tasks'],
        packet: 'team max: planners returned no tasks to dispatch.',
      }
    }
    const firstWave = waves[0]!
    const remainingBlocked = waves.slice(1).map(w => `${w.taskIds.join(', ')}: waiting for wave ${w.id}`)
    const requests = waveToRequests(firstWave, taskMap, input.parentTurnId ?? 'team')
    const run = await deps.delegateBatch(requests, 'all_required', input.abortSignal)
    return {
      mode: input.mode, planned: [], tasks: mergedTasks, waves, dispatched: requests.length,
      blocked: remainingBlocked, packet: run.packet, run,
    }
  }
```

- [x] **步骤 6：重写被打破的 max 测试**

在 `src/agent/__tests__/team-orchestrator.test.ts` 删除"does not auto-dispatch execution workers in max skeleton mode"（行 106-118），替换为：

```ts
  it('max mode fans out 3 perspective planners then dispatches merged waves', async () => {
    const calls: DelegationRequest[][] = []
    const summary = await runTeamSkeleton({ mode: 'max', objective: 'design the subsystem from scratch' }, {
      delegateBatch: async (requests) => {
        calls.push(requests)
        const isPlannerBatch = requests.some(r => r.parentTurnId.includes('planner-'))
        if (isPlannerBatch) {
          const plan = { perspective: 'tianquan', tasks: [{ id: 'T1', title: 'impl', objective: 'impl', files: ['src/x.ts'], profile: 'patcher', kind: 'patch_proposal', verification: [], dependsOn: [], riskTier: 'low', touchSet: ['src/x.ts'] }] }
          return {
            status: 'completed', packet: 'planned',
            results: requests.map(r => ({
              workOrderId: r.parentTurnId.includes('tianquan') ? 'team:planner-tianquan'
                : r.parentTurnId.includes('tianfu') ? 'team:planner-tianfu' : 'team:planner-tianxuan',
              status: 'passed' as const, summary: 'p', findings: [],
              artifacts: r.parentTurnId.includes('tianquan') ? [{ kind: 'note' as const, title: 'perspective-plan', content: JSON.stringify(plan) }] : [],
              changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'verified' as const,
            })),
          }
        }
        return { status: 'completed', results: [], packet: 'executed' }
      },
    })
    assert.equal(calls.length, 2) // 1 planner batch + 1 execution wave
    assert.ok(calls[0]!.some(r => r.parentTurnId.includes('planner-tianquan')))
    assert.ok(summary.dispatched >= 1)
    assert.equal(summary.tasks.length, 1)
  })
```

- [x] **步骤 7：运行 orchestrator + perspectives 测试 + tsc**

运行：
```bash
npm exec -- tsx --test src/agent/__tests__/team-orchestrator.test.ts src/agent/__tests__/team-perspectives.test.ts
npx tsc --noEmit
```
预期：全 PASS，0 error。

- [x] **步骤 8：Commit**

```bash
git add src/agent/team-perspectives.ts src/agent/team-orchestrator.ts src/agent/__tests__/team-perspectives.test.ts src/agent/__tests__/team-orchestrator.test.ts
git commit -m "feat(team): max mode planner fanout + perspective result parsing"
```

---

### 任务 3：多波次续派（fromWave）

完成后主控可在集成上一波 diff 后，用 `fromWave` 续派下一波。波次跨调用由主控驱动（尊重"worker 不自动 merge"约束：跨波代码依赖靠主控在两次调用间集成）。

**文件：**
- 修改：`src/agent/team-orchestrator.ts`（`TeamRunInput` 加 `fromWave`；抽 `dispatchWaveAt` 统一标准/max 派发）
- 修改：`src/tools/team-orchestrate.ts`（input 加 `fromWave`；输出续派提示）
- 修改：`src/agent/__tests__/team-orchestrator.test.ts`

- [x] **步骤 1：编写失败的 fromWave 测试**

在 `team-orchestrator.test.ts` 的"wave dispatch" describe 内新增：

```ts
  it('dispatches a later wave when fromWave is set', async () => {
    let captured: DelegationRequest[] = []
    const md = `
### T1: First edit
修改 src/a.ts

### T2: Second edit
修改 src/a.ts
`
    const summary = await runTeamSkeleton({
      mode: 'standard', objective: 'serialize', planMarkdown: md, fromWave: 1,
    }, {
      delegateBatch: async (requests) => { captured = requests; return run('wave2') },
    })
    // Same-file T1/T2 serialize into 2 waves; fromWave:1 dispatches the 2nd (T2)
    assert.ok(summary.waves.length >= 2)
    assert.ok(captured.some(r => r.parentTurnId.includes('T2')))
    assert.ok(!captured.some(r => r.parentTurnId.includes('T1')))
  })

  it('reports completion when fromWave is past the last wave', async () => {
    const summary = await runTeamSkeleton({
      mode: 'standard', objective: 'done', fromWave: 9,
      planMarkdown: '### T1: only\n修改 src/a.ts',
    }, { delegateBatch: async () => run() })
    assert.equal(summary.dispatched, 0)
    assert.match(summary.packet, /all .* waves dispatched/)
  })
```

- [x] **步骤 2：运行确认失败**

运行：`npm exec -- tsx --test src/agent/__tests__/team-orchestrator.test.ts`
预期：FAIL（`fromWave` 未生效，第 2 个用例 packet 不匹配 / 第 1 个派的是 T1）。

- [x] **步骤 3：加 fromWave + 抽 dispatchWaveAt**

在 `TeamRunInput` 接口加字段：

```ts
export interface TeamRunInput {
  mode: 'standard' | 'max'
  objective: string
  planMarkdown?: string
  maxParallel?: number
  parentTurnId?: string
  abortSignal?: AbortSignal
  /** Dispatch this wave index (default 0). Main controller increments after
   *  integrating each wave's diffs to drive multi-wave execution. */
  fromWave?: number
}
```

在文件内新增共享 helper（放在 `runTeamSkeleton` 之前）：

```ts
async function dispatchWaveAt(
  waves: TeamWave[],
  taskMap: Map<string, TeamTask>,
  tasks: TeamTask[],
  planned: TeamTaskDraft[],
  input: TeamRunInput,
  deps: TeamOrchestratorDeps,
): Promise<TeamRunSummary> {
  const fromWave = Math.max(0, input.fromWave ?? 0)
  if (waves.length === 0) {
    return { mode: input.mode, planned, tasks, waves: [], dispatched: 0, blocked: [], packet: 'team: no dispatchable waves.' }
  }
  if (fromWave >= waves.length) {
    return { mode: input.mode, planned, tasks, waves, dispatched: 0, blocked: [], packet: `team: all ${waves.length} waves dispatched.` }
  }
  const targetWave = waves[fromWave]!
  const remainingBlocked = waves.slice(fromWave + 1).map(w => `${w.taskIds.join(', ')}: waiting for wave ${w.id}`)
  const requests = waveToRequests(targetWave, taskMap, input.parentTurnId ?? 'team')
  if (requests.length === 0) {
    return { mode: input.mode, planned, tasks, waves, dispatched: 0, blocked: remainingBlocked, packet: `team: wave ${targetWave.id} produced no dispatchable requests.` }
  }
  const run = await deps.delegateBatch(requests, 'all_required', input.abortSignal)
  return {
    mode: input.mode, planned, tasks, waves, dispatched: requests.length,
    blocked: remainingBlocked, packet: `[wave ${fromWave + 1}/${waves.length}] ${run.packet}`, run,
  }
}
```

然后把 max 分支结尾（任务 2 写的 firstWave 段）与标准 wave 分支（行 178-208）都替换为：

```ts
    return dispatchWaveAt(waves, taskMap, mergedTasks /* 或 enrichedTasks */, input.mode === 'max' ? [] : drafts, input, deps)
```

（max 传 `mergedTasks` + `[]`；标准传 `enrichedTasks` + `drafts`。legacy `selectDispatchableTeamTasks` fallback 路径保持不变，因为它不基于 waves。）

- [x] **步骤 4：tool input 加 fromWave + 续派提示**

`src/tools/team-orchestrate.ts`：inputSchema 加 `fromWave: z.number().int().min(0).optional()`，传入 `runTeamSkeleton`；`formatTeamSummary` 末尾加：

```ts
  if (summary.waves.length > 0) {
    const next = Math.max(0, /* fromWave */ 0) // 由调用处替换为实际 fromWave+1 提示
    lines.push(`\nTo run the next wave: call team_orchestrate again with fromWave: <current+1> after integrating this wave's diffs.`)
  }
```

> 实现提示：把 `fromWave` 透传进 `execute`，并在 content 末尾明确告知下一个 `fromWave` 值（`(parsed.data.fromWave ?? 0) + 1`），仅当还有剩余波次时。

- [x] **步骤 5：运行测试 + tsc**

运行：
```bash
npm exec -- tsx --test src/agent/__tests__/team-orchestrator.test.ts src/tools/__tests__/team-orchestrate.test.ts
npx tsc --noEmit
```
预期：全 PASS，0 error。

- [x] **步骤 6：Commit**

```bash
git add src/agent/team-orchestrator.ts src/tools/team-orchestrate.ts src/agent/__tests__/team-orchestrator.test.ts
git commit -m "feat(team): multi-wave continuation via fromWave (main-controller driven)"
```

---

### 任务 4：team 审查门（独立于 fix: commit）

完成后最后一波派完且有文件变更时，`team_orchestrate` 自动调 `routeReviewWorkflow`（L1 nudge / L2 verifier / L3 squadron，按变更规模），feature/refactor 也被审查。复用现成审查基础设施，审查 worker 是独立 session（满足"审查者≠实现者"纪律）。

**文件：**
- 修改：`src/tools/team-orchestrate.ts`（最后一波后跑审查门）
- 修改：`src/tools/__tests__/team-orchestrate.test.ts`

- [x] **步骤 1：编写失败的审查门测试**

在 `team-orchestrate.test.ts` 新增：

```ts
test('team_orchestrate runs the review gate on a cross-module final wave', async () => {
  let squadronInvoked = false
  const tool = createTeamOrchestrateTool({
    delegate: async () => stubRun(),
    delegateBatch: async (requests) => {
      // squadron uses 'reviewer' profile + kind 'review'
      if (requests.every(r => r.kind === 'review')) {
        squadronInvoked = true
        return { status: 'completed', results: [], packet: 'reviewed' }
      }
      // execution wave: report changed files spanning 2 modules → L3
      return {
        status: 'completed', packet: 'executed',
        results: [{ workOrderId: 'w', status: 'passed', summary: 's', findings: [], artifacts: [], changedFiles: ['src/agent/a.ts', 'src/tui/b.ts', 'src/tools/c.ts', 'src/api/d.ts'], risks: [], nextActions: [], evidenceStatus: 'verified' }],
      }
    },
  })
  const md = '### T1: change\n修改 `src/agent/a.ts`'
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'feature work', planMarkdown: md, fromWave: 0 },
    cwd: process.cwd(), toolUseId: 'tu-rev',
  } as never)
  assert.equal(result.isError, false)
  assert.match(result.content, /Review gate/)
  assert.equal(squadronInvoked, true)
})
```

- [x] **步骤 2：运行确认失败**

运行：`npm exec -- tsx --test src/tools/__tests__/team-orchestrate.test.ts`
预期：FAIL（无 "Review gate" 字样，squadron 未触发）。

- [x] **步骤 3：在工具中接审查门**

`src/tools/team-orchestrate.ts` 补 import：

```ts
import { routeReviewWorkflow } from '../agent/review-router.js'
import { createCoordinatorReviewDeps } from '../agent/review-coordinator-deps.js'
import { isCrossModule, isFixContext, type ChangeSet } from '../agent/review-discipline.js'
```

在 `execute` 内、`return` 之前插入：

```ts
      // Review gate: on the final wave with changes, route the change set through
      // L1/L2/L3 review — independent of any fix: commit message.
      let reviewNote = ''
      const fromWave = parsed.data.fromWave ?? 0
      const isLastWave = summary.waves.length > 0 && fromWave >= summary.waves.length - 1
      const changedFiles = summary.run
        ? [...new Set(summary.run.results.flatMap(r => r.changedFiles))]
        : []
      if (isLastWave && changedFiles.length > 0) {
        const change: ChangeSet = {
          files: changedFiles,
          crossModule: isCrossModule(changedFiles),
          isFix: isFixContext(objective),
        }
        const reviewDeps = createCoordinatorReviewDeps(
          { delegate: coordinator.delegate, delegateBatch: coordinator.delegateBatch },
          { reviewDepth: params.reviewDepth ?? 0, abortSignal: params.abortSignal },
        )
        const outcome = await routeReviewWorkflow(change, reviewDeps, { maxRounds: 3 })
        reviewNote = `\n\nReview gate [${outcome.tier}]: ${outcome.verdict}${outcome.evidence ? ` — ${outcome.evidence}` : ''}`
      }

      return {
        content: formatTeamSummary(summary) + reviewNote,
        uiContent: `team ${mode}: ${summary.dispatched} dispatched / ${summary.blocked.length} blocked`,
        isError: false,
      }
```

（删除原先的单一 `return`；确保只有这一个返回点。）

> 注：`createCoordinatorReviewDeps` 的 `delegate`/`delegateBatch` 引用直接来自工具的 `coordinator` 形参——因 `TeamOrchestrateCoordinator` 在任务 1 已含 `delegate`，无需改 main.tsx。`timeoutMs` 已设 600s，可覆盖"末波 + squadron 4 Inspector"；若实测不足，提升至 900_000（落地后按需）。

- [x] **步骤 4：运行确认通过 + tsc**

运行：
```bash
npm exec -- tsx --test src/tools/__tests__/team-orchestrate.test.ts
npx tsc --noEmit
```
预期：全 PASS，0 error。

- [x] **步骤 5：Commit**

```bash
git add src/tools/team-orchestrate.ts src/tools/__tests__/team-orchestrate.test.ts
git commit -m "feat(team): auto review gate on final wave, independent of fix commit"
```

---

### 任务 5：模型路由（config + 文档，薄落地）

确认 team 的规划/执行经现有 CapabilityTask 路由天然分流，补 config 示例与文档，让"规划走强模型、执行可走 flash"可配置。**不改全局 `recommendModelForTask` 默认**（避免影响非 team 委派）。

**文件：**
- 修改：`src/agent/__tests__/team-orchestrator.test.ts`（断言 planner/executor 的 kind 分流）
- 修改：`docs/superpowers/plans/2026-06-07-team-mode-v2-status.md`（追加 routing config 段）

- [x] **步骤 1：编写路由分流断言测试**

在 `team-orchestrator.test.ts` 新增（基于任务 2 的 max stub，断言 planner 用 `kind:'plan'`）：

```ts
  it('routes planners via kind=plan and executors via kind=patch_proposal', async () => {
    const kinds: string[] = []
    await runTeamSkeleton({ mode: 'max', objective: 'design a coherent subsystem now' }, {
      delegateBatch: async (requests) => {
        for (const r of requests) kinds.push(`${r.parentTurnId.includes('planner-') ? 'planner' : 'exec'}:${r.kind}`)
        const isPlanner = requests.some(r => r.parentTurnId.includes('planner-'))
        if (isPlanner) {
          const plan = { perspective: 'tianquan', tasks: [{ id: 'T1', title: 'x', objective: 'x', files: ['src/x.ts'], profile: 'patcher', kind: 'patch_proposal', verification: [], dependsOn: [], riskTier: 'low', touchSet: ['src/x.ts'] }] }
          return { status: 'completed', packet: 'p', results: requests.map(r => ({ workOrderId: r.parentTurnId.includes('tianquan') ? 'team:planner-tianquan' : r.parentTurnId.includes('tianfu') ? 'team:planner-tianfu' : 'team:planner-tianxuan', status: 'passed' as const, summary: 'p', findings: [], artifacts: r.parentTurnId.includes('tianquan') ? [{ kind: 'note' as const, title: 'perspective-plan', content: JSON.stringify(plan) }] : [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'verified' as const })) }
        }
        return { status: 'completed', results: [], packet: 'e' }
      },
    })
    assert.ok(kinds.some(k => k === 'planner:plan'))
    assert.ok(kinds.some(k => k === 'exec:patch_proposal'))
  })
```

- [x] **步骤 2：运行确认通过**

运行：`npm exec -- tsx --test src/agent/__tests__/team-orchestrator.test.ts`
预期：PASS（planner 已用 `kind:'plan'`，executor 用 `patch_proposal`——任务 2 已落地此分流，本测试是回归锁）。

- [x] **步骤 3：文档化 config 路由**

在 `2026-06-07-team-mode-v2-status.md` 末尾追加一节：

```markdown
## 7. 模型路由（V2 落地）

team 的规划与执行经现有 CapabilityTask 路由天然分流，按 `config.workers.routing` 映射：

| 阶段 | WorkOrderKind | CapabilityTask | 建议路由 |
|------|--------------|----------------|---------|
| max 规划 (天权/天府/天璇) | plan | code_edit | 强模型 (primary) |
| 执行 (天梁/patcher) | patch_proposal | risky_refactor | 可配 flash/cheap |
| 审查 (squadron/verifier) | review/verify | risky_refactor/test_failure_diagnosis | 强模型 |

示例 `config.workers`：

\`\`\`yaml
workers:
  profiles:
    strong: { provider: deepseek, model: deepseek-v4-pro }
    cheap:  { provider: deepseek, model: deepseek-chat-flash }
  routing:
    code_edit: strong          # max 规划用强模型
    risky_refactor: strong     # 执行/审查默认强；如需省成本可改 cheap
    test_failure_diagnosis: strong
\`\`\`

缺省（无 routing）时 `recommendModelForTask` 已把 code_edit/risky_refactor 路由到 capable 模型，flash 仅接 summarization——即"规划/执行默认都用强模型，要省成本须显式配 cheap"。不改此默认以免影响非 team 委派。
```

- [x] **步骤 4：Commit**

```bash
git add src/agent/__tests__/team-orchestrator.test.ts docs/superpowers/plans/2026-06-07-team-mode-v2-status.md
git commit -m "docs(team): document config-driven model routing for plan/exec/review"
```

---

## 5. 验证

每个任务 commit 前至少跑该任务涉及的测试文件 + `npx tsc --noEmit`。全部任务完成后跑一次全量回归（确认引擎接线未连坐其它模块）：

```bash
npx tsc --noEmit
npm test
```

预期：tsc 0 error；全量测试通过（V1 的 45 team 测试 + 新增约 8 个 = 53+，加全仓既有测试）。

手动 dogfood（落地验证，第一个真实任务）：
```
/team docs/superpowers/plans/<某个小型计划>.md
```
观察：team_orchestrate 被调、返回 wave 计划、首波 worker 返回 diff、末波后出现 "Review gate" 行。再用 `fromWave:1` 续派验证多波。

---

## 6. 自检

**1. 规格覆盖（对照 v2-status §3 的 P0/P1）：**
- P0 `/team max` 接 planner → 任务 2 ✅
- P0 多波次执行 loop → 任务 3（fromWave，主控驱动）✅
- P1 team review gate → 任务 4 ✅
- P1 profile routing → 任务 5（config 落地）✅
- 引擎接线（被 v2-status 遗漏的真正 keystone）→ 任务 1 ✅

**2. 占位符扫描：** 无 TODO/待定；每个代码步骤含完整代码或精确编辑描述（如 main.tsx 注册块、prompt 替换段、max 分支替换段均给出完整代码）。任务 3 步骤 4 的 `formatTeamSummary` 续派提示给了实现提示而非完整行——已标注"实现提示"，执行者据此补 `(fromWave ?? 0)+1`，非占位符。

**3. 类型/签名一致性：**
- `TeamOrchestrateCoordinator` 在任务 1 定义即含 `delegate` + `delegateBatch`，任务 4 直接复用，无签名漂移。
- `buildPlannerObjective` / `parsePerspectiveResult`（任务 2 定义）在任务 2 max 分支消费，名称一致。
- `dispatchWaveAt`（任务 3 定义）签名 `(waves, taskMap, tasks, planned, input, deps)`，标准/max 调用一致。
- `runTeamSkeleton` 的 `TeamRunInput.fromWave` 任务 3 加入，任务 1 工具透传 `planMarkdown`（任务 1 已在 input 加 `planMarkdown`，与现有 `TeamRunInput.planMarkdown` 字段对齐）。
- `ChangeSet = {files, crossModule, isFix}`、`routeReviewWorkflow(change, deps, {maxRounds})`、`createCoordinatorReviewDeps(coordinator, options)`、`validatePathSafe(...).path` 均与源码签名核对一致。

**已知边界（落地后按"哪里不够哪里改"优化，不阻塞落地）：**
- 跨波代码依赖靠主控在两次 `team_orchestrate` 调用间集成 diff（worker 不自动 merge，Phase 7 后置）。
- max 视角是否真分化属 V3（worker 星域注入）；本计划只落机制，三视角即便雷同也先跑通。
- 审查门在工具内同步跑，末波 + squadron 可能逼近 600s 超时；实测不足则提 timeout。

---

## 7. 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-06-07-team-mode-v2-landing.md`。两种执行方式：

**1. 子代理驱动（推荐）** — 每个任务调度一个新的子代理，任务间进行审查，快速迭代。

**2. 内联执行** — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？

---

## 8. 天权评审裁决（2026-06-07，天枢 owner 评估）

天权给出 3 修正 + 2 建议；天枢逐条以代码证据裁决：

| 项 | 天权意见 | 裁决 | 依据 / 落地 |
|----|---------|------|------------|
| P1 | `parsePerspectiveResult` 不要裸 `JSON.parse`，复用 `extractJsonCandidates` | **采纳** | 模型常输出 ```json 围栏/夹散文，裸 parse 易过早掉降级。**Task 2 改**：从 `work-order.ts` 导出 `extractJsonCandidates`（现私有），`parsePerspectiveResult` 改为"逐候选 try-parse → normalizePerspective，全败再降级到 `{summary, blockers}`"。 |
| P2 | `dispatchWaveAt` 参数过多 → `WaveDispatchContext` | **采纳** | **Task 3 改**签名为 `dispatchWaveAt(waves: TeamWave[], waveIndex: number, ctx: WaveDispatchContext)`，`WaveDispatchContext = { taskMap, tasks, planned, input, deps }`。 |
| P3 | `routeReviewWorkflow` 签名/`ChangeSet` 需验证 | **已验证一致，无需改** | `review-router.ts:80` `routeReviewWorkflow(change: ChangeSet, deps: ReviewRouterDeps, options: ReviewRouterOptions = {})`；`review-discipline.ts:31` `ChangeSet = {files, crossModule, isFix}`；Task 4 步骤 3 调用逐字匹配。（此点天权未读新代码。） |
| S1 | Task 1 stub 只需 `delegateBatch` | **采纳** | Task 1 接口 `delegate?` 改可选；测试 stub 省略 `delegate`；main.tsx 仍注入两者；Task 4 用 `delegate` 时断言存在。**已在 Task 1 执行落地。** |
| S2 | Task 5 用 `feat:` 非 `docs:` | **部分采纳** | Task 5 不改 routing 默认（非行为变更），不宜 `feat`；含真实回归测试 → 定 `test(team):`。 |

P1/P2 在执行对应任务时落地并回写本文；S1/S2 已分别在 Task 1 执行 / Task 5 提交规范中落地。
