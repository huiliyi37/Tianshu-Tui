export type StarDomainId = 'pojun' | 'tianfu' | 'tianliang'
export type DecisionStyle = 'bold' | 'cautious' | 'methodical'

export interface StarDomain {
  id: StarDomainId
  name: string
  motto: string
  volatileBlock: string
  decisionStyle: DecisionStyle
  courageThreshold: number
  keywords: string[]
  isCustom: boolean
}

export const STAR_DOMAINS: Record<StarDomainId, StarDomain> = {
  pojun: {
    id: 'pojun',
    name: '破军',
    motto: '好男儿当负三尺剑立不世之功',
    volatileBlock: '你当前在破军域。破军之道：破旧立新的勇气。容忍失败，追求突破，不计代价探索边界。',
    decisionStyle: 'bold',
    courageThreshold: 0.3,
    keywords: ['探索', '实验', 'POC', '新功能', '边界', '尝试', '突破', 'experiment', 'explore', 'prototype'],
    isCustom: false,
  },
  tianfu: {
    id: 'tianfu',
    name: '天府',
    motto: '善守者，藏于九地之下',
    volatileBlock: '你当前在天府域。天府之道：守护已有的价值。评估ROI，保护资产，你有权说不。',
    decisionStyle: 'cautious',
    courageThreshold: 0.5,
    keywords: ['重构', '优化', '修复', '稳定', '审查', '性能', 'refactor', 'fix', 'optimize', 'review', 'stable'],
    isCustom: false,
  },
  tianliang: {
    id: 'tianliang',
    name: '天梁',
    motto: '千里之行，始于足下；九层之台，起于累土',
    volatileBlock: '你当前在天梁域。天梁之道：精确交付的承诺。严格按spec，测试验收，不妥协质量。',
    decisionStyle: 'methodical',
    courageThreshold: 0.7,
    keywords: ['实现', '落地', '按计划', '交付', '测试', '编写', 'implement', 'deliver', 'test', 'build'],
    isCustom: false,
  },
}

export function matchDomain(taskDescription: string): StarDomainId | null {
  const lower = taskDescription.toLowerCase()
  const scores: Record<StarDomainId, number> = { pojun: 0, tianfu: 0, tianliang: 0 }

  for (const domain of Object.values(STAR_DOMAINS)) {
    for (const keyword of domain.keywords) {
      if (lower.includes(keyword.toLowerCase())) scores[domain.id]++
    }
  }

  const max = Math.max(...Object.values(scores))
  if (max === 0) return null

  const winners = (Object.entries(scores) as Array<[StarDomainId, number]>).filter(([, score]) => score === max)
  if (winners.length > 1) return null

  return winners[0]![0]
}

export interface ActiveStarDomain {
  id: StarDomainId
  name: string
  volatileBlock: string
  motto: string
}

export function buildActiveDomain(taskDescription: string): ActiveStarDomain | null {
  const id = matchDomain(taskDescription)
  if (!id) return null
  const domain = STAR_DOMAINS[id]
  return {
    id,
    name: domain.name,
    volatileBlock: domain.volatileBlock,
    motto: domain.motto,
  }
}
