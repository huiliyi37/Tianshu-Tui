import { extractJsonCandidates, type WorkerResult } from '../work-order.js'
import { aggregateCouncil, type CouncilDraft, type CouncilPlan, type SeatContribution } from './council-plan.js'
import { renderCouncilPlan } from './council-render.js'

/** 结构型扇出依赖 —— 仅声明 runCouncil 用到的批量委派能力，保持与 coordinator 解耦。 */
export interface CouncilFanoutRequest {
  parentTurnId: string
  objective: string
  kind: 'plan'
  profile: 'reviewer'
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
}

export interface CouncilInput {
  draft: CouncilDraft
  seats: string[]
  abortSignal?: AbortSignal
}

/** 席位 objective —— 领域职责简述 + schema 指令（仿 buildPlannerObjective）。 */
export function buildSeatObjective(seat: string, draft: CouncilDraft): string {
  return [
    `你是 ${seat} 席位专家。从你的领域视角单轮会诊以下计划草案，只出意见，不执行。`,
    '',
    `Objective: ${draft.objective}`,
    `Draft items: ${JSON.stringify(draft.items)}`,
    '',
    'Return a JSON WorkerResult whose `artifacts` contains ONE entry:',
    '{ "kind": "note", "title": "seat-contribution", "content": "<a JSON string of your SeatContribution>" }',
    'SeatContribution = { authority, summary, additions, risks, challenges, alternatives }.',
    `Set authority to "${seat}".`,
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
  const requests: CouncilFanoutRequest[] = input.seats.map(seat => ({
    parentTurnId: `council:seat-${seat}`,
    objective: buildSeatObjective(seat, input.draft),
    kind: 'plan',
    profile: 'reviewer',
    scope: {},
    authority: seat,
  }))
  const run = await deps.delegateBatch(requests, 'all_required', input.abortSignal)
  const contributions = input.seats.map(seat => {
    const result = run.results.find(r => r.workOrderId.includes(`seat-${seat}`))
    return result ? parseSeatContribution(seat, result) : { authority: seat, summary: '', additions: [], risks: [], challenges: [], alternatives: [] }
  })
  const aggregate = aggregateCouncil(input.draft, contributions)
  const convenedAt = deps.now() // 只取一次，避免 md/meta 不一致
  const hash = objectiveHash(input.draft.objective)
  const finalPlanMarkdown = renderCouncilPlan({ objective: input.draft.objective, seats: input.seats, contributions, aggregate, finalPlanMarkdown: '', meta: { round: 1, convenedAt, objectiveHash: hash } })
  return { objective: input.draft.objective, seats: input.seats, contributions, aggregate, finalPlanMarkdown, meta: { round: 1, convenedAt, objectiveHash: hash } }
}
