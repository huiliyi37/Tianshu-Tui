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
  recentToolHistory: ReadonlyArray<Pick<ToolHistoryEntry, 'tool' | 'status' | 'target' | 'argsHash'>>
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
  /** Provider name for provider-specific thresholds (e.g. 'glm' gets tighter cutoffs).
   *  When absent, uses default DeepSeek-tuned values. */
  providerName?: string
  /** Total LLM output tokens consumed so far in this session.
   *  Used by tokenEfficiency signal to measure real output cost vs tool calls.
   *  When absent, falls back to the old tool-classification heuristic. */
  outputTokens?: number
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
  /**
   * When shouldAbort is true, why. 'no-tool' = consecutive no-tool hard cap;
   * 'score' = score-based level-3 abort. undefined when not aborting. Lets the
   * loop tag the stop-reason accurately without re-deriving the cause.
   */
  abortCause?: 'no-tool' | 'score'
  /**
   * Whether the model was still emitting fresh, substantial, non-repetitive
   * analysis (producingReport) when this was evaluated. When true, a no-tool
   * hard cap is downgraded from a hard abort to a kick — a deep-reasoning model
   * narrating multi-turn analysis is thinking, not spinning. Score-based
   * convergence aborts are unaffected (they measure orthogonal stagnation
   * signals). Surfaced so a near-miss (reasoning that almost got熔断) is
   * diagnosable.
   */
  reasoningActive: boolean
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
 *
 * Formula: (unique − 1) / (total − 1), so that N identical targets yield 0.0
 * (zero novelty) — not 1/N as a naive distinct/total would. A single target is
 * fully novel (1.0); an empty window is treated as fully novel (1.0) to match
 * the explore-phase early-game expectation that no history = open frontier.
 */
function computeTargetNovelty(
  windowSize: number,
  history: ConvergenceInput['recentToolHistory'],
): number {
  const window = history.slice(-windowSize)
  if (window.length === 0) return 1.0
  const seen = new Set<string>()
  for (const entry of window) seen.add(entry.argsHash ?? entry.target)
  if (seen.size === 1) return window.length === 1 ? 1.0 : 0.0
  return (seen.size - 1) / (window.length - 1)
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
 * tokenEfficiency: real output-token efficiency via exponential decay.
 * When outputTokens is available, uses exp(-tokensPerTool / 500) — direct
 * measurement of LLM output cost vs tool call count. Falls back to the old
 * tool-classification heuristic when outputTokens is absent.
 *
 * Returns 1.0 when efficient, approaches 0.0 when token-heavy without progress.
 */
function computeTokenEfficiency(
  windowSize: number,
  history: ConvergenceInput['recentToolHistory'],
  _evidence: ConvergenceInput['evidenceState'],
  outputTokens?: number,
): number {
  const toolCount = history.length
  // New path: real output tokens → exponential decay
  if (outputTokens !== undefined && toolCount > 0) {
    const tokensPerTool = outputTokens / toolCount
    if (tokensPerTool <= 0) return 1.0
    return Math.exp(-tokensPerTool / 500)
  }
  // Fallback: old tool-classification heuristic
  const window = history.slice(-windowSize)
  if (window.length === 0) return 0.5

  const readTools = new Set(['read_file', 'grep', 'glob', 'repo_map', 'repo_graph', 'inspect_project', 'lsp_goto_definition', 'lsp_find_references'])
  const writeTools = new Set(['edit_file', 'write_file'])
  const testTools = new Set(['run_tests', 'bash'])

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

  const productive = writes + tests
  if (productive === 0) return 0.0
  if (reads === 0) return 0.9

  const rawEfficiency = productive / total
  const ratio = reads / productive
  const balanceBonus = ratio >= 0.5 && ratio <= 2.0 ? 0.2 : 0.0

  return Math.min(1.0, rawEfficiency + balanceBonus)
}

/**
 * oscillationPenalty: detects A→B→A→B alternating patterns in tool fingerprints
 * via positional reversal counting — hash[i] === hash[i-2] && hash[i] !== hash[i-1].
 *
 * Returns continuous 0–1 (0 = heavy oscillation, 1 = no oscillation). Unlike the
 * old strict-2-unique-value gate, this catches gradual oscillation across 3+ values
 * (e.g. A→B→A→C→A→B) that the old detector silently ignored.
 */
function computeOscillationPenalty(fingerprints: ReadonlyArray<string>): number {
  if (fingerprints.length < 4) return 1.0 // need at least 4 to detect reversals
  let reversals = 0
  for (let i = 2; i < fingerprints.length; i++) {
    if (fingerprints[i] === fingerprints[i - 2] && fingerprints[i] !== fingerprints[i - 1]) {
      reversals++
    }
  }
  const possibleReversals = fingerprints.length - 2
  const oscillationRate = reversals / possibleReversals
  return Math.max(0, Math.min(1, 1 - oscillationRate))
}

/**
 * Whether computeOscillationPenalty has enough data to produce a meaningful
 * (non-sentinel) value. Updated to match new threshold: ≥ 4 fingerprints.
 */
function oscillationHasData(fingerprints: ReadonlyArray<string>): boolean {
  return fingerprints.length >= 4
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

/**
 * Whether computeTextRepetitionPenalty has enough data to produce a meaningful
 * (non-sentinel) value. The signal returns 1.0 both when data is insufficient
 * (too few fingerprints / too few long ones / no pairs) AND when text is
 * genuinely diverse. Only the former should trigger weight re-allocation.
 * Mirrors the guard conditions in computeTextRepetitionPenalty.
 */
function textRepetitionHasData(fingerprints: ReadonlyArray<string>): boolean {
  const window = fingerprints.slice(-5)
  if (window.length < 3) return false
  const longWordSets = window.filter(fp => fp.length >= 50)
    .map(fp => new Set(fp.split(/\s+/).filter(w => w.length >= 3)))
  return longWordSets.length >= 3
}

/** Minimum recent text length that counts as a substantial analysis/report. */
const REPORT_TEXT_MIN_LEN = 200

/**
 * isProducingReport: whether the agent is producing a substantial, fresh
 * (non-repetitive) text deliverable — an analysis, code review, or conclusion.
 *
 * This is the legitimate face of read-heavy work: for a "检查代码" / audit /
 * investigation task, the correct behavior IS to read+grep extensively and emit
 * a text report — never edits. Without this discriminator, such tasks get
 * flagged as read-only "stagnation" every turn and spammed with "去编辑/测试"
 * nudges. We only treat it as report production when the text is NOT repetitive
 * (textRepetitionPenalty high) — a repetitive read→reformat→read loop is the
 * genuine stuck case and must still be caught.
 */
function isProducingReport(
  textFingerprints: ReadonlyArray<string>,
  textRepetitionPenalty: number,
): boolean {
  if (textRepetitionPenalty < 0.7) return false // repetitive text = stuck loop, not a report
  const recent = textFingerprints.slice(-3)
  return recent.some(fp => fp.length >= REPORT_TEXT_MIN_LEN)
}

// ─── Score Computation ──────────────────────────────────────────────

function computeConvergenceScore(
  signals: ConvergenceSignals,
  weights: PhaseWeights,
  phaseClass: PhaseClass,
  noToolTurnCount: number,
  turn: number,
  recentToolHistory: ConvergenceInput['recentToolHistory'],
  providerName?: string,
  signalsMissingData: ReadonlySet<keyof ConvergenceSignals> = new Set(),
  producingReport = false,
): number {
  // Weight re-allocation for no-data signals: when a penalty signal lacks
  // sufficient data, its default 1.0 ("no penalty") would otherwise enter the
  // weighted sum at full weight and inflate the score — making the agent look
  // healthier than the evidence supports. Instead, redistribute that weight
  // equally across the signals that DO carry data. This closes the execute-phase
  // ~0.18 inflation (textRep 0.12 + oscillation 0.06 at default 1.0) during the
  // early-window period before these signals have enough fingerprints.
  //
  // Scoped to textRepetitionPenalty + oscillationPenalty only — these are
  // window-period no-data sentinels. errorPenalty's empty-window 1.0 is
  // semantically correct (no errors = full marks) and is NOT re-allocated.
  const w: PhaseWeights = { ...weights }
  if (signalsMissingData.size > 0) {
    // Re-allocate only to signals that are independent of editRatio: editRatio
    // is already a composite (gated by novelty below), so adding weight to it
    // would double-count novelty and mis-reward low-edit-ratio windows. The
    // four targets below are pure standalone signals.
    const others = ['targetNovelty', 'toolEntropy', 'errorPenalty', 'tokenEfficiency'] as const
    for (const missing of signalsMissingData) {
      const excess = w[missing]
      if (!excess) continue
      w[missing] = 0
      const perSignal = excess / others.length
      for (const key of others) w[key] += perSignal
    }
  }

  // editRatio is gated by targetNovelty: editing the same file repeatedly
  // (novelty collapses to 0) is原地打转, not progress — regardless of how many
  // successful edits happened. The 0.1 floor preserves a small baseline so a
  // legitimately iterative edit on one file (e.g. building up a large module)
  // is not zeroed out entirely.
  const effectiveEditRatio = signals.editRatio * Math.max(signals.targetNovelty, 0.1)
  const raw =
    w.editRatio * effectiveEditRatio +
    w.targetNovelty * signals.targetNovelty +
    w.toolEntropy * signals.toolEntropy +
    w.errorPenalty * signals.errorPenalty +
    w.tokenEfficiency * signals.tokenEfficiency +
    w.oscillationPenalty * signals.oscillationPenalty +
    w.textRepetitionPenalty * signals.textRepetitionPenalty

  // Phase expectation penalty: phases that require edits (execute, verify,
  // deliver) are fundamentally off-track if no edits are happening.
  // Apply a soft multiplier when editRatio is critically low.
  const editExpectedPhases: PhaseClass[] = ['execute', 'verify', 'deliver']
  let penalty = 1.0
  if (editExpectedPhases.includes(phaseClass) && signals.editRatio < 0.1) {
    // Severity scales with how far below expectation we are
    penalty = 0.5
  }

  // Read-only stagnation penalty: when ALL recent tools are read-class with
  // zero productive output (no edits/tests/commits), the model is in a
  // "keep exploring without converging" loop. This is the most common
  // infinite-loop pattern — the model reads file after file, each target
  // novel, entropy high, but never takes action.
  //
  // Uses productiveRatio (productive tools / total tools in window) instead of
  // a boolean hasProductive check. This catches alternating patterns like
  // read→think→read→think where each turn has a tool call but productive
  // ratio remains 0.
  //
  // GLM: Preserved Thinking accumulates server-side reasoning state across
  // turns. Once GLM enters a read-only loop the server retains that trajectory,
  // making it harder to break out — hence the tighter ramp (4→0.65 vs 8→0.7).
  // Default ramp is tuned for DeepSeek's stateless reasoning model.
  const productiveTools = new Set([
    'edit_file', 'write_file', 'hash_edit', 'apply_patch',
    'run_tests', 'bash', 'deliver_task', 'plan_submit', 'plan_close',
  ])
  const window = recentToolHistory.slice(-Math.min(turn, 15))
  const productiveCount = window.filter(h => productiveTools.has(h.tool)).length
  const productiveRatio = window.length > 0 ? productiveCount / window.length : 1.0
  const isGlm = providerName === 'glm'
  // Skip the read-only penalty when the agent is producing a substantial text
  // deliverable (review/analysis report): read-heavy work with a textual output
  // is legitimate progress, not stagnation.
  if (!producingReport && window.length >= (isGlm ? 2 : 4) && productiveRatio === 0) {
    if (isGlm) {
      // GLM ramp: turn 4→0.65, turn 7→0.35, turn 11→0.15, turn 15+→0.05
      if (turn >= 15) penalty = Math.min(penalty, 0.05)
      else if (turn >= 11) penalty = Math.min(penalty, 0.15)
      else if (turn >= 7) penalty = Math.min(penalty, 0.35)
      else if (turn >= 4) penalty = Math.min(penalty, 0.65)
    } else {
      // Default ramp: turn 8→0.7, turn 12→0.45, turn 16→0.25, turn 20+→0.1
      if (turn >= 20) penalty = Math.min(penalty, 0.1)
      else if (turn >= 16) penalty = Math.min(penalty, 0.25)
      else if (turn >= 12) penalty = Math.min(penalty, 0.45)
      else if (turn >= 8) penalty = Math.min(penalty, 0.7)
    }
  }

  // No-tool-turn penalty: consecutive turns without tool calls signal
  // hesitation or text-only looping — model is "thinking" but not acting.
  // Tool-based signals can't detect this because recentToolHistory doesn't
  // grow on no-tool turns.
  //
  // GLM: text-only loops escalate faster because Preserved Thinking
  // locks in the "I need more information" trajectory server-side.
  if (isGlm) {
    if (noToolTurnCount >= 2) {
      penalty = Math.min(penalty, 0.1)  // severe: 2+ turns with no tools
    } else if (noToolTurnCount >= 1) {
      penalty = Math.min(penalty, 0.4)  // moderate: 1 turn may be recovering
    }
  } else {
    if (noToolTurnCount >= 3) {
      penalty = Math.min(penalty, 0.15) // severe: 3+ turns of doing nothing
    } else if (noToolTurnCount >= 2) {
      penalty = Math.min(penalty, 0.35) // moderate: 2 turns of hesitation
    } else if (noToolTurnCount >= 1) {
      penalty = Math.min(penalty, 0.7)  // mild: 1 turn — may be recovering
    }
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
  productiveStagnation?: boolean,
): string {
  const lines: string[] = []

  // Productive-ratio stagnation variant: model keeps calling read/grep tools
  // (so noToolTurnCount stays 0), but never edits/tests/commits. This catches
  // the alternating read→analyze→read→analyze loop.
  if (productiveStagnation) {
    lines.push('**天枢-感知：最近多轮全部是读取/搜索操作，没有任何编辑、测试或提交。**')
    lines.push('')
    lines.push('信息可能已足够，请收敛：')
    lines.push('- 如果这是审查/排查类任务，输出你的结论或发现，交给用户判断——不要为了"做点什么"而去改代码')
    lines.push('- 如果这是实现类任务且已有方案，直接编辑或测试')
    lines.push('- 如果不确定方向，向用户说出你的判断')
    lines.push('- 如果任务已完成，输出摘要并结束')
    return lines.join('\n')
  }

  // No-tool stagnation variant: consecutive turns without tool calls signal
  // hesitation or stuck state — the model is producing text/thinking but not
  // taking any action. This is a different failure mode from tool oscillation.
  if (noToolTurnCount && noToolTurnCount >= 2) {
    lines.push(`**天璇-感知：连续 ${noToolTurnCount} 轮未执行任何工具调用。你可能陷入了隧道视野。**`)
    lines.push('')
    lines.push('停下来，换个角度看当前状态：')
    lines.push('- 如果你发现了问题但不确定，请直接向用户指出')
    lines.push('- 如果需要更多信息，请调用 read_file / grep 等工具')
    lines.push('- 如果任务已完成，请输出摘要并结束回合')
    lines.push('- 天璇胶囊（docs/seed-capsule-tianxuan.md）有换视角方法论可供 recall')
    return lines.join('\n')
  }

  // Delivery-completion variant: when task is verified and convergence fires,
  // signal completion instead of asking the model to try harder.
  if (deliveryStatus === 'verified' && level === 2) {
    lines.push('**天枢-感知：所有代码变更已验证通过，任务可能已完成。**')
    lines.push('')
    lines.push('如果所有子任务已完成且验证通过，请结束当前回合。')
    lines.push('- 检查是否有遗漏的 deliver_task 调用')
    lines.push('- 如果没有，输出最终状态摘要并停止工具调用')
    return lines.join('\n')
  }

  // Gate-aware variant: when delivery status is blocked or failed, integrate
  // the gate state into the convergence message instead of giving a generic
  // "换个角度看问题". The agent may be stuck in a retry loop that the gate
  // already classifies as non-blocking (YELLOW) — don't contradict the gate.
  if (deliveryStatus === 'blocked' || deliveryStatus === 'failed') {
    const gateLabel = deliveryStatus === 'blocked' ? '受阻' : '失败'
    lines.push(`**天枢-感知：交付门禁为 ${deliveryStatus.toUpperCase()}（验证${gateLabel}），任务进入收敛状态。**`)
    lines.push('')
    if (deliveryStatus === 'blocked') {
      lines.push('验证被外部因素阻断（超时、命令不存在、测试框架缺失）。不要反复重试同一方法。')
      lines.push('- 若为测试基础设施缺失：向用户说明并询问是否需要协助搭建')
      lines.push('- 若为超时：增加 timeout 或分批运行')
      lines.push('- 若已有可交付成果：确认 deliver_task 门禁状态，若 YELLOW 可带条件交付')
    } else {
      lines.push('验证失败。先诊断根因：是代码改动的 bug 还是预存量失败？')
      lines.push('- 查看 failure diagnostics 定位失败文件和错误类型')
      lines.push('- 若是预存量失败（改动前就存在）：不归你，force 交付或另行处理')
      lines.push('- 若是你的改动引入：用最小复现定位根因')
    }
    lines.push('- 不要让收敛信号和门禁信号矛盾——收敛说"换策略"，门禁说"可交付"')
    return lines.join('\n')
  }

  // Route-confirmation variant（2026-07-07，会话 519216c0 复盘）：编辑在持续
  // 落地且失败率低——轨迹本身没问题，收敛信号来自新颖度/熵类指标（同批文件
  // 反复改动、工具模式单一）。此时"换个角度看问题"是错误处方：路线正确的
  // 模型（尤其自带质疑的天权域）会整条驳回，advisory 沦为噪音。确认式收敛
  // 反其道：先肯定路线，把收敛动作定义为"钉一个验证锚点"而非改道。
  if (level === 2 && signals.editRatio >= 0.2 && signals.errorPenalty >= 0.8) {
    lines.push('**天枢-感知：编辑在持续落地且失败率低——路线本身没有被质疑，不需要换方向。**')
    lines.push('')
    lines.push('需要的是一个验证锚点，把已有进度钉住：')
    lines.push('- 对已完成的改动跑一次 typecheck / related_tests，通过后再铺开下一批')
    lines.push('- 验证失败则当场修复——不带伤推进')
    lines.push('- 若剩余工作已明确，列出剩余清单，按清单收敛而非按惯性续写')
    return lines.join('\n')
  }

  if (level === 2) {
    lines.push('**天璇-感知：当前任务可能进入低效循环。换个角度看问题。**')
  } else {
    lines.push('**天枢-感知：任务未能在预期轮次内收敛，建议中断当前探索。**')
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
  if (signals.tokenEfficiency === 0.0 && phaseClass === 'explore') {
    lines.push('- 已连续读取多个文件但未做任何编辑/测试/提交 — 信息已足够，请输出结论或采取行动')
  }
  if (signals.textRepetitionPenalty < 0.3) {
    lines.push('- 连续多轮输出高度相似的文本内容，模型可能陷入"重复输出"循环')
  }

  if (level === 3) {
    lines.push('')
    lines.push('**建议（按场景选择）：**')
    lines.push('- 若在排查回归（功能改动后丢失/失效）：不要开新对话重来——答案在提交历史里。优先 `git log --oneline` 定位区间 → `git bisect` 或回滚到最近可用 checkpoint 再前滚，对照基线 diff 直读引入回归的改动。')
    lines.push('- 其余场景：提交已完成部分，重新描述需求并开始新一轮对话。')
    lines.push(`- 上下文窗口: ${tier.label}，当前已使用较多轮次`)
  } else {
    lines.push('')
    lines.push('请选择以下行动之一：')
    lines.push('- 对当前最可能的方案进行编辑或测试')
    lines.push('- 重新阅读用户原始请求，确认方向')
    lines.push('- 缩小范围：只解决一个子问题')
    lines.push('- 天璇胶囊（docs/seed-capsule-tianxuan.md）有换视角方法论可供 recall')
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
    tokenEfficiency: computeTokenEfficiency(windowSize, input.recentToolHistory, input.evidenceState, input.outputTokens),
    oscillationPenalty: computeOscillationPenalty(input.toolFingerprints ?? []),
    textRepetitionPenalty: computeTextRepetitionPenalty(input.textFingerprints ?? []),
  }

  // Track which penalty signals lack sufficient data so their default-1.0
  // weight can be re-allocated instead of inflating the score. Only the two
  // window-period signals (oscillation, textRepetition) — errorPenalty's
  // empty-window 1.0 is a legitimate "no errors = full marks".
  const signalsMissingData = new Set<keyof ConvergenceSignals>()
  if (!oscillationHasData(input.toolFingerprints ?? [])) signalsMissingData.add('oscillationPenalty')
  if (!textRepetitionHasData(input.textFingerprints ?? [])) signalsMissingData.add('textRepetitionPenalty')

  // Fix 2 — a read-heavy task that is emitting a substantial, non-repetitive
  // text report (code review / audit / investigation) is producing its
  // deliverable, not stalling. Relax the read-only penalty and suppress the
  // productive-stagnation flag so it is not spammed with "去编辑/测试" nudges.
  //
  // 收窄（2026-07-04 触发面修复）：豁免仅对"纯审查"生效——存在未验证编辑时，
  // 边写长分析文本边搁置验证正是该被提醒的场景，不是审查报告。原豁免让
  // 排查/验证类会话（每轮都输出大段分析）把改道机制永久静音，验证轮次膨胀。
  const hasUnverifiedEdits = input.evidenceState.filesModified.size > 0
    && input.evidenceState.deliveryStatus !== 'verified'
  const producingReport = !hasUnverifiedEdits
    && isProducingReport(input.textFingerprints ?? [], signals.textRepetitionPenalty)

  const score = computeConvergenceScore(signals, weights, input.phaseClass, input.noToolTurnCount ?? 0, input.turn, input.recentToolHistory, input.providerName, signalsMissingData, producingReport)

  // Determine escalation level
  let level: 0 | 1 | 2 | 3 = 0
  const turn = input.turn
  const noToolCount = input.noToolTurnCount ?? 0

  // No-tool stagnation: fire earlier than normal thresholds. When the model
  // produces multiple turns with no tool calls, it's clearly stuck — don't
  // wait for nLow/nMid/nHigh turn counts to accumulate.
  // Hard cap: 5+ (default) / 3+ (GLM) consecutive no-tool turns → forced abort.
  const isGlm = input.providerName === 'glm'
  const NO_TOOL_ABORT_THRESHOLD = isGlm ? 3 : 5
  const noToolStagnation = noToolCount >= (isGlm ? 1 : 2) // GLM: fire on first no-tool turn

  // Productive-ratio stagnation: when recent tool calls are all non-productive
  // (read/grep/glob only, zero edits/tests/commits), the agent is in an
  // alternating read-analyze loop. This bypasses the turn gate because the
  // pattern is meaningful from early turns — each turn burns full input cost
  // (especially on GLM with no prefix cache).
  const productiveToolsSet = new Set([
    'edit_file', 'write_file', 'hash_edit', 'apply_patch',
    'run_tests', 'bash', 'deliver_task', 'plan_submit', 'plan_close',
  ])
  const stagnationWindow = input.recentToolHistory.slice(-windowSize)
  const productiveInWindow = stagnationWindow.filter(h => productiveToolsSet.has(h.tool)).length
  const productiveRatio = stagnationWindow.length > 0
    ? productiveInWindow / stagnationWindow.length
    : 1.0
  const productiveStagnation = stagnationWindow.length >= Math.min(windowSize, 4) && productiveRatio === 0 && !producingReport

  // Reasoning-aware no-tool handling. A model that keeps emitting fresh,
  // substantial, non-repetitive analysis on each no-tool turn is reasoning
  // through the problem (deep-thinking models legitimately narrate multi-turn
  // analysis before acting), NOT spinning in a text-only loop. `producingReport`
  // is the established "legitimate text deliverable" discriminator (non-repetitive
  // + substantial ≥200 chars); reuse it so such turns are nudged (kick) rather
  // than hard-killed. Genuine spin (repetitive / thin text) keeps producingReport
  // false → the hard abort still fires. This is the core fix for the "他在推理，
  // 但我们以为他终端" false circuit-break.
  const reasoningActive = producingReport

  if (noToolCount >= NO_TOOL_ABORT_THRESHOLD) {
    level = reasoningActive ? 2 : 3 // fresh reasoning → kick, not kill
  } else if (noToolCount >= 2 && isGlm) {
    level = reasoningActive ? 2 : 3 // GLM: 2 no-tool turns → abort unless reasoning
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
  // significance from enough turns).  No-tool stagnation and productive-ratio
  // stagnation are meaningful from the very first turn — never override them
  // with the early-exit gate.
  if (turn < tier.nLow && !noToolStagnation && !productiveStagnation) {
    level = 0
  }

  // Productive-ratio stagnation: if early-exit was bypassed but no other
  // condition set a level, ensure at least level 1 nudge fires.
  if (productiveStagnation && level === 0 && turn >= (isGlm ? 3 : 4)) {
    level = 1
  }

  const noToolForceAbort = noToolCount >= NO_TOOL_ABORT_THRESHOLD && !reasoningActive
  // Reasoning-aware guard applies only to the no-tool hard cap. A model that
  // keeps emitting fresh substantial analysis on no-tool turns is thinking, not
  // spinning, so the hard cap is downgraded to a kick. Score-based convergence
  // aborts are kept independent — they measure orthogonal stagnation signals
  // (repetition, oscillation, token efficiency) and should still fire when the
  // composite score says the session is stuck.
  const scoreAbort = level >= 3 && score < 0.1
  const shouldAbort = scoreAbort || noToolForceAbort
  // Session split is pointless for no-tool stagnation — the problem is model
  // behavior, not context size.  Only split on score-based level 3.
  const shouldForceSplit = level >= 3 && !noToolForceAbort
  const shouldKick = level >= 2
  const injectedMessage = (level >= 2)
    ? buildInjectedMessage(level as 2 | 3, score, signals, input.phaseClass, tier, input.evidenceState.deliveryStatus, noToolCount, productiveStagnation)
    : null

  return {
    score,
    level,
    shouldAbort,
    injectedMessage,
    shouldKick,
    shouldForceSplit,
    signals,
    abortCause: shouldAbort ? (noToolForceAbort ? 'no-tool' : 'score') : undefined,
    reasoningActive,
  }
}
