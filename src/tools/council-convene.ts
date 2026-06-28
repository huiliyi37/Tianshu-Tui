import { z } from 'zod'
import type { AggregationPolicy } from '../agent/work-order.js'
import type { CoordinatorRun, DelegationRequest } from '../agent/coordinator.js'
import { runCouncil, runCouncilDebate, type CouncilDeps } from '../agent/council/council-orchestrator.js'
import { summarizeCouncilPlan } from '../agent/council/council-render.js'
import { DEFAULT_COUNCIL_SEATS, type CouncilSeat, type CouncilRoutingShadowEvent } from '../agent/council/council-routing.js'
import { isCouncilEnabled } from '../agent/council/council-gate.js'
import { buildCouncilSessionEvent, type CouncilSessionEvent } from '../agent/council/council-telemetry.js'
import type { PlanItem } from '../agent/council/council-plan.js'
import { councilPlanToUnifiedPlan } from '../agent/council/council-to-plan.js'
import { serializeUnifiedPlan } from '../agent/unified-plan.js'
import type { Tool, ToolCallParams, ToolResult } from './types.js'

/** Coordinator surface the council tool needs — only `delegateBatch` drives the
 *  single-round seat fanout. Telemetry/shadow recorders are optional旁路. */
export interface CouncilConveneCoordinator {
  delegateBatch(
    requests: DelegationRequest[],
    policy?: AggregationPolicy,
    abortSignal?: AbortSignal,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<CoordinatorRun>
  getSessionId?: () => string | undefined
  recordRoutingShadow?: (event: CouncilRoutingShadowEvent) => void
  recordCouncilSession?: (event: CouncilSessionEvent) => void
}

// DEFAULT_COUNCIL_SEATS 下沉至 council-routing.ts（CouncilSeat 定义所在），此处
// re-export 保持既有 `import { DEFAULT_COUNCIL_SEATS } from '../council-convene.js'` 调用面。
export { DEFAULT_COUNCIL_SEATS } from '../agent/council/council-routing.js'

const planItemSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  detail: z.string(),
  files: z.array(z.string()).optional(),
})

const seatSchema = z.object({
  authority: z.string().min(1),
  charter: z.string().optional(),
  tierHint: z.enum(['cheap', 'balanced', 'strong']).optional(),
  noDowngrade: z.boolean().optional(),
})

const inputSchema = z.object({
  objective: z.string().min(1),
  draftItems: z.array(planItemSchema).optional(),
  seats: z.array(seatSchema).optional(),
  rounds: z.number().int().min(1).max(2).optional(),
  /** When true, automatically dispatch the council-approved plan to team_orchestrate.
   *  Saves a model round-trip — the council result directly triggers execution
   *  instead of waiting for the model to extract planJson and call team_orchestrate. */
  autoExecute: z.boolean().optional(),
})
export function createCouncilConveneTool(coordinator: CouncilConveneCoordinator): Tool {
  return {
    definition: {
      name: 'council_convene',
      description:
        'Convene a star-domain council to review a plan draft. Default is a single advisory round; pass rounds:2+ to enable a rebuttal/debate round (round 2 only fires when round 1 surfaces conflicts). Fans out to seat experts (advisory only, no execution), deterministically adjudicates, and returns an auditable Markdown plan. Pass autoExecute:true to automatically dispatch the approved plan to team_orchestrate — the plan executes immediately after review without a model round-trip. Disabled when COUNCIL=0.',
      input_schema: {
        type: 'object',
        properties: {
          objective: { type: 'string', description: 'The plan objective to review.' },
          draftItems: {
            type: 'array',
            description: 'Optional draft plan items to put before the council.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                detail: { type: 'string' },
                files: { type: 'array', items: { type: 'string' }, description: 'Files this item touches (for team wave grouping).' },
              },
              required: ['id', 'title', 'detail'],
            },
          },
          seats: {
            type: 'array',
            description: 'Optional seat overrides. Defaults to tianquan/tianfu/tianxuan.',
            items: {
              type: 'object',
              properties: {
                authority: { type: 'string' },
                charter: { type: 'string' },
                tierHint: { type: 'string', enum: ['cheap', 'balanced', 'strong'] },
                noDowngrade: { type: 'boolean' },
              },
              required: ['authority'],
            },
          },
          rounds: { type: 'number', description: 'Max debate rounds (1-2, default 1 = single round). Pass 2 to enable a rebuttal round; round 2 only fires when round 1 surfaces conflicts.' },
          autoExecute: { type: 'boolean', description: 'When true, automatically dispatch the council-approved plan to team_orchestrate. Saves a model round-trip — the plan executes immediately after council review instead of waiting for manual extraction.' },
        },
        required: ['objective'],
      },
    },
    async execute(params: ToolCallParams): Promise<ToolResult> {
      if (!isCouncilEnabled()) {
        return { content: 'council_convene disabled (COUNCIL=0) — no seats dispatched', isError: false }
      }
      const parsed = inputSchema.safeParse(params.input)
      if (!parsed.success) return { content: `Invalid input: ${parsed.error.message}`, isError: true }
      const { objective, draftItems, seats, rounds, autoExecute } = parsed.data

      const items: PlanItem[] = draftItems ?? []
      const councilSeats: CouncilSeat[] = (seats && seats.length > 0 ? seats : [...DEFAULT_COUNCIL_SEATS]).map(s => ({
        authority: s.authority,
        ...(s.charter ? { charter: s.charter } : {}),
        ...(s.tierHint ? { tierHint: s.tierHint } : {}),
        ...(s.noDowngrade !== undefined ? { noDowngrade: s.noDowngrade } : {}),
      }))

      const deps: CouncilDeps = {
        delegateBatch: async (requests, policy, signal, onProgress) => {
          const run = await coordinator.delegateBatch(requests as unknown as DelegationRequest[], policy, signal, onProgress)
          return { results: run.results, workerModels: run.workerModels }
        },
        now: () => Date.now(),
        ...(coordinator.getSessionId ? { sessionId: coordinator.getSessionId() } : {}),
        ...(coordinator.recordRoutingShadow ? { recordRoutingShadow: coordinator.recordRoutingShadow } : {}),
        // 实时进度：每席完成时通过工具流式输出推送到 UI。
        // seat 参数在并行场景下为 "N/total" 计数而非具体席位名（见 council-orchestrator 注释）。
        onSeatProgress: params.onOutput
          ? (seat, _status) => { params.onOutput?.(`♟ ${seat} 席完成\n`) }
          : undefined,
      }

      let plan
      try {
        // 分两层入口：默认走单轮 runCouncil；显式 rounds≥2 才走多轮层 runCouncilDebate。
        const runner = (rounds && rounds >= 2) ? runCouncilDebate : runCouncil
        plan = await runner({ draft: { objective, items }, seats: councilSeats, ...(rounds ? { maxRounds: rounds } : {}), ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}) }, deps)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: `council_convene failed: ${msg}`, isError: true }
      }

      // append-only 遥测旁路 —— 绝不影响返回。
      if (coordinator.recordCouncilSession) {
        try {
          coordinator.recordCouncilSession(buildCouncilSessionEvent({
            sessionId: coordinator.getSessionId?.() ?? 'unknown',
            plan,
            timestamp: Date.now(),
          }))
        } catch {
          // 遥测失败不影响交付。
        }
      }

      // content: 全文议事记录 markdown(进 model 上下文,供其原样 echo 给用户)。
      // 末尾内嵌机器可读 planJson —— 供模型在用户确认执行时原样提取为
      // team_orchestrate 的 planJson(W-C7 评审→执行闭环)。仅在有任务时附加;
      // council 自身绝不触发执行,转交由模型在用户确认后完成。
      // uiContent: 紧凑裁决摘要 —— 工具卡默认仅展示前 4 行,避免裸 markdown 被截成无意义片段。
      const parts = [plan.finalPlanMarkdown]
      if (plan.aggregate.mergedItems.length > 0) {
        parts.push('', '```council-plan-json', serializeUnifiedPlan(councilPlanToUnifiedPlan(plan)), '```')
      }

      // autoExecute: if council produced actionable items, dispatch them directly
      // via coordinator.delegateBatch (same path team_orchestrate uses). This saves
      // a model round-trip — the plan executes immediately after review.
      if (autoExecute && plan.aggregate.mergedItems.length > 0) {
        try {
          const unifiedPlan = councilPlanToUnifiedPlan(plan)
          const { unifiedPlanToTeamTasks } = await import('../agent/unified-plan.js')
          const teamTasks = unifiedPlanToTeamTasks(unifiedPlan)
          if (teamTasks.length > 0) {
            // Convert TeamTask[] to DelegationRequest[] — TeamTask already has
            // profile/kind/objective/files, matching DelegationRequest's shape.
            const teamRequests = teamTasks.map(t => ({
              parentTurnId: params.toolUseId ?? 'council-autoexec',
              objective: t.objective,
              profile: t.profile,
              kind: t.kind,
              scope: { files: t.files, verification: t.verification },
            }))
            const run = await coordinator.delegateBatch(teamRequests, 'all_required', params.abortSignal)
            parts.push('', `## Auto-Executed (${run.results.length} workers)`)
            for (const r of run.results) {
              parts.push(`- ${r.workOrderId}: ${r.status === 'passed' ? '✓' : r.status === 'failed' ? '✗' : '⚠'} ${r.summary}`)
            }
          }
        } catch (err) {
          parts.push('', `## Auto-Execution Failed\n${err instanceof Error ? err.message : String(err)}`)
          parts.push('', '⚠ Council plan reviewed but auto-execution failed. Use the council-plan-json above with team_orchestrate manually.')
        }
      }

      return { content: parts.join('\n'), uiContent: summarizeCouncilPlan(plan), isError: false }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => isCouncilEnabled(),
    timeoutMs: () => 600_000,
  }
}
