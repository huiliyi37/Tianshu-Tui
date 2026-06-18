import { extractJsonCandidates, type WorkerResult } from '../work-order.js'
import { aggregateCouncil, type CouncilDraft, type CouncilPlan, type SeatContribution } from './council-plan.js'
import { renderCouncilPlan } from './council-render.js'
import {
  routeCouncilSeat,
  buildCouncilRoutingShadow,
  type CouncilSeat,
  type CouncilRoutingShadowEvent,
} from './council-routing.js'

/** 结构型扇出依赖 —— 仅声明 runCouncil 用到的批量委派能力，保持与 coordinator 解耦。 */
export interface CouncilFanoutRequest {
  parentTurnId: string
  objective: string
  kind: 'plan'
  profile: 'council_expert'
  scope: Record<string, never>
  authority: string
}
export interface CouncilDeps {
  delegateBatch: (
    requests: CouncilFanoutRequest[],
    policy: 'all_required',
    signal?: AbortSignal,
  ) => Promise<{ results: WorkerResult[] }>
  /** 注入时钟，保持 aggregate 纯净、编排可测。 */
  now: () => number
  /** 旁路记录席位路由 shadow —— 默认缺省。绝不影响真实派发。 */
  recordRoutingShadow?: (event: CouncilRoutingShadowEvent) => void
  /** shadow 归属会话 id（仅 recordRoutingShadow 在用）。 */
  sessionId?: string
}

export interface CouncilInput {
  draft: CouncilDraft
  seats: CouncilSeat[]
  abortSignal?: AbortSignal
}

/** 席位 objective —— 领域职责简述 + schema 指令（仿 buildPlannerObjective）。 */
export function buildSeatObjective(seat: CouncilSeat, draft: CouncilDraft): string {
  return [
    `你是 ${seat.authority} 席位专家。从你的领域视角单轮会诊以下计划草案，只出意见，不执行。`,
    ...(seat.charter ? [`席位章程：${seat.charter}`] : []),
    '',
    `Objective: ${draft.objective}`,
    `Draft items: ${JSON.stringify(draft.items)}`,
    '',
    'Return a JSON WorkerResult whose `artifacts` contains ONE entry:',
    '{ "kind": "note", "title": "seat-contribution", "content": "<a JSON string of your SeatContribution>" }',
    'SeatContribution = { authority, summary, additions, risks, challenges, alternatives }.',
    `Set authority to "${seat.authority}".`,
  ].join('\n')
}

/** 解析席位 WorkerResult → SeatContribution；artifact 缺失或畸形时降级为空贡献（不阻塞会诊）。 */
export function parseSeatContribution(seat: string, result: WorkerResult): SeatContribution {
  const empty: SeatContribution = { authority: seat, summary: result.summary ?? '', additions: [], risks: [], challenges: [], alternatives: [] }
  const artifact = result.artifacts.find(a => a.title === 'seat-contribution')
  if (!artifact) return empty
  try {
    for (const candidate of extractJsonCandidates(artifact.content)) {
      try {
        const raw = JSON.parse(candidate) as Partial<SeatContribution>
        return {
          authority: seat,
          summary: raw.summary ?? empty.summary,
          additions: Array.isArray(raw.additions) ? raw.additions : [],
          risks: Array.isArray(raw.risks) ? raw.risks : [],
          challenges: Array.isArray(raw.challenges) ? raw.challenges : [],
          alternatives: Array.isArray(raw.alternatives) ? raw.alternatives : [],
          ...(raw.modelUsed ? { modelUsed: raw.modelUsed } : {}),
        }
      } catch {
        // 下一个候选 —— 模型输出可能夹杂散文/畸形示例
      }
    }
  } catch {
    // 无 JSON 候选 → 降级空贡献
  }
  return empty
}

function objectiveHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(16)
}

/** 单轮会诊：恰一次 delegateBatch 扇出席位 → 裁决 → 渲染。绝不派 worker 执行 / 分波。 */
export async function runCouncil(input: CouncilInput, deps: CouncilDeps): Promise<CouncilPlan> {
  const convenedAt = deps.now() // 全程只取一次时钟，喂 shadow / meta / md，杜绝双取不一致。
  const hash = objectiveHash(input.draft.objective)
  const authorities = input.seats.map(s => s.authority)

  const requests: CouncilFanoutRequest[] = input.seats.map(seat => ({
    parentTurnId: `council:seat-${seat.authority}`,
    objective: buildSeatObjective(seat, input.draft),
    kind: 'plan',
    profile: 'council_expert',
    scope: {},
    authority: seat.authority,
  }))

  // 旁路：席位路由 shadow（推荐 vs 实际 tier）。默认缺省；提供时也绝不改派发结果。
  if (deps.recordRoutingShadow) {
    const sessionId = deps.sessionId ?? 'unknown'
    for (const seat of input.seats) {
      const route = routeCouncilSeat(seat, { objective: input.draft.objective })
      deps.recordRoutingShadow(buildCouncilRoutingShadow({ sessionId, objectiveHash: hash, route, timestamp: convenedAt }))
    }
  }

  const run = await deps.delegateBatch(requests, 'all_required', input.abortSignal)
  const contributions = input.seats.map(seat => {
    const result = run.results.find(r => r.workOrderId === `council:seat-${seat.authority}`)
    return result ? parseSeatContribution(seat.authority, result) : { authority: seat.authority, summary: '', additions: [], risks: [], challenges: [], alternatives: [] }
  })
  const aggregate = aggregateCouncil(input.draft, contributions)
  const finalPlanMarkdown = renderCouncilPlan({ objective: input.draft.objective, seats: authorities, contributions, aggregate, finalPlanMarkdown: '', meta: { round: 1, convenedAt, objectiveHash: hash } })
  return { objective: input.draft.objective, seats: authorities, contributions, aggregate, finalPlanMarkdown, meta: { round: 1, convenedAt, objectiveHash: hash } }
}
