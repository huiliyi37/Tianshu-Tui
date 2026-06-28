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
  /** Task contract ID for structured dead-end matching (P2). */
  taskContractId?: string
}

/**
 * 兼容历史 dead-end path 的格式：旧数据存的是 `summarizeTarget` 生成的
 * `处理 ${target}` 摘要（带中文前缀与可能的 `...` 截断尾）；新数据直接存原始 target。
 * 提取出实际内容用于与 recentTargets 关联比对。
 *
 * 不依赖特定前缀常量做相等判断（开源项目文案可能本地化），用「剥离已知摘要前缀」
 * 兜底：能剥离则取剥离后内容，否则原样返回（新格式 / 自定义内容）。
 */
function extractDeadEndPath(path: string): string {
  // 兼容旧摘要格式 `处理 xxx` / `处理 xxx...`
  if (path.startsWith('处理 ')) return path.slice(3).replace(/\.\.\.$/, '')
  return path
}

/**
 * 筛选出与当前目标关联的 dead-end 信号。
 *
 * 旧实现把「信息素库里存在任意一条 dead-end」当作触发条件（stigmergyStore.query()
 * 不带参数返回全量），与当前目标零关联检查 → 历史无关任务 veto 残留（7 天半衰期）
 * 导致任何新任务都强弹意图闸。
 *
 * 关联判定（两层，优先级递减）：
 * ① P2 精确路径：taskId 精确匹配（dead-end 沉积时附带了 taskContractId）
 * ② P0 兼容路径：dead-end 提取出的实际内容与任一 recentTarget 子串重合。
 *    fallback 摘要「继续执行当前计划」无具体目标，永不关联 → 跳过。
 */
function relevantDeadEnds(
  pheromones: PheromoneRef[],
  recentTargets?: string[],
  taskContractId?: string,
): PheromoneRef[] {
  const deadEnds = pheromones.filter(p => p.signal === 'dead-end' && p.strength > 0)

  // P2 精确路径：taskId 精确匹配
  if (taskContractId) {
    const exactMatch = deadEnds.filter(de => de.taskId === taskContractId)
    if (exactMatch.length > 0) return exactMatch
    // 精确匹配命中 → 直接返回，不走模糊路径
  }

  // P0 兼容路径：path 子串匹配（覆盖无 taskId 的历史数据）
  const targets = recentTargets?.filter(t => t && !t.startsWith('<')) ?? []
  if (targets.length === 0) return []
  return deadEnds.filter(de => {
    const extracted = extractDeadEndPath(de.path)
    if (!extracted || extracted === '继续执行当前计划') return false
    return targets.some(t => extracted.includes(t) || t.includes(extracted))
  })
}

export function shouldShowIntent(input: BuildIntentPreviewInput): boolean {
  if (input.strategy && input.strategy.commitThreshold > 0.8) return true
  // vigor < 0.3 → 触发自动适应（策略已在 vigor-hook 中调整），不再弹确认框
  if (relevantDeadEnds(input.pheromones, input.recentTargets, input.taskContractId).length > 0) return true
  if (input.thrashingSuggestion === 'task_decomposition') return true
  return false
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
  const deadEnds = relevantDeadEnds(input.pheromones, input.recentTargets, input.taskContractId).map(p => extractDeadEndPath(p.path))
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
