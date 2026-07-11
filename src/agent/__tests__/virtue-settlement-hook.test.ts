import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createVirtueSettlementHooks } from '../hooks/virtue-settlement-hook.js'
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
  deps: Parameters<typeof createVirtueSettlementHooks>[0]
  recorded: VirtueSignal[]
  deposited: PheromoneDeposit[]
  get encouragementSubmitted(): boolean
}

function mkHarness(overrides?: {
  getSeason?: () => CognitiveSeason
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
      getRecentCacheHitRate: () => null,
    },
  }
}

/** Feed a tool event into readback so utility predicates can match */
function feedTool(readback: AdvisoryReadback, turn: number, name: string, target: string): void {
  readback.observeTool({ turn, name, target, isError: false })
}

describe('createVirtueSettlementHooks', () => {
  it('returns [PostToolHook, PostTurnHook] pair', () => {
    const h = mkHarness()
    const [postTool, postTurn] = createVirtueSettlementHooks(h.deps)
    assert.equal(postTool.phase, 'postTool')
    assert.equal(postTool.name, 'virtue-settlement-observe')
    assert.equal(postTurn.phase, 'postTurn')
    assert.equal(postTurn.name, 'virtue-settlement-evaluate')
  })

  it('postTurn settles pending entries past deadline with observed utility', async () => {
    const h = mkHarness()
    const [_, postTurn] = createVirtueSettlementHooks(h.deps)

    // Feed a matching tool at turn 2 so the utility predicate matches
    feedTool(h.deps.readback, 2, 'edit_file', 'src/foo.ts')

    h.deps.ledger.submit(mkPending(mkSignal('仁', 'independent-judgment'), 1, 2))
    await postTurn.run({ snapshot: { turn: 3 } } as any)

    assert.equal(h.recorded.length, 1, 'signal should be recorded after settlement')
    assert.equal(h.recorded[0]!.wuchang, '仁')
  })

  it('postTurn does not settle entries before deadline', async () => {
    const h = mkHarness()
    const [_, postTurn] = createVirtueSettlementHooks(h.deps)

    h.deps.ledger.submit(mkPending(mkSignal('仁', 'independent-judgment'), 1, 2))
    await postTurn.run({ snapshot: { turn: 2 } } as any)
    assert.equal(h.recorded.length, 0)
  })

  it('genesis season allows encouragement submit', async () => {
    const h = mkHarness({ getSeason: () => 'genesis' })
    const [_, postTurn] = createVirtueSettlementHooks(h.deps)

    feedTool(h.deps.readback, 2, 'edit_file', 'src/foo.ts')
    h.deps.ledger.submit(mkPending(mkSignal('义', 'proactive-verification'), 1, 2))
    await postTurn.run({ snapshot: { turn: 3 } } as any)

    assert.ok(h.encouragementSubmitted, 'encouragement should fire in genesis')
  })

  it('wuwei season suppresses encouragement but still records', async () => {
    const h = mkHarness({ getSeason: () => 'wuwei' })
    const [_, postTurn] = createVirtueSettlementHooks(h.deps)

    feedTool(h.deps.readback, 2, 'edit_file', 'src/foo.ts')
    h.deps.ledger.submit(mkPending(mkSignal('义', 'proactive-verification'), 1, 2))
    await postTurn.run({ snapshot: { turn: 3 } } as any)

    assert.equal(h.encouragementSubmitted, false, 'no encouragement in wuwei')
    assert.equal(h.recorded.length, 1, 'but stance still recorded')
  })

  it('reversal season suppresses encouragement', async () => {
    const h = mkHarness({ getSeason: () => 'reversal' })
    const [_, postTurn] = createVirtueSettlementHooks(h.deps)

    feedTool(h.deps.readback, 2, 'edit_file', 'src/foo.ts')
    h.deps.ledger.submit(mkPending(mkSignal('义', 'proactive-verification'), 1, 2))
    await postTurn.run({ snapshot: { turn: 3 } } as any)

    assert.equal(h.encouragementSubmitted, false, 'no encouragement in reversal')
  })

  it('utility check: ask without follow-up gets low utility, not recorded', async () => {
    const h = mkHarness()
    const [_, postTurn] = createVirtueSettlementHooks(h.deps)

    // No tool fed to readback → wasSatisfiedBetween returns false → utility=0.2 → skip
    h.deps.ledger.submit(mkPending(mkSignal('仁', 'independent-judgment'), 1, 2))
    await postTurn.run({ snapshot: { turn: 3 } } as any)

    assert.equal(h.recorded.length, 0, 'low utility signal should not be recorded')
  })
})
