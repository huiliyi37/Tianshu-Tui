import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  loadConfig,
  getRoutingConfig,
  setRoutingConfig,
} from '../manager.js'

describe('sub-agent / review routing config', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-routing-config-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('getRoutingConfig returns schema defaults when nothing is configured', () => {
    const { review, workers } = getRoutingConfig()
    assert.deepEqual(review.profiles, {})
    assert.equal(review.skipAuto, false)
    assert.equal(review.mechanicalFastPath, true)
    // workers has built-in defaults (default.ts)
    assert.equal(workers.routing.code_edit, 'cheap-flash')
    assert.deepEqual(workers.profiles['cheap-flash'], { provider: 'deepseek', model: 'deepseek-v4-flash' })
  })

  it('persists review profile overrides to config.json', () => {
    setRoutingConfig({
      review: {
        profiles: { reviewer: { provider: 'deepseek', model: 'deepseek-v4-flash' } },
        skipAuto: false,
        mechanicalFastPath: true,
      },
    })
    const review = loadConfig().agent.review
    assert.deepEqual(review.profiles.reviewer, { provider: 'deepseek', model: 'deepseek-v4-flash' })
  })

  it('persists skipAuto toggle', () => {
    setRoutingConfig({ review: { profiles: {}, skipAuto: true, mechanicalFastPath: true } })
    assert.equal(loadConfig().agent.review.skipAuto, true)
  })

  it('updating only workers leaves review untouched', () => {
    setRoutingConfig({
      review: {
        profiles: { reviewer: { provider: 'deepseek', model: 'deepseek-v4-flash' } },
        skipAuto: false,
        mechanicalFastPath: true,
      },
    })
    setRoutingConfig({
      workers: {
        profiles: { 'cheap-flash': { provider: 'deepseek', model: 'deepseek-v4-flash' } },
        routing: { code_edit: 'cheap-flash' },
      },
    })
    const cfg = loadConfig()
    assert.deepEqual(cfg.agent.review.profiles.reviewer, { provider: 'deepseek', model: 'deepseek-v4-flash' })
    assert.equal(cfg.workers.routing.code_edit, 'cheap-flash')
  })

  it('updating only review leaves workers defaults intact', () => {
    setRoutingConfig({ review: { profiles: {}, skipAuto: true, mechanicalFastPath: false } })
    const cfg = loadConfig()
    assert.equal(cfg.agent.review.skipAuto, true)
    // workers untouched → still has default routing
    assert.equal(cfg.workers.routing.code_edit, 'cheap-flash')
  })

  it('rejects an invalid review payload (missing model) without writing', () => {
    assert.throws(() =>
      setRoutingConfig({ review: { profiles: { reviewer: { provider: 'deepseek' } } } as unknown as Record<string, unknown> }),
    )
    // config.json must remain at defaults — nothing partial persisted
    assert.deepEqual(loadConfig().agent.review.profiles, {})
  })

  it('rejects an invalid workers payload (routing not a string map)', () => {
    assert.throws(() =>
      setRoutingConfig({ workers: { profiles: {}, routing: { code_edit: 123 } } as unknown as Record<string, unknown> }),
    )
  })

  it('returns the normalized blocks it wrote', () => {
    const result = setRoutingConfig({
      review: {
        profiles: { verifier: { provider: 'deepseek', model: 'deepseek-v4-pro' } },
        skipAuto: false,
        mechanicalFastPath: true,
      },
    })
    assert.deepEqual(result.review.profiles.verifier, { provider: 'deepseek', model: 'deepseek-v4-pro' })
  })

  it('getRoutingConfig defaults council.seats to empty', () => {
    const { council } = getRoutingConfig()
    assert.deepEqual(council.seats, [])
  })

  it('persists heterogeneous council seats and round-trips them', () => {
    const result = setRoutingConfig({
      council: {
        seats: [
          { authority: 'tianquan', charter: '架构与正确性', provider: 'deepseek', model: 'deepseek-v4-pro' },
          { authority: 'tianfu', provider: 'glm', model: 'glm-4.6' },
        ],
      },
    })
    assert.equal(result.council.seats.length, 2)
    assert.deepEqual(result.council.seats[1], { authority: 'tianfu', provider: 'glm', model: 'glm-4.6' })
    // round-trips through config.json
    assert.deepEqual(loadConfig().agent.council.seats[0]?.provider, 'deepseek')
    assert.deepEqual(getRoutingConfig().council.seats[0]?.authority, 'tianquan')
  })

  it('rejects a seat without authority (schema-validated, nothing persisted)', () => {
    assert.throws(() =>
      setRoutingConfig({ council: { seats: [{ provider: 'glm', model: 'glm-4.6' }] } } as unknown as Record<string, unknown>),
    )
    assert.deepEqual(loadConfig().agent.council.seats, [])
  })

  it('updating only council leaves review/workers untouched', () => {
    setRoutingConfig({ review: { profiles: { reviewer: { provider: 'deepseek', model: 'deepseek-v4-flash' } }, skipAuto: false, mechanicalFastPath: true } })
    setRoutingConfig({ council: { seats: [{ authority: 'tianquan', provider: 'glm', model: 'glm-4.6' }] } })
    assert.deepEqual(loadConfig().agent.review.profiles.reviewer, { provider: 'deepseek', model: 'deepseek-v4-flash' })
    assert.equal(loadConfig().agent.council.seats.length, 1)
  })
})
