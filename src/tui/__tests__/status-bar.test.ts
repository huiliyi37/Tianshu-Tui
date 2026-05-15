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
})
