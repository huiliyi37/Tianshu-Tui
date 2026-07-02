import type { PheromoneRef, Sensorium, StrategyProfile } from './sensorium.js'
import type { VigorState } from './vigor.js'
import { matchesDeadEnd, normalizeDeadEndTarget } from './dead-end-match.js'

export interface IntentPreview {
  summary: string
  confidence: number
  alternatives?: string[]
  warnings?: string[]
}

/** Plain-language rendering of an {@link IntentPreview} direction note. */
export interface IntentNoteCopy {
  title: string
  /** Reasons translated from raw `warnings` into 大白话. */
  reasons: string[]
  /** What the agent is going to do (it always continues). */
  action: string
  /** How the user can steer if they want to change direction. */
  steerHint: string
}

/**
 * Translate an {@link IntentPreview} payload into plain-language copy shared by
 * the TUI card and the desktop timeline note. Keeps both ends in sync.
 */
export function describeIntentNote(intent: IntentPreview): IntentNoteCopy {
  const reasons: string[] = []
  for (const w of intent.warnings ?? []) {
    if (w.includes('high commit threshold')) {
      reasons.push('我对当前方向把握偏低')
    } else if (w.startsWith('历史 dead-end')) {
      const detail = w.replace(/^历史 dead-end:\s*/, '').trim()
      reasons.push(detail ? `这个目标之前走过死路（${detail}）` : '这个目标之前走过死路')
    } else if (w.includes('抖动')) {
      reasons.push('上下文在抖，可能要拆任务')
    } else {
      reasons.push(w)
    }
  }
  if (reasons.length === 0) reasons.push('当前方向有一点不确定')
  return {
    title: '天权 · 方向提示',
    reasons,
    action: '已记录，我会继续执行（必要时先自检一步）',
    steerHint: '想改方向就直接在下面打字告诉我，比如「先停下，换个思路」',
  }
}

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
 * 提取 dead-end path 的实际内容用于显示与关联比对。
 * 委托共享 normalizeDeadEndTarget（剥摘要前缀 + cd 样板 + 截断尾）。
 */
function extractDeadEndPath(path: string): string {
  return normalizeDeadEndTarget(path)
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

  // P0 兼容路径：path 子串匹配（覆盖无 taskId 的历史数据）——委托共享 matchesDeadEnd
  const targets = recentTargets?.filter(t => t && !t.startsWith('<')) ?? []
  if (targets.length === 0) return []
  return deadEnds.filter(de => matchesDeadEnd(de.path, targets))
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
