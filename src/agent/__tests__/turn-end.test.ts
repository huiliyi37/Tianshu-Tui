import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { processTurnEnd, type TurnEndDeps } from '../turn-end.js'

describe('processTurnEnd', () => {
  function makeDeps(overrides?: Partial<TurnEndDeps>): TurnEndDeps {
    return {
      config: {
        promptEngine: {
          setTaskProgress: () => {},
          setDecisions: () => {},
        },
        modelCards: undefined,
        getCurrentModel: undefined,
        onModelSwitch: undefined,
      } as any,
      session: { getTurnCount: () => 5 } as any,
      trajectory: { getEntries: () => [] } as any,
      streamedText: 'I will fix the bug in auth.ts',
      routingMetrics: { record: () => {} } as any,
      decisions: [],
      evidence: { buildBadge: () => null } as any,
      ...overrides,
    }
  }

  it('returns empty decisions when no decisions in text', () => {
    const result = processTurnEnd(makeDeps())
    assert.ok(Array.isArray(result.decisions))
  })

  it('returns badge from evidence tracker', () => {
    const result = processTurnEnd(makeDeps({
      evidence: { buildBadge: () => '✓ 5 files, 3 tests' } as any,
    }))
    assert.equal(result.badge, '✓ 5 files, 3 tests')
  })

  it('skips task state for early turns (≤3)', () => {
    let called = false
    processTurnEnd(makeDeps({
      session: { getTurnCount: () => 2 } as any,
      config: {
        promptEngine: {
          setTaskProgress: () => { called = true },
          setDecisions: () => {},
        },
      } as any,
    }))
    assert.equal(called, false)
  })

  it('extracts task state for later turns (>3)', () => {
    let called = false
    processTurnEnd(makeDeps({
      session: { getTurnCount: () => 5 } as any,
      config: {
        promptEngine: {
          setTaskProgress: () => { called = true },
          setDecisions: () => {},
        },
      } as any,
    }))
    assert.equal(called, true)
  })

  it('caps decisions at 3', () => {
    const result = processTurnEnd(makeDeps({
      decisions: ['d1', 'd2', 'd3', 'd4'],
    }))
    assert.ok(result.decisions.length <= 3)
  })
})
