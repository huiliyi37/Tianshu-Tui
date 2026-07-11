import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createVirtueSettlementHook } from '../hooks/virtue-settlement-hook.js'
import { createVirtuePendingLedger, type VirtueSignal, type VirtuePending } from '../virtue-signals.js'
import { AdvisoryReadback } from '../advisory-readback.js'
import type { CognitiveSeason } from '../cognitive-season.js'
import type { PheromoneDeposit } from '../../context/stigmergy.js'

function mkSignal(wuchang: VirtueSignal['wuchang'], type: VirtueSignal['type']): VirtueSignal {
  return { type, confidence: 0.7, wuchang, evidence: `test ${type}` }
}

function mkPending(signal: VirtueSignal, detectedTurn: number, windowTurns = 2): VirtuePending {
  return {
    signal,
    detectedTurn,
    utilityExpect: { kind: 'tool_appears', tools: ['edit_file'], withinTurns: windowTurns },
    windowTurns,
  }
}

interface TestHarness {
  deps: Parameters<typeof createVirtueSettlementHook>[0]
  recorded: VirtueSignal[]
  deposited: PheromoneDeposit[]
  get encouragementSubmitted(): boolean
}

function mkHarness(overrides?: {
  getSeason?: () => CognitiveSeason
  getRecentCacheHitRate?: () => number | null
}): TestHarness {
  const recorded: VirtueSignal[] = []
  const deposited: PheromoneDeposit[] = []
  const state = { encouragementSubmitted: false }
  const readback = new AdvisoryReadback()

  return {
    recorded,
    deposited,
    get encouragementSubmitted() { return state.encouragementSubmitted },
    deps: {
      ledger: createVirtuePendingLedger(),
      readback,
      recordStance: (s: VirtueSignal) => { recorded.push(s) },
      deposit: async (d: PheromoneDeposit) => { deposited.push(d) },
      advisoryBus: { submit: () => { state.encouragementSubmitted = true } } as any,
      getSeason: overrides?.getSeason ?? (() => 'genesis' as CognitiveSeason),
      getSeasonIntensity: () => 1.0,
      getRecentCacheHitRate: overrides?.getRecentCacheHitRate ?? (() => null),
    },
  }
}

/** Feed a tool event into readback so utility predicates can match */
function feedTool(readback: AdvisoryReadback, turn: number, name: string, target: string): void {
  readback.observeTool({ turn, name, target, isError: false })
}

describe('createVirtueSettlementHook', () => {
  it('returns PostTurnHook', () => {
    const h = mkHarness()
    const postTurn = createVirtueSettlementHook(h.deps)
    assert.equal(postTurn.phase, 'postTurn')
    assert.equal(postTurn.name, 'virtue-settlement-evaluate')
  })

  it('postTurn settles pending entries past deadline with observed utility', async () => {
    const h = mkHarness()
    const postTurn = createVirtueSettlementHook(h.deps)

    // Feed a matching tool at turn 2 so the utility predicate matches
    feedTool(h.deps.readback, 2, 'edit_file', 'src/foo.ts')

    h.deps.ledger.submit(mkPending(mkSignal('仁', 'independent-judgment'), 1, 2))
    await postTurn.run({ snapshot: { turn: 3 } } as any)

    assert.equal(h.recorded.length, 1, 'signal should be recorded after settlement')
    assert.equal(h.recorded[0]!.wuchang, '仁')
  })

  it('postTurn does not settle entries before deadline', async () => {
    const h = mkHarness()
    const postTurn = createVirtueSettlementHook(h.deps)

    h.deps.ledger.submit(mkPending(mkSignal('仁', 'independent-judgment'), 1, 2))
    await postTurn.run({ snapshot: { turn: 2 } } as any)
    assert.equal(h.recorded.length, 0)
  })

  it('genesis season allows encouragement submit', async () => {
    const h = mkHarness({ getSeason: () => 'genesis' })
    const postTurn = createVirtueSettlementHook(h.deps)

    feedTool(h.deps.readback, 2, 'edit_file', 'src/foo.ts')
    h.deps.ledger.submit(mkPending(mkSignal('义', 'proactive-verification'), 1, 2))
    await postTurn.run({ snapshot: { turn: 3 } } as any)

    assert.ok(h.encouragementSubmitted, 'encouragement should fire in genesis')
  })

  it('wuwei season suppresses encouragement but still records', async () => {
    const h = mkHarness({ getSeason: () => 'wuwei' })
    const postTurn = createVirtueSettlementHook(h.deps)

    feedTool(h.deps.readback, 2, 'edit_file', 'src/foo.ts')
    h.deps.ledger.submit(mkPending(mkSignal('义', 'proactive-verification'), 1, 2))
    await postTurn.run({ snapshot: { turn: 3 } } as any)

    assert.equal(h.encouragementSubmitted, false, 'no encouragement in wuwei')
    assert.equal(h.recorded.length, 1, 'but stance still recorded')
  })

  it('reversal season suppresses encouragement', async () => {
    const h = mkHarness({ getSeason: () => 'reversal' })
    const postTurn = createVirtueSettlementHook(h.deps)

    feedTool(h.deps.readback, 2, 'edit_file', 'src/foo.ts')
    h.deps.ledger.submit(mkPending(mkSignal('义', 'proactive-verification'), 1, 2))
    await postTurn.run({ snapshot: { turn: 3 } } as any)

    assert.equal(h.encouragementSubmitted, false, 'no encouragement in reversal')
  })

  it('utility check: ask without follow-up gets low utility, not recorded', async () => {
    const h = mkHarness()
    const postTurn = createVirtueSettlementHook(h.deps)

    // No tool fed to readback → wasSatisfiedBetween returns false → utility=0.2 → skip
    h.deps.ledger.submit(mkPending(mkSignal('仁', 'independent-judgment'), 1, 2))
    await postTurn.run({ snapshot: { turn: 3 } } as any)

    assert.equal(h.recorded.length, 0, 'low utility signal should not be recorded')
  })

  it('智: same tool+target reappears after detection → low utility, not recorded', async () => {
    const h = mkHarness()
    const postTurn = createVirtueSettlementHook(h.deps)

    // 智 detected at turn 1, probeTool='grep' probeTarget='src/foo.ts'
    h.deps.ledger.submit({
      signal: mkSignal('智', 'strategic-awareness'),
      detectedTurn: 1,
      utilityExpect: { kind: 'tool_appears', tools: [], withinTurns: 2 },
      windowTurns: 2,
      probeTool: 'grep',
      probeTarget: 'src/foo.ts',
    })
    // Same tool+target reappears at turn 2 → readback sees it
    h.deps.readback.observeTool({ turn: 2, name: 'grep', target: 'src/foo.ts', isError: false })
    await postTurn.run({ snapshot: { turn: 3 } } as any)

    assert.equal(h.recorded.length, 0, '智 with reappearing tool should NOT be recorded')
  })

  it('智: tool does NOT reappear after detection → high utility, recorded', async () => {
    const h = mkHarness()
    const postTurn = createVirtueSettlementHook(h.deps)

    h.deps.ledger.submit({
      signal: mkSignal('智', 'strategic-awareness'),
      detectedTurn: 1,
      utilityExpect: { kind: 'tool_appears', tools: [], withinTurns: 2 },
      windowTurns: 2,
      probeTool: 'grep',
      probeTarget: 'src/foo.ts',
    })
    // A DIFFERENT tool appears at turn 2 — grep+src/foo.ts does NOT reappear
    h.deps.readback.observeTool({ turn: 2, name: 'edit_file', target: 'src/bar.ts', isError: false })
    await postTurn.run({ snapshot: { turn: 3 } } as any)

    assert.equal(h.recorded.length, 1, '智 with no reappear should be recorded')
    assert.equal(h.recorded[0]!.wuchang, '智')
  })

  it('信(cache-loyalty): triggers when hitRate >= 80% and turn >= 5', async () => {
    const h = mkHarness({ getRecentCacheHitRate: () => 0.85 })
    const postTurn = createVirtueSettlementHook(h.deps)

    await postTurn.run({ snapshot: { turn: 5 } } as any)
    const xinRecorded = h.recorded.find(s => s.wuchang === '信')
    assert.ok(xinRecorded, '信 should trigger at turn 5 with 85% hit rate')
  })

  it('信: does not trigger when hitRate < 80%', async () => {
    const h = mkHarness({ getRecentCacheHitRate: () => 0.7 })
    const postTurn = createVirtueSettlementHook(h.deps)

    await postTurn.run({ snapshot: { turn: 5 } } as any)
    const xinRecorded = h.recorded.find(s => s.wuchang === '信')
    assert.equal(xinRecorded, undefined)
  })

  it('信: does not trigger before turn 5', async () => {
    const h = mkHarness({ getRecentCacheHitRate: () => 0.9 })
    const postTurn = createVirtueSettlementHook(h.deps)

    await postTurn.run({ snapshot: { turn: 4 } } as any)
    const xinRecorded = h.recorded.find(s => s.wuchang === '信')
    assert.equal(xinRecorded, undefined)
  })

  it('信: does not re-trigger within 10 turns of last trigger', async () => {
    const h = mkHarness({ getRecentCacheHitRate: () => 0.9 })
    const postTurn = createVirtueSettlementHook(h.deps)

    await postTurn.run({ snapshot: { turn: 5 } } as any)
    await postTurn.run({ snapshot: { turn: 8 } } as any)
    await postTurn.run({ snapshot: { turn: 14 } } as any)
    const xinCount = h.recorded.filter(s => s.wuchang === '信').length
    assert.equal(xinCount, 1, '信 should only trigger once in 10-turn window')
  })

  it('信: returns null when hitRate data unavailable', async () => {
    const h = mkHarness({ getRecentCacheHitRate: () => null })
    const postTurn = createVirtueSettlementHook(h.deps)

    await postTurn.run({ snapshot: { turn: 5 } } as any)
    const xinRecorded = h.recorded.find(s => s.wuchang === '信')
    assert.equal(xinRecorded, undefined, '信 should not trigger with null hit rate')
  })
})
