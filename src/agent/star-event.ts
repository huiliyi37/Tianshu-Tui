import type { Sensorium } from './sensorium.js'

// ─── Star Phase ─────────────────────────────────────────────────────

/**
 * StarFlow v2 phases — dynamically driven by Sensorium rather than
 * hardcoded sequence. Each phase maps to a star (from the StarFlow
 * personality system) and has a distinct TUI glyph.
 */
export type StarPhase =
  | 'tianshu-planning'   // ◐ 观局 — 天枢规划
  | 'tianxuan-locating'  // ⚙ 寻迹 — 天璇定位
  | 'tianji-decomposing' // ⚙ 拆解 — 天玑拆解
  | 'tianquan-contracting' // ◐ 立约 — 天权立约
  | 'yuheng-implementing'  // ✦ 铸形 — 玉衡实现
  | 'kaiyang-testing'      // ❧ 试锋 — 开阳测试
  | 'yaoguang-delivering'  // ❧ 归航 — 摇光交付
  | 'tianshu-encore'       // ◐ 再临 — 天枢再临

/** Human-readable labels for each phase. */
export const PHASE_LABELS: Record<StarPhase, string> = {
  'tianshu-planning': '天枢 · 观局授策',
  'tianxuan-locating': '天璇 · 寻迹定位',
  'tianji-decomposing': '天玑 · 排阵拆解',
  'tianquan-contracting': '天权 · 立约定标',
  'yuheng-implementing': '玉衡 · 铸形实现',
  'kaiyang-testing': '开阳 · 试锋验证',
  'yaoguang-delivering': '摇光 · 归航交付',
  'tianshu-encore': '天枢 · 再临歧路',
}

/** Glyphs for TUI rendering. */
export const PHASE_GLYPHS: Record<StarPhase, string> = {
  'tianshu-planning': '◐',   // 天枢观局
  'tianxuan-locating': '⚙',  // 天璇寻迹
  'tianji-decomposing': '⚙', // 天玑拆解
  'tianquan-contracting': '◐', // 天权立约
  'yuheng-implementing': '✦',  // 玉衡铸形
  'kaiyang-testing': '❧',      // 开阳试锋
  'yaoguang-delivering': '❧',  // 摇光交付
  'tianshu-encore': '◐',       // 天枢再临
}

/** Short Chinese labels for strip display (≤5 chars). */
export const PHASE_SHORT_LABELS: Record<StarPhase, string> = {
  'tianshu-planning': '观局',
  'tianxuan-locating': '寻迹',
  'tianji-decomposing': '拆解',
  'tianquan-contracting': '立约',
  'yuheng-implementing': '铸形',
  'kaiyang-testing': '试锋',
  'yaoguang-delivering': '归航',
  'tianshu-encore': '再临',
}

// ─── Star Event ─────────────────────────────────────────────────────

/**
 * Runtime context needed to map a Sensorium snapshot to a StarPhase.
 * Fields not derivable from Sensorium alone.
 */
export interface StarPhaseContext {
  turn: number
  isWriting: boolean
  isRunningTests: boolean
  isFinalTurn: boolean
  shouldEscalate: boolean
  /** True if complexity > 0.5 was ever reached this session.
   *  Enables contracting phase (plan was decomposed, now settled). */
  hasEnteredHighComplexity: boolean
}

/**
 * Emitted whenever the star phase changes.
 * Carries the phase, the full Sensorium snapshot, and metadata
 * for TUI rendering and debugging.
 */
export interface StarEvent {
  phase: StarPhase
  sensorium: Sensorium
  turn: number
  timestamp: number
  label: string
  glyph: string
}

// ─── Phase Mapping ──────────────────────────────────────────────────

/**
 * Map a Sensorium snapshot + runtime context to a StarPhase.
 *
 * Priority order (first match wins):
 * 1. Encore: shouldEscalate + turn>1 + confidence<0.3 → 二次请星
 * 2. Testing: isRunningTests → 试锋
 * 3. Delivering: momentum>0.8 + isFinalTurn → 归航
 * 4. Implementing: confidence>0.6 + isWriting → 铸形
 * 5. Decomposing: complexity>0.5 → 排阵
 * 6. Contracting: wasHighComplexity + confidence>0.7 + complexity<0.4 + !writing + !testing → 立约
 * 7. Locating: freshness>0.7 → 寻迹
 * 8. Planning: shouldEscalate + turn===1 / freshness≤0.4 → 请星
 */
export function mapSensoriumToPhase(
  s: Sensorium,
  ctx: StarPhaseContext,
): StarPhase {
  // 1. Encore: low confidence mid-task
  if (ctx.shouldEscalate && ctx.turn > 1 && s.confidence < 0.3) {
    return 'tianshu-encore'
  }

  // 2. Testing
  if (ctx.isRunningTests) {
    return 'kaiyang-testing'
  }

  // 3. Delivering: high momentum on final turn
  if (s.momentum > 0.8 && ctx.isFinalTurn) {
    return 'yaoguang-delivering'
  }

  // 4. Implementing: confident + writing code
  if (s.confidence > 0.6 && ctx.isWriting) {
    return 'yuheng-implementing'
  }

  // 5. Decomposing: high complexity
  if (s.complexity > 0.5) {
    return 'tianji-decomposing'
  }

  // 6. Contracting: plan was complex, now settled → 立约
  if (ctx.hasEnteredHighComplexity && s.confidence > 0.7 && s.complexity < 0.4 && !ctx.isWriting && !ctx.isRunningTests) {
    return 'tianquan-contracting'
  }

  // 7. Locating: high freshness (familiar codebase)
  if (s.freshness > 0.7) {
    return 'tianxuan-locating'
  }

  // 8. Planning: default / first-turn escalation
  if (ctx.shouldEscalate && ctx.turn === 1) {
    return 'tianshu-planning'
  }

  // Default: start with locating/planning based on freshness
  return s.freshness > 0.4 ? 'tianxuan-locating' : 'tianshu-planning'
}

// ─── StarEvent Factory ──────────────────────────────────────────────

/**
 * Create a StarEvent from a Sensorium snapshot and context.
 * Pure function — deterministic, no side effects.
 */
export function createStarEvent(
  s: Sensorium,
  ctx: StarPhaseContext,
): StarEvent {
  const phase = mapSensoriumToPhase(s, ctx)
  return {
    phase,
    sensorium: s,
    turn: ctx.turn,
    timestamp: Date.now(),
    label: PHASE_LABELS[phase],
    glyph: PHASE_GLYPHS[phase],
  }
}

// ─── Theta-Gamma Rhythm ─────────────────────────────────────────────

/**
 * State tracker for theta-gamma cross-file consistency checks.
 *
 * Theta Phase Machine (upgraded from simple counter):
 * - Phase ∈ [0, 1): [0, 0.5) = ENCODING (receiving), [0.5, 1) = RETRIEVAL (reflection)
 * - Phase advances on each tool call, modulated by vigor and complexity
 * - Theta checks only fire in RETRIEVAL phase (momentum-gated)
 * - High vigor → slower phase advance (longer encoding, preserve flow)
 * - High complexity → faster phase advance (more frequent consistency checks)
 *
 * Enabled only when Sensorium.complexity > 0.5.
 */
export interface ThetaState {
  toolCallCount: number
  lastThetaAt: number
  interval: number
  /** Normalized phase [0, 1). 0 = start of encoding, 0.5 = retrieval boundary. */
  phase: number
  /** Number of times the phase has wrapped (cycled through a full rotation). */
  cycleCount: number
}

export function createThetaState(interval = 7): ThetaState {
  return { toolCallCount: 0, lastThetaAt: 0, interval, phase: 0, cycleCount: 0 }
}

/** Theta phase mode: encoding (receiving) or retrieval (reflection). */
export type ThetaPhase = 'encoding' | 'retrieval'

/** Get the current phase mode. [0, 0.5) → encoding, [0.5, 1) → retrieval. */
export function getThetaPhase(state: ThetaState): ThetaPhase {
  return state.phase < 0.5 ? 'encoding' : 'retrieval'
}

/**
 * Advance the theta counter and phase.
 * Returns true if it's time for a cross-file consistency check AND
 * the phase is in retrieval mode (momentum-safe).
 */
export function tickTheta(state: ThetaState, currentTurn: number): boolean {
  const next = state.toolCallCount + 1
  const due = next - state.lastThetaAt >= state.interval
  if (!due) return false
  // Phase gate: only fire theta checks during retrieval phase
  return state.phase >= 0.5
}

/**
 * Mark a theta check as completed, resetting the counter
 * and wrapping the phase back to encoding.
 */
export function completeTheta(state: ThetaState): ThetaState {
  return {
    ...state,
    toolCallCount: state.toolCallCount,
    lastThetaAt: state.toolCallCount,
    // Wrap phase back to start of encoding
    phase: 0,
    cycleCount: state.cycleCount + 1,
  }
}

export interface ThetaPhaseInput {
  /** Integrated behavioral energy [0, 1]. Higher = more encoding time. */
  vigor: number
  /** Task complexity [0, 1]. Higher = more frequent checks. */
  complexity: number
}

/**
 * Advance tool call counter AND phase.
 *
 * Phase step size is modulated by:
 * - vigor: high vigor → slower advance (preserve encoding flow)
 * - complexity: high complexity → faster advance (need more checks)
 *
 * A full phase cycle = interval tool calls at baseline.
 * Modulation scales the step by (1 - vigor * 0.4) * (0.5 + complexity * 0.5).
 */
export function advanceThetaCounter(state: ThetaState, phaseInput?: ThetaPhaseInput): ThetaState {
  const next = { ...state, toolCallCount: state.toolCallCount + 1 }

  if (!phaseInput) {
    // No modulation input → simple linear advance
    const step = 1 / (state.interval || 7)
    const newPhase = (state.phase + step) % 1
    const cycles = Math.floor((state.phase + step))
    return {
      ...next,
      phase: newPhase,
      cycleCount: state.cycleCount + cycles,
    }
  }

  const { vigor, complexity } = phaseInput
  const baseStep = 1 / (state.interval || 7)

  // Modulation: vigor slows phase (preserve flow), complexity accelerates (need checks)
  // Range: [0.3, 1.3] × baseStep
  const vigorMod = 1 - vigor * 0.4   // [0.6, 1.0] — high vigor = slower
  const complexityMod = 0.5 + complexity * 0.5  // [0.5, 1.0] — high complexity = faster
  const step = baseStep * vigorMod * complexityMod

  const rawPhase = state.phase + step
  const newPhase = rawPhase % 1
  const cycles = Math.floor(rawPhase)

  return {
    ...next,
    phase: newPhase,
    cycleCount: state.cycleCount + cycles,
  }
}
