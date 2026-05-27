import type { CognitiveSeason, SeasonClassification } from './cognitive-season.js'

export interface WorldSeasonConfig {
  /** Duration of one complete external cycle in milliseconds. */
  cycleDurationMs: number
}

export const DEFAULT_WORLD_SEASON_CONFIG: WorldSeasonConfig = {
  cycleDurationMs: 86_400_000,
}

const SEASON_ORDER: readonly CognitiveSeason[] = ['genesis', 'reversal', 'return', 'wuwei'] as const

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus
}

/**
 * Compute a world-level season from an external UTC timestamp.
 *
 * This is deliberately independent from `classifySeason()`: cognitive season is
 * session-local state; world season is a shared external clock that independent
 * processes can observe without communicating.
 */
export function worldSeason(
  timestampMs: number,
  config: WorldSeasonConfig = DEFAULT_WORLD_SEASON_CONFIG,
): SeasonClassification {
  if (!Number.isFinite(config.cycleDurationMs) || config.cycleDurationMs <= 0) {
    throw new Error('cycleDurationMs must be a positive finite number')
  }

  const positionInCycle = positiveModulo(timestampMs, config.cycleDurationMs)
  const quarterDuration = config.cycleDurationMs / SEASON_ORDER.length
  const quarterIndex = Math.min(
    SEASON_ORDER.length - 1,
    Math.floor(positionInCycle / quarterDuration),
  )
  const progressInQuarter = positiveModulo(positionInCycle, quarterDuration) / quarterDuration
  const intensity = 1 - Math.abs(progressInQuarter - 0.5) * 2

  return {
    season: SEASON_ORDER[quarterIndex]!,
    intensity: Math.max(0, Math.min(1, intensity)),
  }
}
