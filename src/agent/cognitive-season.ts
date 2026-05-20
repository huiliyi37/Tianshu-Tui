import type { DoomLoopLevel } from './trace-store.js'

// ─── 认知季节 — 道德经四章螺旋 ────────────────────────────────
//
// 道生一，一生二，二生三，三生万物 → genesis
// 反者道之动                     → reversal
// 复归于朴                       → return
// 道常无为而无不为                → wuwei
//
// 天璇的温跃层洞察：季节之间不是跳变。
// warn 是生成→反转的温跃层，compact 后有 3-turn 复归窗口。
// 每个季节有强度（0-1），层间过渡是连续的。

export type CognitiveSeason = 'genesis' | 'reversal' | 'return' | 'wuwei'

export interface SeasonClassification {
  season: CognitiveSeason
  intensity: number
}

export interface SeasonInput {
  turn: number
  doomLevel: DoomLoopLevel
  recentCompactTurn: number | null
  sensoriumStability: number
}

const GENESIS_WINDOW = 5
const RETURN_WINDOW = 3
const WUWEI_STABILITY_THRESHOLD = 0.6

export function classifySeason(input: SeasonInput): SeasonClassification {
  // Priority 1: reversal overrides everything — 反者道之动
  // blocked = full reversal; warn = thermocline (0.5 intensity)
  if (input.doomLevel === 'blocked') {
    return { season: 'reversal', intensity: 1.0 }
  }
  if (input.doomLevel === 'warn') {
    return { season: 'reversal', intensity: 0.5 }
  }

  // Priority 2: return after compact — 复归于朴
  // 3-turn window, intensity fades linearly
  if (input.recentCompactTurn !== null) {
    const turnsSinceCompact = input.turn - input.recentCompactTurn
    if (turnsSinceCompact >= 0 && turnsSinceCompact < RETURN_WINDOW) {
      const intensity = 1.0 - (turnsSinceCompact / RETURN_WINDOW)
      return { season: 'return', intensity: Math.max(0, intensity) }
    }
  }

  // Priority 3: genesis — early session exploration
  // Intensity fades as the session matures
  if (input.turn <= GENESIS_WINDOW) {
    const intensity = 1.0 - ((input.turn - 1) / GENESIS_WINDOW)
    return { season: 'genesis', intensity: Math.max(0, intensity) }
  }

  // Priority 4: wuwei — stable long session, minimal intervention
  if (input.sensoriumStability >= WUWEI_STABILITY_THRESHOLD) {
    const intensity = (input.sensoriumStability - WUWEI_STABILITY_THRESHOLD)
      / (1.0 - WUWEI_STABILITY_THRESHOLD)
    return { season: 'wuwei', intensity: Math.min(1.0, intensity) }
  }

  // Fallback: unstable mid-session without doom → still exploring
  return { season: 'genesis', intensity: 0.3 }
}
