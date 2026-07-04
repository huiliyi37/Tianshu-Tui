import { extractJsonCandidates, type WorkerResult } from '../work-order.js'
import { aggregateCouncil, resolveConflictsWithRebuttals, type CouncilDraft, type CouncilPlan, type SeatContribution, type SeatRebuttal } from './council-plan.js'
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
  /** Per-seat provider/model override (highest routing precedence). Set when the
   *  seat declares both provider+model; threaded to the worker so this seat runs
   *  on an isolated provider/model — enables heterogeneous councils. */
  modelOverride?: { provider: string; model: string }
  /** 瑶光门 tier 下限（席位 tierHint+noDowngrade）——接线到真实派发，
   *  coordinator 的 preferredTier 不得低于此档。曾只在 shadow 记录，
   *  导致天府护栏席声明 strong 却实际跑 flash（事故链缺口 1）。 */
  tierFloor?: 'cheap' | 'balanced' | 'strong'
}
export interface CouncilDeps {
  delegateBatch: (
    requests: CouncilFanoutRequest[],
    policy: 'all_required',
    signal?: AbortSignal,
    onProgress?: (completed: number, total: number) => void,
  ) => Promise<{ results: WorkerResult[]; workerModels?: Array<{ workOrderId: string; model: string }> }>
  /** 注入时钟，保持 aggregate 纯净、编排可测。 */
  now: () => number
  /** 旁路记录席位路由 shadow —— 默认缺省。绝不影响真实派发。 */
  recordRoutingShadow?: (event: CouncilRoutingShadowEvent) => void
  /** shadow 归属会话 id（仅 recordRoutingShadow 在用）。 */
  sessionId?: string
  /** 席位完成进度回调 —— 每席完成时触发。用于 UI 实时反馈。
   *  seat 参数在异步并行场景下仅为近似值（onProgress 只回调 completed 计数，
   *  不含具体 workOrderId），建议 consumer 仅使用计数语义。 */
  onSeatProgress?: (seat: string, status: 'running' | 'done') => void
}

export interface CouncilInput {
  draft: CouncilDraft
  seats: CouncilSeat[]
  abortSignal?: AbortSignal
  /** 多轮层最大轮数。默认 1（纯单轮，行为同今天）；≥2 时 runCouncilDebate 才叠加
   *  round2，且仅在 round1 有冲突时扇出。runCouncil 本身忽略此参数（永远单轮）。 */
  maxRounds?: number
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
    '先用只读工具(grep / repo_map / related_tests / read_file)定位每个条目实际涉及的文件,',
    '在 addition 的 `files` 字段列出它会改动的文件路径(相对项目根)。这些文件提示会用于后续 team 分波/同文件串行,务必基于真实代码而非臆测。',
    '',
    'Return a JSON WorkerResult whose `artifacts` contains ONE entry:',
    '{ "kind": "note", "title": "seat-contribution", "content": "<a JSON string of your SeatContribution>" }',
    'SeatContribution = { authority, summary, additions, risks, challenges, alternatives }.',
    'PlanItem (additions[]) = { id, title, detail, files?: string[] } —— files 为该条目涉及的文件路径。',
    `Set authority to "${seat.authority}".`,
  ].join('\n')
}

/** 第二轮反驳 objective —— 席位只就 round1 冲突表态，不重出全稿。 */
export function buildSeatRebuttalObjective(
  seat: CouncilSeat,
  draft: CouncilDraft,
  conflicts: { key: string; description: string; left: string; right: string }[],
  ownRound1Summary?: string,
): string {
  return [
    `你是 ${seat.authority} 席位专家。议事会第二轮：首轮各席已出稿，现就以下分歧表态收敛，只出立场不执行。`,
    ...(seat.charter ? [`席位章程：${seat.charter}`] : []),
    '',
    `Objective: ${draft.objective}`,
    ...(ownRound1Summary ? [`你的首轮摘要：${ownRound1Summary}`] : []),
    '',
    '待裁分歧（针对每条给出立场）：',
    ...conflicts.map(c => `- [${c.key}] ${c.description} | 一方: ${c.left} | 另一方: ${c.right}`),
    '',
    'Return a JSON WorkerResult whose `artifacts` contains ONE entry:',
    '{ "kind": "note", "title": "seat-contribution", "content": "<a JSON string of your SeatContribution>" }',
    'SeatContribution = { authority, summary, rebuttals }, rebuttals = [{ conflictKey, stance, argument }].',
    'stance ∈ "concede"(让步) | "hold"(坚持) | "revise"(折中修订)；conflictKey 用上面方括号内的 key。',
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
          ...(Array.isArray(raw.rebuttals) ? { rebuttals: raw.rebuttals.filter((r): r is SeatRebuttal =>
            r !== null && typeof r === 'object'
            && typeof r.conflictKey === 'string'
            && typeof r.stance === 'string'
            && typeof r.argument === 'string'
          ) } : {}),
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

/** Per-seat model override fragment — only when the seat declares both
 *  provider+model. Spread into the fanout request so heterogeneous seats run on
 *  their own provider/model. */
function seatModelOverride(seat: CouncilSeat): Pick<CouncilFanoutRequest, 'modelOverride'> {
  return seat.provider && seat.model
    ? { modelOverride: { provider: seat.provider, model: seat.model } }
    : {}
}

/** 瑶光门接线：席位声明 tierHint+noDowngrade 且无显式 provider/model 时，
 *  把路由 tier 作为 tierFloor 传给真实派发（不再只是 shadow 记录）。 */
function seatTierFloor(seat: CouncilSeat, objective: string): Pick<CouncilFanoutRequest, 'tierFloor'> {
  if (seat.provider && seat.model) return {}
  if (!seat.noDowngrade || !seat.tierHint) return {}
  const route = routeCouncilSeat(seat, { objective })
  return { tierFloor: route.tier }
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
    ...seatModelOverride(seat),
    ...seatTierFloor(seat, input.draft.objective),
  }))

  // 旁路：席位路由 shadow（推荐 vs 实际 tier）。默认缺省；提供时也绝不改派发结果。
  if (deps.recordRoutingShadow) {
    const sessionId = deps.sessionId ?? 'unknown'
    for (const seat of input.seats) {
      const route = routeCouncilSeat(seat, { objective: input.draft.objective })
      deps.recordRoutingShadow(buildCouncilRoutingShadow({ sessionId, objectiveHash: hash, route, timestamp: convenedAt }))
    }
  }

  const run = await deps.delegateBatch(requests, 'all_required', input.abortSignal,
    deps.onSeatProgress
      ? (completed, total) => {
          // onProgress 只回调 completed 计数，不含 workOrderId——并行扇出场景下
          // 完成顺序 ≠ 席位数组顺序。只传计数，不传具体席位名避免张冠李戴。
          deps.onSeatProgress?.(`${completed}/${total}`, 'done')
        }
      : undefined)
  const contributions = input.seats.map(seat => {
    const result = run.results.find(r => r.workOrderId === `council:seat-${seat.authority}`)
    if (!result) return { authority: seat.authority, summary: '', additions: [], risks: [], challenges: [], alternatives: [] }
    const contrib = parseSeatContribution(seat.authority, result)
    // 真实 model 回填：从 coordinator 的 workerModels 匹配 workOrderId，
    // 而非信任 worker 自报（buildSeatObjective schema 未包含 modelUsed）。
    if (run.workerModels && !contrib.modelUsed) {
      const m = run.workerModels.find(wm => wm.workOrderId === result.workOrderId)
      if (m) contrib.modelUsed = m.model
    }
    return contrib
  })
  const aggregate = aggregateCouncil(input.draft, contributions)
  const finalPlanMarkdown = renderCouncilPlan({ objective: input.draft.objective, seats: authorities, contributions, aggregate, finalPlanMarkdown: '', meta: { round: 1, convenedAt, objectiveHash: hash } })
  return { objective: input.draft.objective, seats: authorities, contributions, aggregate, finalPlanMarkdown, meta: { round: 1, convenedAt, objectiveHash: hash } }
}

/**
 * 多轮层：复用单轮 runCouncil 出 round1，按 maxRounds 叠加 round2 反驳收敛。
 * maxRounds<2 或 round1 无冲突 → 直接返回 round1（等价单轮，零额外扇出）。
 */
export async function runCouncilDebate(input: CouncilInput, deps: CouncilDeps): Promise<CouncilPlan> {
  const round1 = await runCouncil(input, deps)
  const maxRounds = input.maxRounds ?? 1
  if (maxRounds < 2 || round1.aggregate.conflicts.length === 0) return round1

  const r2requests: CouncilFanoutRequest[] = input.seats.map(seat => ({
    parentTurnId: `council:seat-${seat.authority}-r2`,
    objective: buildSeatRebuttalObjective(
      seat,
      input.draft,
      round1.aggregate.conflicts,
      round1.contributions.find(c => c.authority === seat.authority)?.summary,
    ),
    kind: 'plan',
    profile: 'council_expert',
    scope: {},
    authority: seat.authority,
    ...seatModelOverride(seat),
    ...seatTierFloor(seat, input.draft.objective),
  }))
  const run2 = await deps.delegateBatch(r2requests, 'all_required', input.abortSignal,
    deps.onSeatProgress
      ? (completed, total) => { deps.onSeatProgress?.(`${completed}/${total}`, 'done') }
      : undefined)
  const r2Contributions: SeatContribution[] = input.seats.map(seat => {
    const result = run2.results.find(r => r.workOrderId === `council:seat-${seat.authority}-r2`)
    if (!result) return { authority: seat.authority, summary: '', additions: [], risks: [], challenges: [], alternatives: [], round: 2 }
    const contrib: SeatContribution = { ...parseSeatContribution(seat.authority, result), round: 2 }
    // 真实 model 回填：与 round1 一致，从 coordinator workerModels 匹配，
    // 而非信任 worker 自报（rebuttal schema 同样不含 modelUsed）。
    if (run2.workerModels && !contrib.modelUsed) {
      const m = run2.workerModels.find(wm => wm.workOrderId === result.workOrderId)
      if (m) contrib.modelUsed = m.model
    }
    return contrib
  })
  const allRebuttals = r2Contributions.flatMap(c => c.rebuttals ?? [])
  const aggregate = { ...round1.aggregate, conflicts: resolveConflictsWithRebuttals(round1.aggregate.conflicts, allRebuttals) }
  const contributions = [...round1.contributions, ...r2Contributions]
  const meta = { ...round1.meta, round: 2 }
  const finalPlanMarkdown = renderCouncilPlan({ objective: input.draft.objective, seats: round1.seats, contributions, aggregate, finalPlanMarkdown: '', meta })
  return { objective: input.draft.objective, seats: round1.seats, contributions, aggregate, finalPlanMarkdown, meta }
}
