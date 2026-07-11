import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSessionVitalsTool, formatVitals, type SessionVitalsData } from '../session-vitals.js'

function makeVitals(overrides: Partial<SessionVitalsData> = {}): SessionVitalsData {
  return {
    ctx: { estimatedTokens: 340_000, contextWindow: 1_000_000, ratio: 0.34 },
    cache: [
      { turn: 10, cacheRead: 90_000, cacheCreation: 10_000 },
      { turn: 11, cacheRead: 100_000, cacheCreation: 0 },
    ],
    sensorium: { momentum: 0.5, pressure: 0.3, confidence: 0.7, complexity: 0.4, freshness: 0.6, stability: 0.8 },
    cvm: { overheadRatio: 0.012, throttled: false, ceiling: false },
    advisories: {
      rendered: 20, dropped: 5, adopted: 3, ignored: 2,
      top: [{ key: 'convergence', delivered: 12, adopted: 0, ignored: 0, silenced: true }],
    },
    turn: 42,
    ...overrides,
  }
}

describe('session_vitals tool (W5, incident 20b9714e)', () => {
  it('formats real numbers the model can cite verbatim', () => {
    const out = formatVitals(makeVitals())
    assert.ok(out.includes('340,000 / 1,000,000'), 'exact context numbers present')
    assert.ok(out.includes('34.0%'), 'context ratio present')
    assert.ok(out.includes('命中≈90.0%'), 'cache hit proxy present')
    assert.ok(out.includes('convergence: delivered=12 adopted=0'), 'advisory ledger top entry present')
    assert.ok(out.includes('[已静默]'), 'silenced marker present')
  })

  it('empty-truth discipline: missing data is labeled 无数据, never fabricated', () => {
    const out = formatVitals(makeVitals({ cache: [], sensorium: null }))
    assert.ok(out.includes('无数据'), 'missing dimensions must say 无数据')
    assert.ok(!out.includes('NaN'), 'no NaN leakage')
  })

  it('execute returns formatted vitals from the getter', async () => {
    const tool = createSessionVitalsTool(() => makeVitals())
    const result = await tool.execute({ input: {} } as never)
    assert.equal(result.isError ?? false, false)
    assert.ok(result.content.includes('session vitals'))
  })

  it('execute degrades gracefully without a runtime (worker context)', async () => {
    const tool = createSessionVitalsTool(() => null)
    const result = await tool.execute({ input: {} } as never)
    assert.ok(result.content.includes('不可用'))
  })

  it('is read-only: no approval, concurrency-safe, always enabled', () => {
    const tool = createSessionVitalsTool(() => null)
    assert.equal(tool.requiresApproval?.({} as never), false)
    assert.equal(tool.isConcurrencySafe?.(), true)
  })
})
