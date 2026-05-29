import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStanceTally } from '../stance-tally.js'
import type { VirtueSignal } from '../virtue-signals.js'

function sig(wuchang: VirtueSignal['wuchang'], evidence: string): VirtueSignal {
  return { type: 'independent-judgment', confidence: 0.9, wuchang, evidence }
}

describe('createStanceTally', () => {
  it('returns null with no recorded signals', () => {
    assert.equal(createStanceTally().render(), null)
  })

  it('tallies by wuchang and surfaces the latest evidence', () => {
    const t = createStanceTally()
    t.record(sig('仁', '质疑了用户的前提'))
    t.record(sig('仁', '再次质疑'))
    t.record(sig('义', '主动跑了测试'))
    const out = t.render()!
    assert.match(out, /仁\(质疑而非附和\)×2/)
    assert.match(out, /义\(主动验证\)×1/)
    assert.match(out, /最近一次：主动跑了测试/)
  })
})
