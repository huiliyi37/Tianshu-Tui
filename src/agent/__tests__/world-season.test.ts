import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { CognitiveSeason } from '../cognitive-season.js'
import {
  DEFAULT_WORLD_SEASON_CONFIG,
  worldSeason,
  type WorldSeasonConfig,
} from '../world-season.js'

describe('world-season: UTC external clock', () => {
  const config: WorldSeasonConfig = { cycleDurationMs: 86_400_000 }

  it('returns a valid cognitive season', () => {
    const result = worldSeason(Date.now(), config)
    const valid: CognitiveSeason[] = ['genesis', 'reversal', 'return', 'wuwei']
    assert.ok(valid.includes(result.season))
    assert.ok(result.intensity >= 0 && result.intensity <= 1)
  })

  it('is deterministic for the same timestamp and config', () => {
    const timestampMs = 1_716_364_800_000
    const first = worldSeason(timestampMs, config)
    const second = worldSeason(timestampMs, config)
    assert.deepEqual(first, second)
  })

  it('cycles through all four seasons within one full UTC cycle', () => {
    const quarter = config.cycleDurationMs / 4
    const seasons = [0, 1, 2, 3].map(i => worldSeason(i * quarter, config).season)
    assert.deepEqual(seasons, ['genesis', 'reversal', 'return', 'wuwei'])
  })

  it('lets independent instances observe the same season at the same moment', () => {
    const timestampMs = 1_716_364_800_000
    const instanceA = worldSeason(timestampMs, DEFAULT_WORLD_SEASON_CONFIG)
    const instanceB = worldSeason(timestampMs, DEFAULT_WORLD_SEASON_CONFIG)
    assert.deepEqual(instanceA, instanceB)
  })

  it('normalizes negative timestamps into the configured cycle', () => {
    const beforeEpoch = worldSeason(-1, config)
    const endOfCycle = worldSeason(config.cycleDurationMs - 1, config)
    assert.deepEqual(beforeEpoch, endOfCycle)
  })

  it('rejects invalid cycle durations', () => {
    assert.throws(
      () => worldSeason(Date.now(), { cycleDurationMs: 0 }),
      /cycleDurationMs must be a positive finite number/,
    )
  })
})
