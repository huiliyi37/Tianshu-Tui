import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

function contextColor(health: string): string {
  if (health === 'critical') return 'red'
  if (health === 'compacting' || health === 'warning') return 'yellow'
  return 'green'
}

function roundsColor(apiSafe: boolean): string {
  return apiSafe ? 'green' : 'red'
}

function usageColor(ratio: number): string {
  if (ratio > 0.8) return 'red'
  if (ratio > 0.5) return 'yellow'
  return 'green'
}

function cacheColor(rate: number): string {
  if (rate === 0) return 'gray'
  if (rate >= 0.8) return 'green'
  if (rate >= 0.4) return 'yellow'
  return 'red'
}

function cacheStatusColor(status: string, rate: number): string {
  if (status === 'degraded') return 'red'
  if (status === 'recovering') return 'yellow'
  return cacheColor(rate)
}

function verificationSummaryColor(verified: number, total: number): string {
  if (total === 0 || verified === total) return 'green'
  if (verified === 0) return 'red'
  return 'yellow'
}

describe('StatusBar color logic', () => {
  it('maps context health levels to correct colors', () => {
    assert.equal(contextColor('healthy'), 'green')
    assert.equal(contextColor('warning'), 'yellow')
    assert.equal(contextColor('compacting'), 'yellow')
    assert.equal(contextColor('critical'), 'red')
  })

  it('maps api safety to correct colors', () => {
    assert.equal(roundsColor(true), 'green')
    assert.equal(roundsColor(false), 'red')
  })

  it('maps usage ratio to correct colors', () => {
    assert.equal(usageColor(0.3), 'green')
    assert.equal(usageColor(0.6), 'yellow')
    assert.equal(usageColor(0.9), 'red')
  })

  it('maps cache hit rate to correct colors', () => {
    assert.equal(cacheColor(0), 'gray')
    assert.equal(cacheColor(0.91), 'green')
    assert.equal(cacheColor(0.5), 'yellow')
    assert.equal(cacheColor(0.2), 'red')
  })

  it('cache status overrides cache color when degraded', () => {
    assert.equal(cacheStatusColor('degraded', 0.9), 'red')
    assert.equal(cacheStatusColor('recovering', 0.5), 'yellow')
    assert.equal(cacheStatusColor('healthy', 0.2), 'red')
    assert.equal(cacheStatusColor('healthy', 0.9), 'green')
  })

  it('maps verification summary to correct colors', () => {
    assert.equal(verificationSummaryColor(0, 0), 'green')
    assert.equal(verificationSummaryColor(0, 2), 'red')
    assert.equal(verificationSummaryColor(1, 2), 'yellow')
    assert.equal(verificationSummaryColor(2, 2), 'green')
  })
})
