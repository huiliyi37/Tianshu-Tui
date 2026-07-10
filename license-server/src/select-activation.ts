/**
 * 设备多码归属解析。
 *
 * 一台设备可能有多条激活记录（典型路径：试用码过期后购买正式码）。
 * /verify 必须优选"最优有效授权"，否则心跳可能刷回已过期的试用记录，
 * 把付费用户误降级为 Basic。
 *
 * 优选规则（有效记录内部）：
 *   1. tier 权重：max > pro > 其他
 *   2. 永久授权（license_expires = NULL）优于限期授权
 *   3. 限期授权取到期最晚的
 *   4. 仍并列时取激活时间最新的
 *
 * 全部无效时的 reason 口径：只要存在"未吊销但已过期"的记录就报
 * license_expired（引导续费/升级），仅当所有记录都被吊销才报 revoked。
 */

export interface ActivationCandidate {
  code: string
  tier: string
  activationRevoked: boolean
  codeRevoked: boolean
  /** unix ms；null = 永久授权 */
  licenseExpires: number | null
  activatedAt: number
}

export type InvalidReason = 'revoked' | 'license_expired'

export type SelectionResult =
  | { valid: true; row: ActivationCandidate }
  | { valid: false; row: ActivationCandidate; reason: InvalidReason }

const TIER_WEIGHT: Record<string, number> = { max: 3, pro: 2 }

function tierWeight(tier: string): number {
  return TIER_WEIGHT[tier] ?? 1
}

function isRevoked(r: ActivationCandidate): boolean {
  return r.activationRevoked || r.codeRevoked
}

function isValid(r: ActivationCandidate, now: number): boolean {
  return !isRevoked(r) && (r.licenseExpires == null || r.licenseExpires >= now)
}

/** 有效记录之间的排序：越靠前越优。 */
function compareValid(a: ActivationCandidate, b: ActivationCandidate): number {
  const tw = tierWeight(b.tier) - tierWeight(a.tier)
  if (tw !== 0) return tw
  const aPerpetual = a.licenseExpires == null ? 1 : 0
  const bPerpetual = b.licenseExpires == null ? 1 : 0
  if (aPerpetual !== bPerpetual) return bPerpetual - aPerpetual
  if (a.licenseExpires !== b.licenseExpires) {
    return (b.licenseExpires ?? 0) - (a.licenseExpires ?? 0)
  }
  return b.activatedAt - a.activatedAt
}

/**
 * 从设备的全部激活记录中选出应生效的一条。
 * 返回 null 表示设备没有任何激活记录（reason=not_activated 由调用方处理）。
 */
export function selectActivation(
  rows: readonly ActivationCandidate[],
  now: number,
): SelectionResult | null {
  if (rows.length === 0) return null

  const valid = rows.filter((r) => isValid(r, now))
  if (valid.length > 0) {
    const best = [...valid].sort(compareValid)[0]!
    return { valid: true, row: best }
  }

  // 全部无效：未吊销但过期的记录优先（reason 更可行动），再按激活时间取最新。
  const expired = rows.filter((r) => !isRevoked(r))
  const pool = expired.length > 0 ? expired : rows
  const latest = [...pool].sort((a, b) => b.activatedAt - a.activatedAt)[0]!
  return {
    valid: false,
    row: latest,
    reason: expired.length > 0 ? 'license_expired' : 'revoked',
  }
}
