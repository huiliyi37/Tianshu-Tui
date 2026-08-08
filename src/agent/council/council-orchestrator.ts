import { extractJsonCandidates, type WorkerResult } from '../work-order.js'
import type { IdentifiedWorkerResult } from '../coordinator.js'
import { aggregateCouncil, applyResolutionsToMergedItems, resolveConflictsWithRebuttals, type CouncilDraft, type CouncilPlan, type SeatChallenge, type SeatContribution, type SeatRebuttal } from './council-plan.js'
import { renderCouncilPlan } from './council-render.js'
import {
  routeCouncilSeat,
  buildCouncilRoutingShadow,
  type CouncilSeat,
  type CouncilRoutingShadowEvent,
} from './council-routing.js'
import { detectQliphoth } from './council-qliphoth.js'

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
    onWorkerSettled?: (result: IdentifiedWorkerResult) => void,
  ) => Promise<{ results: IdentifiedWorkerResult[]; workerModels?: Array<{ workOrderId: string; model: string }> }>
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
  /** Per-worker terminal callback; used to close fast seats before batch completion. */
  onWorkerSettled?: (result: IdentifiedWorkerResult) => void
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
    'risks = [{ claim, severity?: "high"|"medium"|"low", mitigation, itemId? }] —— mitigation 为必填缓解措施，缺省抽稀时填 ""；',
    'PlanItem (additions[]) = { id, title, detail, files?: string[] } —— files 为该条目涉及的文件路径。',
    'challenges = [{ text, severity?: "advisory"|"blocking", gate?: string, itemId?: string }] ——',
    'severity:"blocking" 是否决级质疑（未化解前计划不得编译执行，慎用、必须给出具体依据）；',
    'gate 填可验证的验收命令（如 "npx tsc --noEmit"、"npm test"），会编译进任务验收门波间强制执行；',
    'itemId 指向被质疑的条目 id，缺省为全局质疑。',
    `Set authority to "${seat.authority}".`,
  ].join('\n')
}

/** challenge 归一化：旧格式纯字符串 → {text}；结构化对象透传；畸形元素丢弃。 */
function normalizeChallenges(raw: unknown): SeatChallenge[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((ch): SeatChallenge[] => {
    if (typeof ch === 'string') return ch.trim() ? [{ text: ch }] : []
    if (ch && typeof ch === 'object' && typeof (ch as SeatChallenge).text === 'string') {
      const c = ch as SeatChallenge
      return [{
        text: c.text,
        ...(c.severity === 'blocking' || c.severity === 'advisory' ? { severity: c.severity } : {}),
        ...(typeof c.gate === 'string' && c.gate.trim() ? { gate: c.gate } : {}),
        ...(typeof c.itemId === 'string' && c.itemId.trim() ? { itemId: c.itemId } : {}),
      }]
    }
    return []
  })
}

/** 第二轮反驳 objective —— 席位只就 round1 冲突表态，不重出全稿。 */
export function buildSeatRebuttalObjective(
  seat: CouncilSeat,
  draft: CouncilDraft,
  conflicts: { key: string; description: string; left: string; right: string }[],
  ownRound1Summary?: string,
  /** 其他席位的首轮摘要（交叉可见）——r2 不再只对冲突条目盲表态。 */
  peerSummaries?: Array<{ authority: string; summary: string }>,
): string {
  return [
    `你是 ${seat.authority} 席位专家。议事会第二轮：首轮各席已出稿，现就以下分歧表态收敛，只出立场不执行。`,
    ...(seat.charter ? [`席位章程：${seat.charter}`] : []),
    '',
    `Objective: ${draft.objective}`,
    ...(ownRound1Summary ? [`你的首轮摘要：${ownRound1Summary}`] : []),
    ...(peerSummaries && peerSummaries.length > 0
      ? ['', '各席首轮立场（交叉可见）：', ...peerSummaries.map(p => `- ${p.authority}: ${p.summary}`)]
      : []),
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

/** 席位解析判别式结果 —— fail-loud：调用方能区分成功 / artifact 缺失 / JSON 全部畸形，
 *  不再静默降级为空贡献（曾把解析失败伪装成「席位没意见」，垃圾进垃圾出）。 */
export type SeatParseResult =
  | { ok: true; contribution: SeatContribution }
  | { ok: false; reason: 'missing_artifact' | 'malformed_json'; detail: string }

/** 流会消息里按失败子类计数的席位失败类。budget_exhausted 优先于 missing_artifact：
 *  blocked+timeout 的 worker 结果没有 seat-contribution artifact，parseSeatContribution
 *  会返回 missing_artifact——但「预算耗尽」是更该突出的成因（2026-08-07 分析文档 P0-2）。 */
export type SeatFailureClass = 'missing_artifact' | 'malformed_json' | 'budget_exhausted' | 'no_result'

/** 按最终（重试后）结果归类席位失败子类。 */
export function classifySeatFailure(
  result: WorkerResult | undefined,
  parsed: SeatParseResult | null,
): SeatFailureClass {
  if (result && result.status === 'blocked' && (result.failureReason === 'timeout' || result.failureReason === 'max_turns')) {
    return 'budget_exhausted'
  }
  if (parsed && !parsed.ok) return parsed.reason
  return 'no_result'
}

/** 失败席位按子类分组渲染，供流会 throw 消息说明成因：
 *  「missing_artifact×2：天权、天府；budget_exhausted×1：天璇」。 */
export function renderFailureBreakdown(
  failedSeats: string[],
  failReasonByAuthority: ReadonlyMap<string, SeatFailureClass>,
): string {
  const byClass = new Map<SeatFailureClass, string[]>()
  for (const seat of failedSeats) {
    const cls = failReasonByAuthority.get(seat) ?? 'no_result'
    const list = byClass.get(cls) ?? []
    list.push(seat)
    byClass.set(cls, list)
  }
  return [...byClass.entries()].map(([cls, seats]) => `${cls}×${seats.length}：${seats.join('、')}`).join('；')
}

/** 解析席位 WorkerResult → SeatContribution。失败返回 ok:false 供调用方重试/留痕。 */
export function parseSeatContribution(seat: string, result: WorkerResult): SeatParseResult {
  const artifact = result.artifacts.find(a => a.title === 'seat-contribution')
  if (!artifact) {
    return { ok: false, reason: 'missing_artifact', detail: `席位 ${seat} 未产出 seat-contribution artifact（worker status=${result.status}）` }
  }
  try {
    for (const candidate of extractJsonCandidates(artifact.content)) {
      try {
        const raw = JSON.parse(candidate) as Partial<SeatContribution>
        return {
          ok: true,
          contribution: {
            authority: seat,
            summary: raw.summary ?? result.summary ?? '',
            additions: Array.isArray(raw.additions) ? raw.additions : [],
            risks: Array.isArray(raw.risks)
              // LLM 输出不可信：缺 mitigation 的 risk 补空串，保证下游
              // extractObligations 等消费方不因字段缺失崩溃（类型必填 ≠ 运行时必有）。
              ? raw.risks.filter(r => r && typeof r === 'object').map(r => ({ ...r, mitigation: typeof r?.mitigation === 'string' ? r.mitigation : '' }))
              : [],
            challenges: normalizeChallenges(raw.challenges),
            alternatives: Array.isArray(raw.alternatives) ? raw.alternatives : [],
            ...(raw.modelUsed ? { modelUsed: raw.modelUsed } : {}),
            ...(Array.isArray(raw.rebuttals) ? { rebuttals: raw.rebuttals.filter((r): r is SeatRebuttal =>
              r !== null && typeof r === 'object'
              && typeof r.conflictKey === 'string'
              && typeof r.stance === 'string'
              && typeof r.argument === 'string'
            ) } : {}),
          },
        }
      } catch {
        // 下一个候选 —— 模型输出可能夹杂散文/畸形示例
      }
    }
  } catch {
    // extractJsonCandidates 无候选时抛错 → 落到下方 malformed_json
  }
  return { ok: false, reason: 'malformed_json', detail: `席位 ${seat} artifact 无可解析的 SeatContribution JSON` }
}

function objectiveHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(16)
}

/** 真实 model 回填：从 coordinator 的 workerModels 匹配 workOrderId，
 *  而非信任 worker 自报（席位 schema 不含 modelUsed）。 */
function withModelBackfill(
  contrib: SeatContribution,
  run: { workerModels?: Array<{ workOrderId: string; model: string }> },
  workOrderId: string,
): SeatContribution {
  if (contrib.modelUsed || !run.workerModels) return contrib
  const m = run.workerModels.find(wm => wm.workOrderId === workOrderId)
  return m ? { ...contrib, modelUsed: m.model } : contrib
}

/** 法定人数：有效席位（贡献解析成功）不得少于 ⌈2/3 × 总席位⌉，否则议事会流会。 */
export function councilQuorum(totalSeats: number): number {
  return Math.ceil((totalSeats * 2) / 3)
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
      : undefined,
    deps.onWorkerSettled)
  // ── fail-loud 解析：失败席位收集重试，绝不静默空降级 ──
  const contribByAuthority = new Map<string, SeatContribution>()
  const retrySeats: CouncilSeat[] = []
  const failDetails = new Map<string, string>()
  for (const seat of input.seats) {
    const result = run.results.find(r => r.workOrderId === `council:seat-${seat.authority}`)
    if (!result) {
      retrySeats.push(seat)
      failDetails.set(seat.authority, `席位 ${seat.authority} worker 无结果`)
      continue
    }
    const parsed = parseSeatContribution(seat.authority, result)
    if (parsed.ok) {
      contribByAuthority.set(seat.authority, withModelBackfill(parsed.contribution, run, result.workOrderId))
    } else {
      retrySeats.push(seat)
      failDetails.set(seat.authority, parsed.detail)
    }
  }

  // ── 单席重试一次：换 -retry parentTurnId 绕开队列 authority 去重 ──
  const failedSeats: string[] = []
  const failReasonByAuthority = new Map<string, SeatFailureClass>()
  if (retrySeats.length > 0) {
    const retryRequests: CouncilFanoutRequest[] = retrySeats.map(seat => ({
      parentTurnId: `council:seat-${seat.authority}-retry`,
      objective: buildSeatObjective(seat, input.draft),
      kind: 'plan',
      profile: 'council_expert',
      scope: {},
      authority: seat.authority,
      ...seatModelOverride(seat),
      ...seatTierFloor(seat, input.draft.objective),
    }))
    const retryRun = await deps.delegateBatch(retryRequests, 'all_required', input.abortSignal, undefined, deps.onWorkerSettled)
    for (const seat of retrySeats) {
      const result = retryRun.results.find(r => r.workOrderId === `council:seat-${seat.authority}-retry`)
      const parsed = result ? parseSeatContribution(seat.authority, result) : null
      if (parsed?.ok) {
        contribByAuthority.set(seat.authority, withModelBackfill(parsed.contribution, retryRun, result!.workOrderId))
      } else {
        failedSeats.push(seat.authority)
        failReasonByAuthority.set(seat.authority, classifySeatFailure(result, parsed))
        const detail = parsed && !parsed.ok ? parsed.detail : (failDetails.get(seat.authority) ?? `席位 ${seat.authority} 重试仍无结果`)
        contribByAuthority.set(seat.authority, {
          authority: seat.authority,
          summary: `[contribution_failed] ${detail}（已重试一次）`,
          additions: [], risks: [], challenges: [], alternatives: [],
        })
      }
    }
  }

  // ── 法定人数：有效席位 < ⌈2/3⌉ → 整会流会 fail-loud ──
  const quorum = councilQuorum(input.seats.length)
  const validCount = input.seats.length - failedSeats.length
  if (validCount < quorum) {
    const breakdown = renderFailureBreakdown(failedSeats, failReasonByAuthority)
    throw new Error(`议事会流会：有效席位 ${validCount}/${input.seats.length} 不足法定人数 ${quorum}（${breakdown}）`)
  }

  const contributions = input.seats.map(seat => contribByAuthority.get(seat.authority)!)
  const aggregate = aggregateCouncil(input.draft, contributions)
  // 柱级退化检测（advisory）：三柱席位的已知失败形态留痕进裁决与面板。
  const qliphoth = detectQliphoth(contributions, aggregate)
  const meta = {
    round: 1, convenedAt, objectiveHash: hash,
    ...(failedSeats.length > 0 ? { failedSeats } : {}),
    ...(qliphoth.length > 0 ? { qliphoth } : {}),
  }
  const finalPlanMarkdown = renderCouncilPlan({ objective: input.draft.objective, seats: authorities, contributions, aggregate, finalPlanMarkdown: '', meta })
  return { objective: input.draft.objective, seats: authorities, contributions, aggregate, finalPlanMarkdown, meta }
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
      // V1 回收「交叉质询」：r2 席位可见彼此 r1 贡献，不再只对冲突条目盲表态。
      round1.contributions
        .filter(c => c.authority !== seat.authority && c.summary.trim())
        .map(c => ({ authority: c.authority, summary: c.summary })),
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
      : undefined,
    deps.onWorkerSettled)
  const r2Contributions: SeatContribution[] = input.seats.map(seat => {
    const result = run2.results.find(r => r.workOrderId === `council:seat-${seat.authority}-r2`)
    if (!result) return { authority: seat.authority, summary: '', additions: [], risks: [], challenges: [], alternatives: [], round: 2 }
    const parsed = parseSeatContribution(seat.authority, result)
    // r2 是收敛轮：解析失败按 hold 语义处理（空 rebuttals → 冲突自然 persisted），不重试。
    const base: SeatContribution = parsed.ok
      ? parsed.contribution
      : { authority: seat.authority, summary: result.summary ?? '', additions: [], risks: [], challenges: [], alternatives: [] }
    const contrib: SeatContribution = { ...base, round: 2 }
    // 真实 model 回填：与 round1 一致，从 coordinator workerModels 匹配，
    // 而非信任 worker 自报（rebuttal schema 同样不含 modelUsed）。
    if (run2.workerModels && !contrib.modelUsed) {
      const m = run2.workerModels.find(wm => wm.workOrderId === result.workOrderId)
      if (m) contrib.modelUsed = m.model
    }
    return contrib
  })
  const allRebuttals = r2Contributions.flatMap(c => c.rebuttals ?? [])
  const resolvedConflicts = resolveConflictsWithRebuttals(round1.aggregate.conflicts, allRebuttals)
  // r2 收敛回写：resolved 冲突的化解依据注记进 mergedItems（修复「收敛结果只留在
  // conflicts 表、执行图看不见」的断层）。
  const aggregate = {
    ...round1.aggregate,
    conflicts: resolvedConflicts,
    mergedItems: applyResolutionsToMergedItems(round1.aggregate.mergedItems, resolvedConflicts),
  }
  const contributions = [...round1.contributions, ...r2Contributions]
  const meta = { ...round1.meta, round: 2 }
  const finalPlanMarkdown = renderCouncilPlan({ objective: input.draft.objective, seats: round1.seats, contributions, aggregate, finalPlanMarkdown: '', meta })
  return { objective: input.draft.objective, seats: round1.seats, contributions, aggregate, finalPlanMarkdown, meta }
}
