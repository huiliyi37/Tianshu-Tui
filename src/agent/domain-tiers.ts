/**
 * 星域产品分层（零依赖叶子模块，经 src/server/ui-shared.ts 共享给桌面端）。
 *
 * 第一档 starter：新用户默认只接触这四颗星——覆盖规划/审查、通用工程、
 * 验证验收、执行交付。第二档 advanced：其余内置星域同样是完整通用工程，
 * 只是关注点与工程方法论更特化，随用户对多星域体系的了解逐步解锁。
 */
import type { StarDomainId } from './star-domain-data.js'

export type StarDomainTier = 'starter' | 'advanced'

/** 第一档展示顺序：天权（规划审查）→ 启明（通用工程，默认）→ 瑶光（验证）→ 天梁（执行）。 */
export const STARTER_DOMAIN_IDS: readonly StarDomainId[] = [
  'tianquan',
  'qiming',
  'yaoguang',
  'tianliang',
] as const

const STARTER_SET: ReadonlySet<string> = new Set(STARTER_DOMAIN_IDS)

/** 单个星域所属档位。未知/自定义域缺省归 advanced。 */
export function getStarDomainTier(id: StarDomainId): StarDomainTier {
  return STARTER_SET.has(id) ? 'starter' : 'advanced'
}

export interface StarDomainTierPartition {
  starter: StarDomainId[]
  advanced: StarDomainId[]
}

/**
 * 按产品档位切分传入的星域 id 列表。
 * starter 保持 STARTER_DOMAIN_IDS 的展示顺序；advanced 保持传入顺序。
 */
export function partitionDomainsByTier(ids: readonly StarDomainId[]): StarDomainTierPartition {
  const advanced = ids.filter((id) => !STARTER_SET.has(id))
  return {
    starter: STARTER_DOMAIN_IDS.filter((id) => ids.includes(id)),
    advanced,
  }
}
