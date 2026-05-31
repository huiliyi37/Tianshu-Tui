import type { PheromoneRef, Sensorium, StrategyProfile } from './sensorium.js'
import type { VigorState } from './vigor.js'

export interface IntentPreview {
  summary: string
  confidence: number
  alternatives?: string[]
  warnings?: string[]
}

export type IntentPreviewAction = 'continue' | 'veto' | 'alternative'

export interface BuildIntentPreviewInput {
  strategy: StrategyProfile | null
  vigor: VigorState | null
  sensorium: Sensorium | null
  pheromones: PheromoneRef[]
  thrashingSuggestion?: 'task_decomposition' | null
  recentTargets?: string[]
}

export function shouldShowIntent(input: BuildIntentPreviewInput): boolean {
  if (input.strategy && input.strategy.commitThreshold > 0.8) return true
  // vigor < 0.3 → 触发自动适应（策略已在 vigor-hook 中调整），不再弹确认框
  if (input.pheromones.some(p => p.signal === 'dead-end' && p.strength > 0)) return true
  if (input.thrashingSuggestion === 'task_decomposition') return true
  return false
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function summarizeTarget(targets: string[]): string {
  const first = targets.find(t => t && !t.startsWith('<'))
  if (!first) return '继续执行当前计划'
  if (first.length <= 60) return `处理 ${first}`
  return `处理 ${first.slice(0, 57)}...`
}

function confidenceFrom(input: BuildIntentPreviewInput): number {
  const base = input.sensorium?.confidence ?? 0.6
  const phasicPenalty = input.vigor && input.vigor.phasic < 0 ? Math.min(0.25, Math.abs(input.vigor.phasic) * 0.25) : 0
  const commitPenalty = input.strategy && input.strategy.commitThreshold > 0.8 ? 0.1 : 0
  return Math.max(0, Math.min(1, base - phasicPenalty - commitPenalty))
}

export function buildIntentPreview(input: BuildIntentPreviewInput): IntentPreview | null {
  if (!shouldShowIntent(input)) return null

  const warnings: string[] = []
  const deadEnds = unique(input.pheromones.filter(p => p.signal === 'dead-end' && p.strength > 0).map(p => p.path))
  if (input.strategy && input.strategy.commitThreshold > 0.8) warnings.push('high commit threshold')
  // vigor 低时不再弹警告——策略已在 vigor-hook 中自动调整
  if (input.thrashingSuggestion === 'task_decomposition') warnings.push('检测到上下文/压缩抖动，建议拆分任务')
  if (deadEnds.length > 0) warnings.push(`历史 dead-end: ${deadEnds.slice(0, 3).join(', ')}`)

  const alternatives = input.strategy && input.strategy.explorationBreadth > 0.6
    ? ['先扩大搜索确认影响面', '拆成更小步骤逐一验证']
    : undefined

  return {
    summary: summarizeTarget(input.recentTargets ?? deadEnds),
    confidence: confidenceFrom(input),
    ...(alternatives ? { alternatives } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

export function formatIntentPreview(intent: IntentPreview): string {
  // 不呈现"信心 X%"——这个数字由 phasic penalty 反推出来，
  // TDD 红灯等预期内失败会压低 phasic，导致 self-fulfilling 信心崩溃。
  // 只保留客观 warning，让居民看见"为什么"该停一下，而非打击性自评分。
  const warning = intent.warnings && intent.warnings.length > 0 ? ` — ${intent.warnings[0]}` : ''
  return `⟡ ${intent.summary}${warning} — [Enter/y 继续 / n 否决${intent.alternatives?.length ? ' / a 替代' : ''}]`
}
