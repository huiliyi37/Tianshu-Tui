export type CapabilityTask = 'repo_summarization' | 'code_edit' | 'test_failure_diagnosis' | 'compaction' | 'risky_refactor'

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
  }
}

export function recommendModelForTask(task: CapabilityTask, cards: ModelCapabilityCard[]): ModelCapabilityCard {
  if (cards.length === 0) throw new Error('No model capability cards configured')
  return [...cards].sort((a, b) => score(task, b) - score(task, a))[0]!
}
