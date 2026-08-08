
/**
 * 星域运行时 API（匹配 / 路由 / authority 派生）。
 *
 * 类型与 STAR_DOMAINS 数据表已抽至 star-domain-data.ts——一个零依赖叶子模块，
 * 桌面端经 src/server/ui-shared.ts 共享同一份数据。此处 `export *` 保持内核
 * 20+ 调用方的既有 import 路径不变。
 */
export * from './star-domain-data.js'
import { STAR_DOMAINS, type StarDomainId } from './star-domain-data.js'

/** Synchronous delegate to registry.
 *  The registry singleton is initialized at module load time, so by the time
 *  any caller invokes this function, the circular ESM init has completed and
 *  starDomainRegistry is available. */
import { starDomainRegistry, type DomainMatchDetail } from './star-domain-registry.js'

export function matchDomain(taskDescription: string, pool?: readonly string[]): string | null {
  return starDomainRegistry.matchDomain(taskDescription, pool)
}

/** Delegation fallback when keyword match is null (tie or no-match). */
export const DELEGATION_FALLBACK_AUTHORITY: StarDomainId = 'tianliang'

const MAX_AUTHORITY_KEYWORDS = 3
const MAX_AUTHORITY_REASON_LEN = 60

export interface DerivedAuthority {
  /** Winning domain id, or {@link DELEGATION_FALLBACK_AUTHORITY} on tie/no-match. */
  authority: string
  /** Human-readable why-this-domain lines (deterministic, truncated). */
  reasons: string[]
  /** Raw match detail — lets callers (resolveAuthorityReason) avoid a second scan. */
  detail: DomainMatchDetail
}

/**
 * Explicit authority derivation for delegation routing.
 * Same id semantics as `matchDomain(objective) ?? 'tianliang'`, plus audit reasons
 * for advisory / TUI surfaces ("破军（命中: 重构+回归）").
 */
export function deriveAuthority(objective: string): DerivedAuthority {
  const detail = starDomainRegistry.matchDomainDetailed(objective)
  if (detail.verdict === 'hit' && detail.id) {
    const kws = detail.matchedKeywords.slice(0, MAX_AUTHORITY_KEYWORDS)
    const hit = kws.length > 0 ? `命中: ${kws.join('+')}` : `命中: ${detail.id}`
    return {
      authority: detail.id,
      reasons: [truncateReason(hit)],
      detail,
    }
  }
  if (detail.verdict === 'tie') {
    const tied = (detail.tiedIds ?? []).map(labelDomain).join('/')
    return {
      authority: DELEGATION_FALLBACK_AUTHORITY,
      reasons: [truncateReason(`平手(${tied})→天梁兜底`)],
      detail,
    }
  }
  return {
    authority: DELEGATION_FALLBACK_AUTHORITY,
    reasons: [truncateReason('无关键词命中→天梁兜底')],
    detail,
  }
}

/**
 * Resolve a display reason for an authority already attached to a work order.
 * - No authority → undefined (field omitted).
 * - Explicit authority matches a keyword hit → hit reason.
 * - Otherwise (mismatch, tie fallback, or no-match fallback) → `显式指定`.
 */
export function resolveAuthorityReason(objective: string, authority?: string): string | undefined {
  if (!authority) return undefined
  const derived = deriveAuthority(objective)
  if (authority === derived.authority && derived.detail.verdict === 'hit') {
    return derived.reasons[0]
  }
  return '显式指定'
}

function labelDomain(id: string): string {
  return starDomainRegistry.get(id)?.name ?? id
}

function truncateReason(text: string): string {
  if (text.length <= MAX_AUTHORITY_REASON_LEN) return text
  return text.slice(0, MAX_AUTHORITY_REASON_LEN - 1) + '…'
}

export interface ActiveStarDomain {
  id: StarDomainId
  name: string
  volatileBlock: string
  motto: string
  courageThreshold: number
}

/** Auto 关闭关键词路由时的固定落点；亦为 auto 池路由未命中/平手时的回退。
 *  2026-07-23 由天枢改为天权：兜底域承接"任务形状未知"的流量，天权
 *  称量先行、证据优先，日常开发匹配度经实测更好（见 .rivet/plans/
 *  默认星域切换为天权-tianquan.md 的背书）；天枢转为显式开启的统筹位。 */
export const DEFAULT_DOMAIN: StarDomainId = 'tianquan'

/** Auto 关键词路由的内置星域池（2026-07-23 收窄；2026-07-25 华盖出池）：
 *  只有均衡工程型星域参与自动路由——天权（称量/计划）、开阳（对账攻坚）、
 *  瑶光（验证闭环）、天梁（交付主力）。气质特化域（破军/天府/天机/天璇/
 *  辅/文曲/启明/长庚/七杀/天枢/华盖）仅经 defaultDomain 钉定、/domain 手工
 *  切换、或委派 authority 进入。自定义域 = 用户显式创建，自动入池。
 *  七杀刻意不入池：自动路由进一个以退场提名为业的域，是把刀交给没要刀的人。
 *  华盖出池同理：长程守昼是承诺型气质，应用户明示选择，而非关键词偶遇。 */
export const DOMAIN_AUTO_POOL: readonly StarDomainId[] = ['tianquan', 'kaiyang', 'yaoguang', 'tianliang']

export interface ActiveDomainResolution {
  domain: ActiveStarDomain
  matchedKeywords: string[]
  reason: 'keyword' | 'fallback'
}

/** Resolve Auto exactly once, retaining the registry's audit detail for observers. */
export function resolveActiveDomain(
  taskDescription: string,
  opts?: { keywordRouting?: boolean },
): ActiveDomainResolution {
  const keywordRouting = opts?.keywordRouting !== false
  const pool = [
    ...DOMAIN_AUTO_POOL,
    ...starDomainRegistry.list().filter((d) => d.isCustom).map((d) => d.id),
  ]
  const detail = keywordRouting
    ? starDomainRegistry.matchDomainDetailed(taskDescription, pool)
    : null
  let matchedId: string | null = null
  let matchedKeywords: string[] = []
  if (detail?.verdict === 'hit' && typeof detail.id === 'string') {
    matchedId = detail.id
    matchedKeywords = detail.matchedKeywords.slice(0, 3)
  }
  const id = matchedId ?? DEFAULT_DOMAIN
  const definition = starDomainRegistry.get(id) ?? STAR_DOMAINS[DEFAULT_DOMAIN]
  return {
    domain: {
      id: id as StarDomainId,
      name: definition.name,
      volatileBlock: definition.volatileBlock,
      motto: definition.motto,
      courageThreshold: definition.courageThreshold,
    },
    matchedKeywords,
    reason: matchedId ? 'keyword' : 'fallback',
  }
}

export function buildActiveDomain(
  taskDescription: string,
  opts?: { keywordRouting?: boolean },
): ActiveStarDomain {
  return resolveActiveDomain(taskDescription, opts).domain
}
