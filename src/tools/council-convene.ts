import { z } from 'zod'
import type { AggregationPolicy } from '../agent/work-order.js'
import type { CoordinatorRun, DelegationRequest } from '../agent/coordinator.js'
import { runCouncil, type CouncilDeps } from '../agent/council/council-orchestrator.js'
import { summarizeCouncilPlan } from '../agent/council/council-render.js'
import type { CouncilSeat, CouncilRoutingShadowEvent } from '../agent/council/council-routing.js'
import { isCouncilEnabled } from '../agent/council/council-gate.js'
import { buildCouncilSessionEvent, type CouncilSessionEvent } from '../agent/council/council-telemetry.js'
import type { PlanItem } from '../agent/council/council-plan.js'
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

/** 缺省席位 —— 天权领航 · 天府护栏 · 天璇探索。调用方可经 seats 覆盖。 */
export const DEFAULT_COUNCIL_SEATS: readonly CouncilSeat[] = [
  { authority: 'tianquan', charter: '领航：把握方向与优先级' },
  { authority: 'tianfu', charter: '护栏：风险、边界与安全', tierHint: 'strong', noDowngrade: true },
  { authority: 'tianxuan', charter: '探索：方案空间与替代路径' },
]

const planItemSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  detail: z.string(),
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
})

export function createCouncilConveneTool(coordinator: CouncilConveneCoordinator): Tool {
  return {
    definition: {
      name: 'council_convene',
      description:
        'Convene a single-round star-domain council to review a plan draft. Fans out to seat experts (one advisory round, no execution), deterministically adjudicates their input, and returns an auditable Markdown plan. Decoupled from team_orchestrate — this NEVER dispatches execution work. Disabled when COUNCIL=0.',
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
        },
        required: ['objective'],
      },
    },
    async execute(params: ToolCallParams): Promise<ToolResult> {
      // Kill switch — defensive guard (isEnabled also hides the tool when off).
      if (!isCouncilEnabled()) {
        return { content: 'council_convene disabled (COUNCIL=0) — no seats dispatched', isError: false }
      }
      const parsed = inputSchema.safeParse(params.input)
      if (!parsed.success) return { content: `Invalid input: ${parsed.error.message}`, isError: true }
      const { objective, draftItems, seats } = parsed.data

      const items: PlanItem[] = draftItems ?? []
      const councilSeats: CouncilSeat[] = (seats && seats.length > 0 ? seats : [...DEFAULT_COUNCIL_SEATS]).map(s => ({
        authority: s.authority,
        ...(s.charter ? { charter: s.charter } : {}),
        ...(s.tierHint ? { tierHint: s.tierHint } : {}),
        ...(s.noDowngrade !== undefined ? { noDowngrade: s.noDowngrade } : {}),
      }))

      const deps: CouncilDeps = {
        delegateBatch: async (requests, policy, signal) => {
          const run = await coordinator.delegateBatch(requests as unknown as DelegationRequest[], policy, signal)
          return { results: run.results }
        },
        now: () => Date.now(),
        ...(coordinator.getSessionId ? { sessionId: coordinator.getSessionId() } : {}),
        ...(coordinator.recordRoutingShadow ? { recordRoutingShadow: coordinator.recordRoutingShadow } : {}),
      }

      let plan
      try {
        plan = await runCouncil({ draft: { objective, items }, seats: councilSeats, ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}) }, deps)
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
      // uiContent: 紧凑裁决摘要 —— 工具卡默认仅展示前 4 行,避免裸 markdown 被截成无意义片段。
      return { content: plan.finalPlanMarkdown, uiContent: summarizeCouncilPlan(plan), isError: false }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => isCouncilEnabled(),
    timeoutMs: () => 600_000,
  }
}
