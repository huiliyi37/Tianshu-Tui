import type { Sensorium } from './sensorium.js'
import type { VigorState } from './vigor.js'
import type { CognitiveSeason } from './cognitive-season.js'
import type { ThetaPhase } from './star-event.js'

// ─── Base Affordance Registry ──────────────────────────────────────

export interface BaseAffordance {
  /** 减少不确定性（读/search/查看） */
  epistemic: number
  /** 推进目标（写/执行/修改） */
  instrumental: number
}

/**
 * 集中式工具 affordance 注册表。
 *
 * 静态基础值——运行时状态调制由 computeAffordanceScores() 叠加。
 * 未知工具默认 { epistemic: 0.5, instrumental: 0.5 }。
 *
 * 设计原则（天府 #3）：一处修改，不污染 tool description，静态与动态分离。
 */
export const toolAffordanceRegistry: Record<string, BaseAffordance> = {
  // ── Epistemic-heavy：读取、搜索、探索 ──
  read_file:            { epistemic: 0.90, instrumental: 0.10 },
  read_section:         { epistemic: 0.90, instrumental: 0.10 },
  grep:                 { epistemic: 0.85, instrumental: 0.15 },
  glob:                 { epistemic: 0.80, instrumental: 0.20 },
  repo_map:             { epistemic: 0.85, instrumental: 0.15 },
  repo_graph:           { epistemic: 0.80, instrumental: 0.20 },
  inspect_project:      { epistemic: 0.80, instrumental: 0.20 },
  lsp_find_references:  { epistemic: 0.70, instrumental: 0.30 },
  lsp_goto_definition:  { epistemic: 0.75, instrumental: 0.25 },
  related_tests:        { epistemic: 0.70, instrumental: 0.30 },
  recall:               { epistemic: 0.80, instrumental: 0.20 },
  file_info:            { epistemic: 0.70, instrumental: 0.30 },
  diff:                 { epistemic: 0.60, instrumental: 0.40 },
  git:                  { epistemic: 0.50, instrumental: 0.50 },
  plan_close:           { epistemic: 0.40, instrumental: 0.60 },

  // ── Instrumental-heavy：写入、执行、修改 ──
  write_file:           { epistemic: 0.00, instrumental: 1.00 },
  edit_file:            { epistemic: 0.10, instrumental: 0.90 },
  hash_edit:            { epistemic: 0.10, instrumental: 0.90 },
  bash:                 { epistemic: 0.20, instrumental: 0.80 },
  apply_patch:          { epistemic: 0.10, instrumental: 0.90 },
  run_tests:            { epistemic: 0.20, instrumental: 0.80 },
  sandbox_exec:         { epistemic: 0.20, instrumental: 0.80 },
  delegate_task:        { epistemic: 0.10, instrumental: 0.90 },
  delegate_batch:       { epistemic: 0.10, instrumental: 0.90 },
  remember:             { epistemic: 0.20, instrumental: 0.80 },
  todo:                 { epistemic: 0.20, instrumental: 0.80 },
  deliver_task:         { epistemic: 0.10, instrumental: 0.90 },
  undo:                 { epistemic: 0.20, instrumental: 0.80 },

  // ── Hybrid / 上下文相关 ──
  ask_user_question:    { epistemic: 0.50, instrumental: 0.50 },
  web_search:           { epistemic: 0.60, instrumental: 0.40 },
  web_fetch:            { epistemic: 0.70, instrumental: 0.30 },
}

const DEFAULT_AFFORDANCE: BaseAffordance = { epistemic: 0.5, instrumental: 0.5 }

// ─── Dynamic Affordance Score ──────────────────────────────────────

export interface AffordanceScore {
  /** 减少不确定性的能力（当前状态下） */
  epistemic: number
  /** 推进目标的能力（当前状态下） */
  instrumental: number
  /** 当前状态下的可用性（files in scope, recent history, season） */
  contextual: number
}

export interface AffordanceState {
  sensorium: Sensorium | null
  vigor: VigorState | null
  thetaPhase: ThetaPhase | null
  season: CognitiveSeason | null
  /** 当前 working set 中的文件数量 */
  workingSetSize: number
  /** 最近使用的工具名称列表 */
  recentToolNames: string[]
}

// ─── Modulators ────────────────────────────────────────────────────

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value))
}

/**
 * Epistemic modulator: 放大/缩小"探索信息"的价值。
 *
 * 当前不确定性越高 → 越需要 epistemic 工具。
 * theta=ENCODING → 处于接收信息阶段，偏好读。
 * freshness 越低（不熟悉的代码库）→ 越需要探索。
 */
function epistemicModulator(state: AffordanceState): number {
  const s = state.sensorium
  const uncertainty = s ? 1 - s.confidence : 0.5
  const freshnessInv = s ? 1 - s.freshness : 0.5
  const encodingBonus = state.thetaPhase === 'encoding' ? 1.0 : 0.3

  return clamp(0.5 + 0.5 * (
    uncertainty * 0.50 +
    encodingBonus * 0.30 +
    freshnessInv * 0.20
  ))
}

/**
 * Instrumental modulator: 放大/缩小"推进执行"的价值。
 *
 * 置信度越高 → 越适合执行（知道该做什么）。
 * vigor 越高 → 能量充足，适合行动。
 * wuwei 季节 → 无为而治，抑制执行冲动。
 */
function instrumentalModulator(state: AffordanceState): number {
  const s = state.sensorium
  const confidence = s ? s.confidence : 0.5
  const v = state.vigor
  const vigor = v ? v.vigor : 0.5
  const seasonPenalty = state.season === 'wuwei' ? 0.3 : 1.0

  return clamp(0.5 + 0.5 * (
    confidence * 0.40 +
    vigor * 0.30 +
    seasonPenalty * 0.30
  ))
}

/**
 * Contextual modulator: 工具在当下环境中的可用性。
 *
 * 有 working set → 文件操作类工具可用性高。
 * 最近用过的工具 → 短期衰减（避免重复卡住）。
 * 高复杂度 → 偏好聚焦型工具（read_file > repo_map）。
 */
function contextualModulator(
  toolName: string,
  state: AffordanceState,
): number {
  let score = 0.5

  // Working set 非空 → 文件操作工具可用性提升
  if (state.workingSetSize > 0) {
    const fileTools = new Set([
      'read_file', 'read_section', 'edit_file', 'hash_edit',
      'write_file', 'diff', 'lsp_find_references', 'lsp_goto_definition',
      'related_tests', 'grep', 'file_info',
    ])
    if (fileTools.has(toolName)) score += 0.2
  }

  // 重复使用惩罚：渐进式——出现次数越多，信号越强
  const recent = state.recentToolNames.slice(-5)
  const repeatCount = recent.filter(n => n === toolName).length
  if (repeatCount >= 3) score -= 0.30    // 强循环信号
  else if (repeatCount === 2) score -= 0.15  // 模式形成中
  else if (repeatCount === 1) score -= 0.05  // 正常复用，轻微衰减

  // 高复杂度 → 偏好精确工具
  const s = state.sensorium
  if (s && s.complexity > 0.7) {
    const focusedTools = new Set(['read_file', 'grep', 'edit_file', 'hash_edit', 'bash'])
    if (focusedTools.has(toolName)) score += 0.1
    if (toolName === 'repo_map') score -= 0.1 // 全局视图在复杂任务中容易分散注意力
  }

  return clamp(score)
}

// ─── Public API ────────────────────────────────────────────────────

/**
 * 计算所有已注册工具的运行时 affordance 分数。
 *
 * 返回 Record<toolName, AffordanceScore>。
 * 仅包含 registry 中的工具 + recentToolNames 中出现过的未知工具。
 */
export function computeAffordanceScores(
  state: AffordanceState,
  adaptations?: Record<string, BaseAffordance>,
): Record<string, AffordanceScore> {
  const epMod = epistemicModulator(state)
  const insMod = instrumentalModulator(state)

  // 收集所有需要评分的工具名
  const names = new Set([
    ...Object.keys(toolAffordanceRegistry),
    ...state.recentToolNames,
  ])

  const result: Record<string, AffordanceScore> = {}
  for (const name of names) {
    // Session-local adaptation overrides global registry, if present
    const base = adaptations?.[name] ?? toolAffordanceRegistry[name] ?? DEFAULT_AFFORDANCE
    result[name] = {
      epistemic: clamp(base.epistemic * epMod),
      instrumental: clamp(base.instrumental * insMod),
      contextual: contextualModulator(name, state),
    }
  }
  return result
}

/**
 * 获取工具的基础 affordance（不含运行时调制）。
 */
export function getBaseAffordance(toolName: string): BaseAffordance {
  return toolAffordanceRegistry[toolName] ?? DEFAULT_AFFORDANCE
}

// ─── Adaptive Affordance (Sensorimotor Learning) ─────────────────────

/**
 * Adapt tool affordance base values based on actual sensorimotor history.
 *
 * For each tool with ≥5 recorded experiences, compares actual success rate
 * against expected (1.0 for instrumental-heavy, 0.95 for epistemic).
 * Nudges the base affordance toward the tool that actually works better.
 *
 * Returns the updated registry (mutates in place for efficiency).
 */
/**
 * Compute session-local affordance adaptations from sensorimotor history.
 *
 * Multi-session safe: returns a new adapted map instead of mutating the shared
 * global toolAffordanceRegistry. Each session maintains its own adapted copy.
 *
 * @param getSuccessRate callback to query MeridianDb for tool success rates
 * @returns session-local adapted base affordances (only tools with deviations)
 */
export function adaptAffordanceFromHistory(
  getSuccessRate: (toolName: string) => number | null,
): Record<string, BaseAffordance> {
  const adapted: Record<string, BaseAffordance> = {}
  for (const toolName of Object.keys(toolAffordanceRegistry)) {
    const rate = getSuccessRate(toolName)
    if (rate === null) continue

    const base = toolAffordanceRegistry[toolName]!
    // Only adapt if there's a meaningful deviation (>0.15) from expectation
    const isInstrumental = base.instrumental > base.epistemic
    const expected = isInstrumental ? 1.0 : 0.95

    if (Math.abs(rate - expected) > 0.15) {
      // Nudge epistemic up if tool underperforms, instrumental up if overperforms
      const delta = (rate - expected) * 0.1
      adapted[toolName] = {
        epistemic: clamp(base.epistemic - delta * (isInstrumental ? 1 : -1)),
        instrumental: clamp(base.instrumental + delta * (isInstrumental ? 1 : -1)),
      }
    }
  }
  return adapted
}

// ─── Affordance Hint Rendering ─────────────────────────────────────

interface AffordanceHint {
  /** 当前是否偏向探索（epistemic） */
  preferEpistemic: boolean
  /** 综合 epistemic 强度 [0, 1] */
  epistemicStrength: number
  /** 综合 instrumental 强度 [0, 1] */
  instrumentalStrength: number
  /** Top epistemic 工具（按评分排序） */
  topEpistemic: string[]
  /** Top instrumental 工具（按评分排序） */
  topInstrumental: string[]
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function computeHint(state: AffordanceState): AffordanceHint {
  const scores = computeAffordanceScores(state)

  // 计算全局 epistemic/instrumental 平均强度
  const entries = Object.entries(scores)
  let totalEpi = 0
  let totalIns = 0
  for (const [, s] of entries) {
    totalEpi += s.epistemic
    totalIns += s.instrumental
  }
  const epiStrength = entries.length > 0 ? totalEpi / entries.length : 0.5
  const insStrength = entries.length > 0 ? totalIns / entries.length : 0.5

  // Top-K 工具（仅 registry 中已注册的）
  const registered = entries.filter(([name]) => toolAffordanceRegistry[name] !== undefined)
  const topEpistemic = registered
    .sort(([, a], [, b]) => b.epistemic - a.epistemic)
    .slice(0, 5)
    .map(([name]) => name)
  const topInstrumental = registered
    .sort(([, a], [, b]) => b.instrumental - a.instrumental)
    .slice(0, 5)
    .map(([name]) => name)

  return {
    preferEpistemic: epiStrength > insStrength,
    epistemicStrength: epiStrength,
    instrumentalStrength: insStrength,
    topEpistemic,
    topInstrumental,
  }
}

/**
 * 渲染 affordance 上下文提示 XML 块。
 *
 * 向模型提供当前认知状态下的工具选择建议，不强制覆盖 LLM 决策。
 * 纯提示——模型仍自主选择工具。
 *
 * 返回空字符串当 state 信息不足时（无 sensorium 且无 vigor）。
 */
export function renderAffordanceHint(state: AffordanceState): string {
  // 信息不足时不渲染——避免给出无意义的提示
  if (!state.sensorium && !state.vigor) return ''

  const hint = computeHint(state)
  const s = state.sensorium
  const v = state.vigor

  const lines: string[] = []

  // Cognitive state summary
  const theta = state.thetaPhase ?? 'unknown'
  const vigorVal = v ? v.vigor.toFixed(1) : '?'
  const season = state.season ?? '?'
  const conf = s ? (s.confidence * 100).toFixed(0) : '?'

  lines.push(
    `Cognitive state: theta=${theta}, vigor=${vigorVal}, season=${season}, confidence=${conf}%`,
  )

  // Prefer epistemic OR instrumental guidance
  if (hint.preferEpistemic) {
    const confStr = s && s.confidence < 0.4 ? 'uncertainty is high' : 'gathering context'
    lines.push(`Prefer epistemic tools (${hint.topEpistemic.slice(0, 3).join(', ')}) — ${confStr}.`)
    if (hint.topInstrumental.length > 0) {
      lines.push(`Consider instrumental tools (${hint.topInstrumental.slice(0, 2).join(', ')}) when confidence builds.`)
    }
  } else {
    const confStr = s && s.confidence > 0.6 ? 'confidence is high' : 'ready to act'
    lines.push(`Prefer instrumental tools (${hint.topInstrumental.slice(0, 3).join(', ')}) — ${confStr}.`)
    if (hint.topEpistemic.length > 0) {
      lines.push(`Keep epistemic tools (${hint.topEpistemic.slice(0, 2).join(', ')}) available for verification.`)
    }
  }

  return `<affordance-hint>\n${lines.map(l => escapeXml(l)).join('\n')}\n</affordance-hint>`
}
