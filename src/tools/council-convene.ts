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
import { serializeUnifiedPlan, unifiedPlanToTeamTasks } from '../agent/unified-plan.js'
import { storePlan } from '../agent/plan-store.js'
import { executePlan, type PlanExecutorDeps } from '../agent/plan-executor.js'
import type { Tool, ToolCallParams, ToolResult } from './types.js'

/** Coordinator surface the council tool needs — only `delegateBatch` drives the
 *  single-round seat fanout. Telemetry/shadow recorders are optional旁路.
 *  `executor` (A4) carries the full plan-execution deps so autoExecute runs the
 *  same closed loop (waves + review gate + wave gate + checkpoint) as
 *  team_orchestrate instead of a bare delegateBatch. */
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
  executor?: PlanExecutorDeps
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
  provider: z.string().optional(),
  model: z.string().optional(),
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
export function createCouncilConveneTool(
  coordinator: CouncilConveneCoordinator,
  /** Configured default seats (agent.council.seats). When non-empty, used as the
   *  default council instead of DEFAULT_COUNCIL_SEATS; per-call `seats` still wins. */
  defaultSeats?: CouncilSeat[],
): Tool {
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
            description: 'Optional seat overrides. Defaults to tianquan/tianfu/tianxuan (or agent.council.seats from config). Set provider+model on a seat to run it on a dedicated model (heterogeneous council).',
            items: {
              type: 'object',
              properties: {
                authority: { type: 'string' },
                charter: { type: 'string' },
                tierHint: { type: 'string', enum: ['cheap', 'balanced', 'strong'] },
                noDowngrade: { type: 'boolean' },
                provider: { type: 'string', description: 'Per-seat provider (must exist in config.provider.providers). Pair with model.' },
                model: { type: 'string', description: 'Per-seat model (must exist in the provider). Pair with provider.' },
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
      // Precedence: per-call seats > configured agent.council.seats > built-in default.
      const baseSeats: CouncilSeat[] = seats && seats.length > 0
        ? seats
        : (defaultSeats && defaultSeats.length > 0 ? defaultSeats : [...DEFAULT_COUNCIL_SEATS])
      const councilSeats: CouncilSeat[] = baseSeats.map(s => ({
        authority: s.authority,
        ...(s.charter ? { charter: s.charter } : {}),
        ...(s.tierHint ? { tierHint: s.tierHint } : {}),
        ...(s.noDowngrade !== undefined ? { noDowngrade: s.noDowngrade } : {}),
        // Per-seat provider/model → threaded as modelOverride by the orchestrator.
        ...(s.provider && s.model ? { provider: s.provider, model: s.model } : {}),
      }))

      // Seats bind to results by authority (workOrderId = `council:seat-<authority>`),
      // and the work queue dedupes by an authority-derived key. Two seats sharing an
      // authority would silently collapse to one worker AND double-count its
      // contribution — fail loud instead of dropping a seat the user asked for.
      const authorities = councilSeats.map(s => s.authority)
      const dupe = authorities.find((a, i) => authorities.indexOf(a) !== i)
      if (dupe) {
        return { content: `council_convene: 席位 authority 重复「${dupe}」—— 每席必须是不同的星域 id（议事会按 authority 绑定结果，重复会丢席并重复计票）。`, isError: true }
      }

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
      // 末尾内嵌机器可读 planJson 作为可读审计(W-C7 评审→执行闭环)。
      // A3: 有任务时同时把计划存入会话桥(plan-store) —— 模型无需手工提取 JSON,
      // 用户确认后直接调 team_orchestrate({ objective }) 即自动消费。
      // council 自身默认绝不触发执行(autoExecute 例外,走完整 executePlan 闭环)。
      // uiContent: 紧凑裁决摘要 —— 工具卡默认仅展示前 4 行,避免裸 markdown 被截成无意义片段。
      const parts = [plan.finalPlanMarkdown]
      const hasTasks = plan.aggregate.mergedItems.length > 0
      const unifiedPlan = hasTasks ? councilPlanToUnifiedPlan(plan) : undefined
      const planJson = unifiedPlan ? serializeUnifiedPlan(unifiedPlan) : undefined
      if (planJson) {
        parts.push('', '```council-plan-json', planJson, '```')
      }
      if (planJson && !autoExecute) {
        storePlan(planJson, params.sessionId)
        parts.push('', '✅ 计划已存入会话 — 用户确认后直接调用 `team_orchestrate({ objective })` 即可执行（不要传 planJson/planMarkdown，存储的计划会被自动消费）。上方 JSON 块仅作可读审计。')
      }

      // A4 autoExecute: run the council-approved plan through the SAME closed
      // loop as team_orchestrate — executePlan gives wave grouping (file
      // conflicts / dependsOn), scope health, the review gate, the wave hard
      // gate, and A1 checkpoints. Multi-wave plans are driven to completion here.
      if (autoExecute && unifiedPlan && planJson) {
        const executorDeps: PlanExecutorDeps = coordinator.executor ?? coordinator
        try {
          const teamTasks = unifiedPlanToTeamTasks(unifiedPlan)
          if (teamTasks.length > 0) {
            const waveLines: string[] = []
            let fromWave = 0
            let totalWaves = 1
            let workers = 0
            do {
              const run = await executePlan(
                {
                  mode: 'standard',
                  objective,
                  tasks: teamTasks,
                  fromWave,
                  sessionId: params.sessionId,
                  parentTurnId: `${params.toolUseId ?? 'council-autoexec'}:w${fromWave}`,
                  reviewDepth: params.reviewDepth ?? 0,
                  cwd: params.cwd,
                  abortSignal: params.abortSignal,
                  // The review gate needs a single-delegate channel; skip it when
                  // the caller wired only the bare fanout surface.
                  reviewGate: Boolean(executorDeps.delegate),
                },
                executorDeps,
              )
              totalWaves = Math.max(1, run.summary.waves.length)
              const results = run.summary.run?.results ?? []
              workers += results.length
              for (const r of results) {
                waveLines.push(`- [wave ${fromWave + 1}/${totalWaves}] ${r.workOrderId}: ${r.status === 'passed' ? '✓' : r.status === 'failed' ? '✗' : '⚠'} ${r.summary}`)
              }
              const noteBlock = [run.notes.reviewNote, run.notes.scopeHealthNote, run.notes.waveGateNote, run.notes.deliverySynthesis]
                .map(n => n.trim()).filter(Boolean)
              if (noteBlock.length > 0) waveLines.push(...noteBlock.map(n => `  ${n.replace(/\n/g, '\n  ')}`))
              fromWave++
            } while (fromWave < totalWaves)
            parts.push('', `## Auto-Executed (${workers} workers, ${totalWaves} waves)`)
            parts.push(...waveLines)
          }
        } catch (err) {
          parts.push('', `## Auto-Execution Failed\n${err instanceof Error ? err.message : String(err)}`)
          storePlan(planJson, params.sessionId)
          parts.push('', '⚠ Council plan reviewed but auto-execution failed. 计划已存入会话 — 修复失败项后直接调用 `team_orchestrate({ objective })` 续跑（存储的计划会被自动消费）。')
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
