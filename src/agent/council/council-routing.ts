// 议事会席位多模型路由 —— 纯函数 + append-only shadow。
// 铁律：routeCouncilSeat 零 I/O、零 Date，给定输入输出唯一。
// shadow 记录本身仍是旁路（绝不影响派发）；但瑶光门（tierHint+noDowngrade）
// 的路由结果经 council-orchestrator 的 seatTierFloor 接线到真实派发，
// 作为 WorkOrder.tierFloor 下限生效（事故链缺口 1 修复）。

import { recommendModelTier, type ModelTier, type ModelRiskTier } from '../model-tier-policy.js'

/** 议事会席位 —— 权能 + 章程 + 路由偏好。 */
export interface CouncilSeat {
  /** 星域权能 id（tianquan/tianfu/tianxuan/...），驱动 authority→tier 升级。 */
  authority: string
  /** 席位章程简述（注入 objective，可缺）。 */
  charter?: string
  /** 期望 tier 提示。无 noDowngrade 时仅作 shadow 记录，不改判。 */
  tierHint?: ModelTier
  /** 瑶光门：true 时把 tierHint 升格为硬地板，final tier 不得低于它。 */
  noDowngrade?: boolean
  /** 席位专属 provider（须在 config.provider.providers 中存在）。与 model 同时
   *  设置时,该席位 worker 跑在独立 provider/model 上(独立服务端缓存),实现
   *  异构议事会(如天权用 DeepSeek Pro、天府用 GLM)。缺失/无凭据时静默回退会话模型。 */
  provider?: string
  /** 席位专属 model（须在 provider 的 models 列表中）。需与 provider 同时设置。 */
  model?: string
}

/** 缺省席位 —— 天权领航 · 天府护栏 · 天璇探索。调用方可经 seats 覆盖。
 *  置于路由层（CouncilSeat 定义所在）以便工具层与 workflow 层共享，避免
 *  workflow → tools 反向依赖。 */
export const DEFAULT_COUNCIL_SEATS: readonly CouncilSeat[] = [
  { authority: 'tianquan', charter: '领航：把握方向与优先级' },
  { authority: 'tianfu', charter: '护栏：风险、边界与安全', tierHint: 'strong', noDowngrade: true },
  { authority: 'tianxuan', charter: '探索：方案空间与替代路径' },
]

export interface CouncilSeatRoute {
  authority: string
  /** 最终生效 tier。 */
  tier: ModelTier
  /** policy 依 authority/riskTier 给出的推荐 tier。 */
  recommendedTier: ModelTier
  /** policy 硬地板（天府/天璇高风险护栏），始终强制。 */
  hardFloor?: ModelTier
  /** 是否因 noDowngrade+tierHint 触发瑶光门抬升。 */
  gated: boolean
  reason: string
}

export interface RouteCouncilSeatOpts {
  riskTier?: ModelRiskTier
  objective?: string
}

const TIER_ORDER: Record<ModelTier, number> = { cheap: 0, balanced: 1, strong: 2 }

/** 取更高 tier（瑶光门只抬升、绝不降级推荐 tier）。 */
function maxTier(a: ModelTier, b: ModelTier): ModelTier {
  return TIER_ORDER[a] >= TIER_ORDER[b] ? a : b
}

/**
 * 席位路由：用 council_expert profile（无 tierLock）走 authority→tier 升级路径，
 * 叠加 policy hardFloor 与瑶光门 noDowngrade 硬地板。
 *
 * 瑶光门语义：noDowngrade=true 时 tierHint 是「不得低于」的硬地板；
 * noDowngrade 缺省时 tierHint 仅作 shadow 记录，不改判（议事会绝不自动降级
 * 推荐 tier —— 宁可贵，不可错）。
 */
export function routeCouncilSeat(seat: CouncilSeat, opts?: RouteCouncilSeatOpts): CouncilSeatRoute {
  const rec = recommendModelTier({
    profile: 'council_expert',
    authority: seat.authority,
    kind: 'plan',
    ...(opts?.riskTier ? { riskTier: opts.riskTier } : {}),
    objective: opts?.objective ?? `${seat.authority} council seat`,
  })

  let tier = rec.tier
  if (rec.hardFloor) tier = maxTier(tier, rec.hardFloor)

  const gated = Boolean(seat.noDowngrade && seat.tierHint)
  if (gated) tier = maxTier(tier, seat.tierHint!)

  const reason = gated
    ? `瑶光门: tier=max(recommended ${rec.tier}${rec.hardFloor ? `, floor ${rec.hardFloor}` : ''}, hint ${seat.tierHint})`
    : rec.reason

  return {
    authority: seat.authority,
    tier,
    recommendedTier: rec.tier,
    ...(rec.hardFloor ? { hardFloor: rec.hardFloor } : {}),
    gated,
    reason,
  }
}

export interface CouncilRoutingShadowEvent {
  schemaVersion: 1
  sessionId: string
  objectiveHash: string
  seat: string
  recommendedTier: ModelTier
  finalTier: ModelTier
  hardFloor?: ModelTier
  gated: boolean
  reason: string
  timestamp: number
}

export interface CouncilRoutingShadowStore {
  saveBanditState(kind: string, json: string): void
}

/** append-only key —— 含 seat+timestamp，保证同 objective 多席多次会诊不互相覆盖
 *  (saveBanditState 是 ON CONFLICT(kind) UPSERT)。 */
export function councilRoutingShadowKind(
  e: Pick<CouncilRoutingShadowEvent, 'sessionId' | 'objectiveHash' | 'seat' | 'timestamp'>,
): string {
  return `council_routing_shadow:${e.sessionId}:${e.objectiveHash}:${e.seat}:${e.timestamp}`
}

export interface BuildCouncilRoutingShadowInput {
  sessionId: string
  objectiveHash: string
  route: CouncilSeatRoute
  timestamp: number
}

export function buildCouncilRoutingShadow(input: BuildCouncilRoutingShadowInput): CouncilRoutingShadowEvent {
  return {
    schemaVersion: 1,
    sessionId: input.sessionId,
    objectiveHash: input.objectiveHash,
    seat: input.route.authority,
    recommendedTier: input.route.recommendedTier,
    finalTier: input.route.tier,
    ...(input.route.hardFloor ? { hardFloor: input.route.hardFloor } : {}),
    gated: input.route.gated,
    reason: input.route.reason,
    timestamp: input.timestamp,
  }
}

export function persistCouncilRoutingShadow(
  store: CouncilRoutingShadowStore | undefined | null,
  event: CouncilRoutingShadowEvent,
): void {
  if (!store) return
  try {
    store.saveBanditState(councilRoutingShadowKind(event), JSON.stringify(event))
  } catch {
    // shadow 遥测绝不影响会诊派发。
  }
}
