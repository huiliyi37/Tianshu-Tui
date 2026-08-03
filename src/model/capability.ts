export type CapabilityTask = 'repo_summarization' | 'code_edit' | 'test_failure_diagnosis' | 'compaction' | 'risky_refactor' | 'planning'

export interface ModelCapabilityCard {
  model: string
  toolUseReliability: number
  jsonStability: number
  editSuccessRate: number
  testRepairRate: number
  contextWindow: number
  cacheEconomics: 'weak' | 'medium' | 'strong'
  recommendedTasks: string[]
}

function score(task: CapabilityTask, card: ModelCapabilityCard): number {
  switch (task) {
    case 'repo_summarization':
      return card.contextWindow / 1_000_000 + (card.cacheEconomics === 'strong' ? 1 : 0)
    case 'code_edit':
      return card.toolUseReliability * 0.5 + card.editSuccessRate * 0.5
    case 'test_failure_diagnosis':
      return card.testRepairRate * 0.7 + card.jsonStability * 0.3
    case 'compaction':
      return (card.cacheEconomics === 'strong' ? 1 : 0.5) + card.jsonStability
    case 'risky_refactor':
      return card.toolUseReliability * 0.4 + card.editSuccessRate * 0.3 + card.testRepairRate * 0.3
    case 'planning':
      // 规划偏好强推理 + 大上下文 + 稳定 JSON 产出：favor 强卡模型（v4-flash 与 pro 同档候选）
      return card.toolUseReliability * 0.4 + card.jsonStability * 0.3 + (card.cacheEconomics === 'strong' ? 0.3 : 0) + card.contextWindow / 1_000_000
  }
}

export function recommendModelForTask(task: CapabilityTask, cards: ModelCapabilityCard[]): ModelCapabilityCard {
  if (cards.length === 0) throw new Error('No model capability cards configured')
  return [...cards].sort((a, b) => {
    const scoreA = score(task, a) + (a.recommendedTasks.includes(task) ? 0.5 : 0)
    const scoreB = score(task, b) + (b.recommendedTasks.includes(task) ? 0.5 : 0)
    return scoreB - scoreA
  })[0]!
}

/** 能力卡构造的模型信息输入（结构性类型，避免依赖 config 包造成环）。 */
export interface CapabilityModelInput {
  id: string
  alias?: string
  contextWindow: number
}

/** v4-flash 去廉价化（2026-08-02）：实测能力已超 v4-pro / GLM 5.2（按用户基准
 *  判断），给略高于 pro 的先验；运行时 bandit/routing-metrics 继续学习修正。
 *  recommendedTasks 全任务覆盖——推荐排序里 flash 应当能赢 pro。 */
const V4_FLASH_CARD = {
  toolUseReliability: 0.85,
  jsonStability: 0.85,
  editSuccessRate: 0.75,
  testRepairRate: 0.65,
  cacheEconomics: 'strong' as const,
  recommendedTasks: ['code_search', 'code_edit', 'test_failure_diagnosis', 'risky_refactor', 'planning', 'repo_summarization', 'compaction'],
}

/** 按模型产出能力卡。历史按名字一刀切（pro→强卡、flash→弱卡），
 *  deepseek-v4-flash 是第一个被打破的启发式特例。 */
export function capabilityCardForModel(m: CapabilityModelInput): ModelCapabilityCard {
  if (m.id === 'deepseek-v4-flash' || m.alias === 'v4-flash') {
    return { model: m.id, contextWindow: m.contextWindow, ...V4_FLASH_CARD }
  }
  const isPro = m.id.includes('pro') || m.alias?.includes('pro')
  const isFlash = m.id.includes('flash') || m.alias?.includes('flash')
  if (isPro || (!isFlash && !isPro)) {
    return {
      model: m.id,
      toolUseReliability: 0.8,
      jsonStability: 0.8,
      editSuccessRate: 0.7,
      testRepairRate: 0.6,
      contextWindow: m.contextWindow,
      cacheEconomics: 'strong' as const,
      recommendedTasks: ['code_search', 'code_edit', 'test_failure_diagnosis', 'risky_refactor'],
    }
  }
  return {
    model: m.id,
    toolUseReliability: 0.6,
    jsonStability: 0.65,
    editSuccessRate: 0.5,
    testRepairRate: 0.45,
    contextWindow: m.contextWindow,
    cacheEconomics: 'strong' as const,
    recommendedTasks: ['repo_summarization', 'compaction'],
  }
}

/** Build modelCards from a provider's models（bootstrap 与 headless 共用同一口径）。 */
export function buildModelCards(provider: { models: CapabilityModelInput[] }): ModelCapabilityCard[] {
  return provider.models.map(capabilityCardForModel)
}
