import type { Sensorium } from './sensorium.js'

// ─── Star Phase ─────────────────────────────────────────────────────

/**
 * StarFlow v2 phases — dynamically driven by Sensorium rather than
 * hardcoded sequence. Each phase maps to a star (from the StarFlow
 * personality system) and has a distinct TUI glyph.
 */
export type StarPhase =
  | 'tianshu-planning'   // ⭐ 请星/观局 — 天枢规划
  | 'tianxuan-locating'  // 🔍 寻迹 — 天璇定位
  | 'tianji-decomposing' // 📐 排阵 — 天玑拆解
  | 'tianquan-contracting' // 📜 立约 — 天权立约
  | 'yuheng-implementing'  // 🔨 铸形 — 玉衡实现
  | 'kaiyang-testing'      // ⚔️ 试锋 — 开阳测试
  | 'yaoguang-delivering'  // 🏠 归航 — 摇光交付
  | 'tianshu-encore'       // ⭐⭐ 二次请星 — 天枢再临

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
  'tianshu-planning': '⭐',
  'tianxuan-locating': '🔍',
  'tianji-decomposing': '📐',
  'tianquan-contracting': '📜',
  'yuheng-implementing': '🔨',
  'kaiyang-testing': '⚔️',
  'yaoguang-delivering': '🏠',
  'tianshu-encore': '⭐⭐',
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
 * 6. Contracting: confidence>0.7 + complexity<0.4 + !writing + !testing → 立约
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

  // 6. Contracting: confident + plan clear + not writing yet → 立约
  if (s.confidence > 0.7 && s.complexity < 0.4 && !ctx.isWriting && !ctx.isRunningTests) {
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
 * Theta cycle: every N tool calls, pause and verify cross-file
 * consistency (import resolution, type signature matching).
 * Enabled only when Sensorium.complexity > 0.5.
 */
export interface ThetaState {
  toolCallCount: number
  lastThetaAt: number
  interval: number
}

export function createThetaState(interval = 7): ThetaState {
  return { toolCallCount: 0, lastThetaAt: 0, interval }
}

/**
 * Advance the theta counter. Returns true if it's time for a
 * cross-file consistency check.
 */
export function tickTheta(state: ThetaState, currentTurn: number): boolean {
  const next = state.toolCallCount + 1
  return next - state.lastThetaAt >= state.interval
}

/**
 * Mark a theta check as completed, resetting the counter.
 */
export function completeTheta(state: ThetaState): ThetaState {
  return {
    ...state,
    toolCallCount: state.toolCallCount,
    lastThetaAt: state.toolCallCount,
  }
}

/**
 * Advance tool call counter (called after every tool execution).
 */
export function advanceThetaCounter(state: ThetaState): ThetaState {
  return { ...state, toolCallCount: state.toolCallCount + 1 }
}
