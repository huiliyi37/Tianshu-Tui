/**
 * Multi-Signal Convergence Detector
 *
 * Detects agent stagnation by computing a composite convergence score from
 * orthogonal progress signals over a sliding window. Thresholds adapt to
 * context window size (200K vs 1M) and current phase class.
 *
 * Design: docs/superpowers/plans/2026-06-01-convergence-detector.md
 */

import type { ToolHistoryEntry } from '../prompt/volatile.js'
import type { EvidenceState } from './evidence.js'

// ─── Types ──────────────────────────────────────────────────────────

export type PhaseClass = 'explore' | 'plan' | 'execute' | 'verify' | 'deliver'

export interface ConvergenceInput {
  /** Current turn number (0-based from AgentLoop) */
  turn: number
  /** Current phase class */
  phaseClass: PhaseClass
  /** Context window size (200_000 or 1_000_000) */
  contextWindow: number
  /** Recent tool history (last N entries) */
  recentToolHistory: ReadonlyArray<Pick<ToolHistoryEntry, 'tool' | 'status' | 'target'>>
  /** Evidence state with edit/verification tracking */
  evidenceState: Pick<EvidenceState, 'filesModified' | 'filesRead' | 'deliveryStatus'>
  /** Optional tool call fingerprints for oscillation detection (A→B→A→B patterns). */
  toolFingerprints?: ReadonlyArray<string>
  /** Number of consecutive turns with no tool calls. Used to detect text-only
   *  stagnation (model hesitates, repeats itself, or produces thinking without
   *  action). Tool-based signals can't see these turns since recentToolHistory
   *  only grows on tool execution. */
  noToolTurnCount?: number
  /** Recent turn text fingerprints (whitespace-normalized trimmed text).
   *  Used to detect cross-turn text repetition — the model produces similar
   *  analysis text over multiple turns without making progress. */
  textFingerprints?: ReadonlyArray<string>
}

export interface ConvergenceResult {
  /** Composite score 0-1 (1 = fully converging, 0 = stuck) */
  score: number
  /** Escalation level */
  level: 0 | 1 | 2 | 3
  /** Should the loop abort? */
  shouldAbort: boolean
  /** Level 2+: message to inject as user guidance */
  injectedMessage: string | null
  /** Level 2+: should a dissipative kick be applied? */
  shouldKick: boolean
  /** Level 3: should we force a session split? */
  shouldForceSplit: boolean
  /** Individual signal values for diagnostics */
  signals: ConvergenceSignals
}

export interface ConvergenceSignals {
  editRatio: number
  targetNovelty: number
  toolEntropy: number
  errorPenalty: number
  tokenEfficiency: number
  /** 0-1 penalty for alternating tool patterns (A→B→A→B). 0 = severe oscillation, 1 = no oscillation. */
  oscillationPenalty: number
  /** 0-1 penalty for cross-turn text repetition. 0 = severe repetition (same text), 1 = no repetition. */
  textRepetitionPenalty: number
}

// ─── Window-aware Thresholds ────────────────────────────────────────

interface WindowTier {
  maxTurns: number
  nLow: number
  nMid: number
  nHigh: number
  signalWindow: number
  label: string
}

const WINDOW_TIER_200K: WindowTier = {
  maxTurns: 30,
  nLow: 8,
  nMid: 14,
  nHigh: 20,
  signalWindow: 6,
  label: '200K',
}

const WINDOW_TIER_1M: WindowTier = {
  maxTurns: 50,
  nLow: 12,
  nMid: 22,
  nHigh: 35,
  signalWindow: 10,
  label: '1M',
}

/**
 * Select the appropriate tier based on context window size.
 * Linear interpolation between 200K and 1M for intermediate sizes.
 */
function selectTier(contextWindow: number): WindowTier {
  if (contextWindow <= 200_000) return WINDOW_TIER_200K
  if (contextWindow >= 1_000_000) return WINDOW_TIER_1M

  // Linear interpolation for intermediate window sizes
  const ratio = (contextWindow - 200_000) / (1_000_000 - 200_000)
  return {
    maxTurns: Math.round(lerp(WINDOW_TIER_200K.maxTurns, WINDOW_TIER_1M.maxTurns, ratio)),
    nLow: Math.round(lerp(WINDOW_TIER_200K.nLow, WINDOW_TIER_1M.nLow, ratio)),
    nMid: Math.round(lerp(WINDOW_TIER_200K.nMid, WINDOW_TIER_1M.nMid, ratio)),
    nHigh: Math.round(lerp(WINDOW_TIER_200K.nHigh, WINDOW_TIER_1M.nHigh, ratio)),
    signalWindow: Math.round(lerp(WINDOW_TIER_200K.signalWindow, WINDOW_TIER_1M.signalWindow, ratio)),
    label: `${Math.round(contextWindow / 1000)}K`,
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

// ─── Phase-Aware Weights ────────────────────────────────────────────

interface PhaseWeights {
  editRatio: number
  targetNovelty: number
  toolEntropy: number
  errorPenalty: number
  tokenEfficiency: number
  oscillationPenalty: number
  textRepetitionPenalty: number
}

const PHASE_WEIGHTS: Record<PhaseClass, PhaseWeights> = {
  explore: { editRatio: 0.05, targetNovelty: 0.25, toolEntropy: 0.20, errorPenalty: 0.12, tokenEfficiency: 0.13, oscillationPenalty: 0.10, textRepetitionPenalty: 0.15 },
  plan:    { editRatio: 0.10, targetNovelty: 0.18, toolEntropy: 0.15, errorPenalty: 0.18, tokenEfficiency: 0.18, oscillationPenalty: 0.10, textRepetitionPenalty: 0.11 },
  execute: { editRatio: 0.40, targetNovelty: 0.08, toolEntropy: 0.08, errorPenalty: 0.18, tokenEfficiency: 0.08, oscillationPenalty: 0.06, textRepetitionPenalty: 0.12 },
  verify:  { editRatio: 0.22, targetNovelty: 0.08, toolEntropy: 0.08, errorPenalty: 0.28, tokenEfficiency: 0.10, oscillationPenalty: 0.10, textRepetitionPenalty: 0.14 },
  deliver: { editRatio: 0.36, targetNovelty: 0.08, toolEntropy: 0.08, errorPenalty: 0.20, tokenEfficiency: 0.08, oscillationPenalty: 0.08, textRepetitionPenalty: 0.12 },
}

// ─── Signal Computation ─────────────────────────────────────────────

/**
 * Compute Shannon entropy normalized to [0, 1].
 * A uniform distribution of N tools has entropy = ln(N), max entropy = ln(N).
 */
function normalizedShannonEntropy(distribution: Map<string, number>, total: number): number {
  if (total === 0 || distribution.size <= 1) return 0.0
  const n = distribution.size
  const maxEntropy = Math.log(n)
  let entropy = 0
  for (const count of distribution.values()) {
    const p = count / total
    entropy -= p * Math.log(p)
  }
  return maxEntropy > 0 ? entropy / maxEntropy : 0.0
}

/**
 * editRatio: fraction of turns in the window that produced edits.
 * Uses evidenceState.filesModified as a cumulative proxy — we track
 * whether filesModified grew during the window by checking against tool history.
 */
function computeEditRatio(
  windowSize: number,
  history: ConvergenceInput['recentToolHistory'],
  _evidence: ConvergenceInput['evidenceState'],
): number {
  const window = history.slice(-windowSize)
  if (window.length === 0) return 0.0
  const editTools = new Set(['edit_file', 'write_file'])
  const successfulEdits = window.filter(
    h => editTools.has(h.tool) && h.status === 'success',
  ).length
  return successfulEdits / window.length
}

/**
 * targetNovelty: fraction of tool targets that are new (not seen before in the window).
 * High novelty in explore phase is good. Declining novelty over time signals convergence.
 */
function computeTargetNovelty(
  windowSize: number,
  history: ConvergenceInput['recentToolHistory'],
): number {
  const window = history.slice(-windowSize)
  if (window.length === 0) return 1.0
  const seen = new Set<string>()
  let novelCount = 0
  for (const entry of window) {
    const target = entry.target
    if (!seen.has(target)) {
      novelCount++
      seen.add(target)
    }
  }
  // novelCount / windowSize: 1.0 = all unique, 0.0 = all repeats
  return novelCount / window.length
}

/**
 * toolEntropy: normalized Shannon entropy of tool distribution in the window.
 * High entropy = diverse tool use (good in explore, bad in execute if no edits).
 */
function computeToolEntropy(
  windowSize: number,
  history: ConvergenceInput['recentToolHistory'],
): number {
  const window = history.slice(-windowSize)
  if (window.length === 0) return 0.5 // neutral when no data
  const dist = new Map<string, number>()
  for (const entry of window) {
    dist.set(entry.tool, (dist.get(entry.tool) ?? 0) + 1)
  }
  return normalizedShannonEntropy(dist, window.length)
}

/**
 * errorPenalty: 1.0 - failure_rate in the window.
 * A high failure rate drags down convergence.
 */
function computeErrorPenalty(
  windowSize: number,
  history: ConvergenceInput['recentToolHistory'],
): number {
  const window = history.slice(-windowSize)
  if (window.length === 0) return 1.0
  const failures = window.filter(h => h.status === 'failed').length
  return 1.0 - (failures / window.length)
}

/**
 * tokenEfficiency: heuristic proxy for output/input ratio.
 * We approximate by looking at tool call patterns:
 * - Read tools (read_file, grep, glob) consume input but produce output
 * - Write tools (edit_file, write_file) produce tangible output
 * - A high read/write ratio with no edits suggests inefficiency.
 *
 * Returns 1.0 when balanced, approaches 0.0 when pure reading without progress.
 */
function computeTokenEfficiency(
  windowSize: number,
  history: ConvergenceInput['recentToolHistory'],
  _evidence: ConvergenceInput['evidenceState'],
): number {
  const window = history.slice(-windowSize)
  if (window.length === 0) return 0.5

  const readTools = new Set(['read_file', 'grep', 'glob', 'repo_map', 'repo_graph', 'inspect_project', 'lsp_goto_definition', 'lsp_find_references'])
  const writeTools = new Set(['edit_file', 'write_file'])
  const testTools = new Set(['run_tests', 'bash']) // bash may run tests

  let reads = 0
  let writes = 0
  let tests = 0

  for (const entry of window) {
    if (readTools.has(entry.tool)) reads++
    else if (writeTools.has(entry.tool)) writes++
    else if (testTools.has(entry.tool)) tests++
  }

  const total = reads + writes + tests
  if (total === 0) return 0.5

  // Balanced: writes + tests should balance reads
  // Pure reads with no output = zero efficiency
  const productive = writes + tests
  if (productive === 0) return 0.0 // all reads, no output
  if (reads === 0) return 0.9 // all productive, no pure reads

  // Efficiency: productive / total, with bonus for balanced ratio
  const rawEfficiency = productive / total
  // Boost when read:productive ratio is balanced (around 1:1 to 2:1)
  const ratio = reads / productive
  const balanceBonus = ratio >= 0.5 && ratio <= 2.0 ? 0.2 : 0.0

  return Math.min(1.0, rawEfficiency + balanceBonus)
}

/**
 * oscillationPenalty: detects A→B→A→B alternating patterns in tool fingerprints.
 * Uses a sliding window of the last 8 fingerprints.
 * Returns 0.0 (heavy penalty) when perfect oscillation is detected,
 * 1.0 when no oscillation is present.
 *
 * Oscillation defined as: at least 4 alternations among exactly 2 unique
 * fingerprints in the last 6-8 calls. This catches post-completion verification
 * loops where the model alternates between two read-only verification commands.
 */
function computeOscillationPenalty(fingerprints: ReadonlyArray<string>): number {
  const window = fingerprints.slice(-8)
  if (window.length < 6) return 1.0 // not enough data

  // Count unique fingerprints and check for alternation pattern
  const unique = new Set(window)
  if (unique.size !== 2) return 1.0 // oscillation requires exactly 2 alternating values

  const [a, b] = [...unique] as [string, string]
  let alternations = 0
  for (let i = 1; i < window.length; i++) {
    if (window[i] !== window[i! - 1]) alternations++
  }

  // Perfect oscillation: alternates every step (e.g., A,B,A,B,A,B,A,B = 7 alternations)
  // Severe oscillation: alternates most steps (>= 5 out of 7 possible)
  if (alternations >= 5) return 0.0  // heavy penalty
  if (alternations >= 3) return 0.3  // moderate penalty
  return 1.0
}

/**
 * textRepetitionPenalty: detects cross-turn text output repetition.
 * When the model produces nearly identical text across turns (despite calling
 * different tools), it's stuck in a "reformat the same analysis" loop.
 *
 * Uses word-level Jaccard similarity between recent text fingerprints.
 * Returns 0.0 (heavy penalty) when 3+ of the last 4 turns have >70% word overlap,
 * 1.0 when text is diverse across turns.
 */
function computeTextRepetitionPenalty(fingerprints: ReadonlyArray<string>): number {
  const window = fingerprints.slice(-5)
  if (window.length < 3) return 1.0 // not enough data

  // Compute word sets for each fingerprint (skip very short ones)
  const wordSets = window
    .filter(fp => fp.length >= 50)
    .map(fp => new Set(fp.split(/\s+/).filter(w => w.length >= 3)))

  if (wordSets.length < 3) return 1.0

  // Count pairs with high Jaccard similarity
  let highSimilarityPairs = 0
  let totalPairs = 0
  for (let i = 0; i < wordSets.length; i++) {
    for (let j = i + 1; j < wordSets.length; j++) {
      totalPairs++
      const a = wordSets[i]!
      const b = wordSets[j]!
      if (a.size === 0 || b.size === 0) continue
      let intersection = 0
      for (const word of a) {
        if (b.has(word)) intersection++
      }
      const union = a.size + b.size - intersection
      const jaccard = union > 0 ? intersection / union : 0
      if (jaccard > 0.7) highSimilarityPairs++
    }
  }

  if (totalPairs === 0) return 1.0

  // If more than half of pairs are highly similar, apply penalty
  const similarRatio = highSimilarityPairs / totalPairs
  if (similarRatio >= 0.6) return 0.0   // severe: majority of turns repeat same text
  if (similarRatio >= 0.4) return 0.3   // moderate
  return 1.0
}

// ─── Score Computation ──────────────────────────────────────────────

function computeConvergenceScore(
  signals: ConvergenceSignals,
  weights: PhaseWeights,
  phaseClass: PhaseClass,
  noToolTurnCount: number,
): number {
  const raw =
    weights.editRatio * signals.editRatio +
    weights.targetNovelty * signals.targetNovelty +
    weights.toolEntropy * signals.toolEntropy +
    weights.errorPenalty * signals.errorPenalty +
    weights.tokenEfficiency * signals.tokenEfficiency +
    weights.oscillationPenalty * signals.oscillationPenalty +
    weights.textRepetitionPenalty * signals.textRepetitionPenalty

  // Phase expectation penalty: phases that require edits (execute, verify,
  // deliver) are fundamentally off-track if no edits are happening.
  // Apply a soft multiplier when editRatio is critically low.
  const editExpectedPhases: PhaseClass[] = ['execute', 'verify', 'deliver']
  let penalty = 1.0
  if (editExpectedPhases.includes(phaseClass) && signals.editRatio < 0.1) {
    // Severity scales with how far below expectation we are
    penalty = 0.5
  }

  // No-tool-turn penalty: consecutive turns without tool calls signal
  // hesitation or text-only looping — model is "thinking" but not acting.
  // Tool-based signals can't detect this because recentToolHistory doesn't
  // grow on no-tool turns. Aggressively penalize after 2 consecutive empty turns.
  if (noToolTurnCount >= 3) {
    penalty = Math.min(penalty, 0.15) // severe: 3+ turns of doing nothing
  } else if (noToolTurnCount >= 2) {
    penalty = Math.min(penalty, 0.35) // moderate: 2 turns of hesitation
  } else if (noToolTurnCount >= 1) {
    penalty = Math.min(penalty, 0.7)  // mild: 1 turn — may be recovering
  }

  return Math.min(1.0, Math.max(0.0, raw * penalty))
}

// ─── Message Builder ────────────────────────────────────────────────

function buildInjectedMessage(
  level: 2 | 3,
  score: number,
  signals: ConvergenceSignals,
  phaseClass: PhaseClass,
  tier: WindowTier,
  deliveryStatus?: string,
  noToolTurnCount?: number,
): string {
  const lines: string[] = []

  // No-tool stagnation variant: consecutive turns without tool calls signal
  // hesitation or stuck state — the model is producing text/thinking but not
  // taking any action. This is a different failure mode from tool oscillation.
  if (noToolTurnCount && noToolTurnCount >= 2) {
    lines.push(`**系统感知：连续 ${noToolTurnCount} 轮未执行任何工具调用。**`)
    lines.push('')
    lines.push('模型可能陷入犹豫或重复输出文本但未采取实际行动。')
    lines.push('- 如果你发现了问题但不确定，请直接向用户指出')
    lines.push('- 如果需要更多信息，请调用 read_file / grep 等工具')
    lines.push('- 如果任务已完成，请输出摘要并结束回合')
    return lines.join('\n')
  }

  // Delivery-completion variant: when task is verified and convergence fires,
  // signal completion instead of asking the model to try harder.
  if (deliveryStatus === 'verified' && level === 2) {
    lines.push('**系统感知：所有代码变更已验证通过，任务可能已完成。**')
    lines.push('')
    lines.push('如果所有子任务已完成且验证通过，请结束当前回合。')
    lines.push('- 检查是否有遗漏的 deliver_task 调用')
    lines.push('- 如果没有，输出最终状态摘要并停止工具调用')
    return lines.join('\n')
  }

  if (level === 2) {
    lines.push('**系统感知：当前任务可能进入低效循环。**')
  } else {
    lines.push('**系统感知：任务未能在预期轮次内收敛，建议中断当前探索。**')
  }

  if (signals.editRatio < 0.1 && phaseClass === 'execute') {
    lines.push(`- 执行阶段进行了 ${Math.round(signals.editRatio * 100)}% 轮次有编辑产出的操作 — 远低于预期 (≥30%)`)
  }
  if (signals.toolEntropy < 0.3) {
    lines.push('- 工具使用模式高度重复，当前探索路径可能已穷尽')
  }
  if (signals.oscillationPenalty < 0.3) {
    lines.push('- 工具调用模式高度震荡 (A→B→A→B)，当前验证路径可能已穷尽')
  }
  if (signals.targetNovelty < 0.2 && phaseClass !== 'execute') {
    lines.push('- 目标文件重复率过高，建议扩大搜索范围或切换策略')
  }
  if (signals.errorPenalty < 0.5) {
    lines.push(`- 失败率 ${Math.round((1 - signals.errorPenalty) * 100)}% 偏高，当前方向可能不可行`)
  }
  if (signals.tokenEfficiency < 0.2 && phaseClass !== 'explore') {
    lines.push('- 纯读取无产出，建议立即采取编辑或测试行动验证当前假设')
  }
  if (signals.textRepetitionPenalty < 0.3) {
    lines.push('- 连续多轮输出高度相似的文本内容，模型可能陷入"重复输出"循环')
  }

  if (level === 3) {
    lines.push('')
    lines.push('**建议：** 提交已完成部分，重新描述需求并开始新一轮对话。')
    lines.push(`- 上下文窗口: ${tier.label}，当前已使用较多轮次`)
  } else {
    lines.push('')
    lines.push('请选择以下行动之一：')
    lines.push('- 对当前最可能的方案进行编辑或测试')
    lines.push('- 重新阅读用户原始请求，确认方向')
    lines.push('- 缩小范围：只解决一个子问题')
  }

  return lines.join('\n')
}

// ─── Main Entry Point ───────────────────────────────────────────────

export function evaluateConvergence(input: ConvergenceInput): ConvergenceResult {
  const tier = selectTier(input.contextWindow)
  const weights = PHASE_WEIGHTS[input.phaseClass]
  const windowSize = tier.signalWindow

  const signals: ConvergenceSignals = {
    editRatio: computeEditRatio(windowSize, input.recentToolHistory, input.evidenceState),
    targetNovelty: computeTargetNovelty(windowSize, input.recentToolHistory),
    toolEntropy: computeToolEntropy(windowSize, input.recentToolHistory),
    errorPenalty: computeErrorPenalty(windowSize, input.recentToolHistory),
    tokenEfficiency: computeTokenEfficiency(windowSize, input.recentToolHistory, input.evidenceState),
    oscillationPenalty: computeOscillationPenalty(input.toolFingerprints ?? []),
    textRepetitionPenalty: computeTextRepetitionPenalty(input.textFingerprints ?? []),
  }

  const score = computeConvergenceScore(signals, weights, input.phaseClass, input.noToolTurnCount ?? 0)

  // Determine escalation level
  let level: 0 | 1 | 2 | 3 = 0
  const turn = input.turn
  const noToolCount = input.noToolTurnCount ?? 0

  // No-tool stagnation: fire earlier than normal thresholds. When the model
  // produces multiple turns with no tool calls, it's clearly stuck — don't
  // wait for nLow/nMid/nHigh turn counts to accumulate.
  // Hard cap: 5+ consecutive no-tool turns → forced abort (prevents 10+ wasted LLM calls).
  const NO_TOOL_ABORT_THRESHOLD = 5
  const noToolStagnation = noToolCount >= 2
  if (noToolCount >= NO_TOOL_ABORT_THRESHOLD) {
    level = 3 // force abort — model is clearly stuck in a text-only loop
  } else if (noToolCount >= 3) {
    level = 2 // kick on 3+ consecutive no-tool turns
  } else if (noToolCount >= 2 && turn >= 4) {
    level = 2 // kick after 2 no-tool turns if we're past the very early turns
  } else if (turn >= tier.nHigh && score <= 0.2) {
    level = 3
  } else if (turn >= tier.nMid && score <= 0.4) {
    level = 2
  } else if (turn >= tier.nLow && score <= 0.6) {
    level = 1
  }

  // Level 0 early-exit ONLY for score-based detection (needs statistical
  // significance from enough turns).  No-tool stagnation is meaningful from
  // the very first turn — never override it with the early-exit gate.
  if (turn < tier.nLow && !noToolStagnation) {
    level = 0
  }

  const noToolForceAbort = noToolCount >= NO_TOOL_ABORT_THRESHOLD
  const shouldAbort = (level >= 3 && score < 0.1) || noToolForceAbort
  // Session split is pointless for no-tool stagnation — the problem is model
  // behavior, not context size.  Only split on score-based level 3.
  const shouldForceSplit = level >= 3 && !noToolForceAbort
  const shouldKick = level >= 2
  const injectedMessage = (level >= 2)
    ? buildInjectedMessage(level as 2 | 3, score, signals, input.phaseClass, tier, input.evidenceState.deliveryStatus, noToolCount)
    : null

  return {
    score,
    level,
    shouldAbort,
    injectedMessage,
    shouldKick,
    shouldForceSplit,
    signals,
  }
}
