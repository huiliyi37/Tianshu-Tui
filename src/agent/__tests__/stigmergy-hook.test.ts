import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntimeHookContext } from '../runtime-hooks.js'
import { createStigmergyRuntimeHook } from '../hooks/stigmergy-hook.js'
import type { PheromoneDeposit, PheromoneQueryResult } from '../../context/stigmergy.js'
import type { ToolHistoryEntry } from '../../prompt/volatile.js'

function makeContext(history: Array<Pick<ToolHistoryEntry, 'tool' | 'status' | 'target' | 'errorClass'>> = []) {
  return createRuntimeHookContext({
    cwd: '/tmp/project',
    turn: 3,
    recentToolHistory: history,
    sensorium: null,
    strategy: null,
    vigor: null,
    gitChangeRate: 0,
    season: null,
  })
}

function makeHook(options: {
  deposits: PheromoneDeposit[]
  queries?: PheromoneQueryResult[]
  verifications?: Array<{ status: string }>
  onRefresh?: (p: PheromoneQueryResult[]) => void
}) {
  return createStigmergyRuntimeHook({
    deposit: async deposit => { options.deposits.push(deposit) },
    query: async () => options.queries ?? [],
    getEvidenceState: () => ({ verifications: options.verifications ?? [] }),
    setLoadedPheromones: options.onRefresh ?? (() => {}),
  })
}

function makeHookWithLedger(options: {
  deposits: PheromoneDeposit[]
  queries?: PheromoneQueryResult[]
}, ledger: any[]) {
  return createStigmergyRuntimeHook({
    deposit: async deposit => { options.deposits.push(deposit) },
    query: async () => options.queries ?? [],
    getEvidenceState: () => ({ verifications: [] }),
    setLoadedPheromones: () => {},
    pendingLedger: { submit: (e: any) => { ledger.push(e) } } as any,
  })
}

describe('createStigmergyRuntimeHook', () => {
  it('deposits entry-point after repeated reads without writes', async () => {
    const deposits: PheromoneDeposit[] = []
    const hook = makeHook({ deposits })
    const ctx = makeContext([
      { tool: 'read_file', status: 'success', target: 'src/a.ts' },
      { tool: 'read_file', status: 'success', target: 'src/a.ts' },
      { tool: 'read_file', status: 'success', target: 'src/a.ts' },
    ])

    await hook.run(ctx, { name: 'read_file', success: true, target: 'src/a.ts' })

    assert.ok(deposits.some(d => d.path === 'src/a.ts' && d.signal === 'entry-point' && d.strength === 0.4))
  })

  it('does not deposit entry-point when the file was written', async () => {
    const deposits: PheromoneDeposit[] = []
    const hook = makeHook({ deposits })
    const ctx = makeContext([
      { tool: 'read_file', status: 'success', target: 'src/a.ts' },
      { tool: 'read_file', status: 'success', target: 'src/a.ts' },
      { tool: 'read_file', status: 'success', target: 'src/a.ts' },
      { tool: 'edit_file', status: 'success', target: 'src/a.ts' },
    ])

    await hook.run(ctx, { name: 'read_file', success: true, target: 'src/a.ts' })

    assert.ok(!deposits.some(d => d.path === 'src/a.ts' && d.signal === 'entry-point'))
  })

  it('deposits well-tested after write when verification passed', async () => {
    const deposits: PheromoneDeposit[] = []
    const hook = makeHook({ deposits, verifications: [{ status: 'passed' }] })

    await hook.run(makeContext(), { name: 'edit_file', success: true, target: 'src/a.ts' })

    assert.ok(deposits.some(d => d.path === 'src/a.ts' && d.signal === 'well-tested' && d.strength === 0.6))
  })

  it('deposits fragile after write when verification failed', async () => {
    const deposits: PheromoneDeposit[] = []
    const hook = makeHook({ deposits, verifications: [{ status: 'failed' }] })

    await hook.run(makeContext(), { name: 'write_file', success: true, target: 'src/a.ts' })

    assert.ok(deposits.some(d => d.path === 'src/a.ts' && d.signal === 'fragile' && d.strength === 0.8))
  })

  it('deposits dead-end after repeated bash failures', async () => {
    const deposits: PheromoneDeposit[] = []
    const hook = makeHook({ deposits })
    const ctx = makeContext([
      { tool: 'bash', status: 'failed', target: 'npm test' },
      { tool: 'bash', status: 'failed', target: 'npm test' },
    ])

    await hook.run(ctx, { name: 'bash', success: false, target: 'npm test' })

    assert.deepEqual(deposits, [{ path: 'npm test', signal: 'dead-end', strength: 0.9 }])
  })

  it('does NOT deposit dead-end when current bash succeeds (regression guard)', async () => {
    const deposits: PheromoneDeposit[] = []
    const hook = makeHook({ deposits })
    const ctx = makeContext([
      { tool: 'bash', status: 'failed', target: 'npm test' },
      { tool: 'bash', status: 'failed', target: 'npm test' },
    ])

    await hook.run(ctx, { name: 'bash', success: true, target: 'npm test' })

    assert.ok(!deposits.some(d => d.signal === 'dead-end'), 'current bash succeeded → no dead-end')
  })

  it('does NOT deposit dead-end for different targets (no cross-contamination)', async () => {
    const deposits: PheromoneDeposit[] = []
    const hook = makeHook({ deposits })
    const ctx = makeContext([
      { tool: 'bash', status: 'failed', target: 'npm test' },
      { tool: 'bash', status: 'failed', target: 'npx tsc --noEmit' },
    ])

    await hook.run(ctx, { name: 'bash', success: false, target: 'ls' })

    assert.ok(!deposits.some(d => d.signal === 'dead-end'), 'different targets must not accumulate')
  })

  it('does NOT deposit dead-end for timeout/environment-class failures', async () => {
    const deposits: PheromoneDeposit[] = []
    const hook = makeHook({ deposits })
    const ctx = makeContext([
      { tool: 'bash', status: 'failed', target: 'sleep 99', errorClass: 'timeout' },
      { tool: 'bash', status: 'failed', target: 'sleep 99', errorClass: 'timeout' },
    ])

    await hook.run(ctx, { name: 'bash', success: false, target: 'sleep 99', failureClass: 'timeout' })

    assert.ok(!deposits.some(d => d.signal === 'dead-end'), 'timeout is slow, not a dead-end')
  })

  it('refreshes loaded pheromones after processing', async () => {
    const deposits: PheromoneDeposit[] = []
    const refreshed: PheromoneQueryResult[][] = []
    const queries: PheromoneQueryResult[] = [{
      path: 'src/a.ts',
      signal: 'entry-point',
      strength: 0.4,
      depositedAt: 1,
      halfLife: 1000,
      currentStrength: 0.3,
    }]
    const hook = makeHook({ deposits, queries, onRefresh: p => { refreshed.push(p) } })

    await hook.run(makeContext(), { name: 'read_file', success: true, target: 'src/a.ts' })

    assert.deepEqual(refreshed, [queries])
  })

  // ── 发现二修复后的礼/仁判定 ──

  it('礼: write with approvalRequired=true triggers boundary-respect', async () => {
    const ledger: any[] = []
    const hook = makeHookWithLedger({ deposits: [] }, ledger)
    const ctx = makeContext()

    await hook.run(ctx, {
      name: 'edit_file', success: true, target: 'src/a.ts',
      approvalRequired: true,
    } as any)

    assert.ok(ledger.some((e: any) => e.signal.type === 'boundary-respect'),
      '礼 should trigger when approvalRequired=true')
  })

  it('礼: write without approvalRequired does NOT trigger boundary-respect', async () => {
    const ledger: any[] = []
    const hook = makeHookWithLedger({ deposits: [] }, ledger)
    const ctx = makeContext()

    await hook.run(ctx, {
      name: 'edit_file', success: true, target: 'src/a.ts',
    } as any)

    assert.ok(!ledger.some((e: any) => e.signal.type === 'boundary-respect'),
      '礼 should NOT trigger without approvalRequired')
  })

  it('礼: hash_edit with approvalRequired=true triggers boundary-respect', async () => {
    const ledger: any[] = []
    const hook = makeHookWithLedger({ deposits: [] }, ledger)
    const ctx = makeContext()

    await hook.run(ctx, {
      name: 'hash_edit', success: true, target: 'src/a.ts',
      approvalRequired: true,
    } as any)

    assert.ok(ledger.some((e: any) => e.signal.type === 'boundary-respect'),
      '礼 should trigger for hash_edit with approvalRequired=true')
  })

  it('仁: single-question with multiple options triggers (agreedWithUser=false)', async () => {
    const ledger: any[] = []
    const hook = makeHookWithLedger({ deposits: [] }, ledger)
    const ctx = makeContext()

    await hook.run(ctx, {
      name: 'ask_user_question', success: true,
      input: { question: 'Which?', options: ['A', 'B', 'C'] },
    } as any)

    const renEntry = ledger.find((e: any) => e.signal.wuchang === '仁')
    assert.ok(renEntry, '仁 should trigger for multi-option single question')
  })

  it('仁: single-question with <=1 option does NOT trigger (confirmative)', async () => {
    const ledger: any[] = []
    const hook = makeHookWithLedger({ deposits: [] }, ledger)
    const ctx = makeContext()

    await hook.run(ctx, {
      name: 'ask_user_question', success: true,
      input: { question: 'OK?', options: ['Yes'] },
    } as any)

    const renEntry = ledger.find((e: any) => e.signal.wuchang === '仁')
    assert.equal(renEntry, undefined, '仁 should NOT trigger for confirmative single-option question')
  })

  it('仁: multi-question (questions[]) with multi-option items triggers', async () => {
    const ledger: any[] = []
    const hook = makeHookWithLedger({ deposits: [] }, ledger)
    const ctx = makeContext()

    await hook.run(ctx, {
      name: 'ask_user_question', success: true,
      input: { questions: [{ prompt: 'Q1', options: ['A', 'B'] }] },
    } as any)

    const renEntry = ledger.find((e: any) => e.signal.wuchang === '仁')
    assert.ok(renEntry, '仁 should trigger for multi-question with multi-option items')
  })

  it('仁: multi-question (questions[]) with single-option items does NOT trigger', async () => {
    const ledger: any[] = []
    const hook = makeHookWithLedger({ deposits: [] }, ledger)
    const ctx = makeContext()

    await hook.run(ctx, {
      name: 'ask_user_question', success: true,
      input: { questions: [{ prompt: 'Q1', options: ['OK'] }] },
    } as any)

    const renEntry = ledger.find((e: any) => e.signal.wuchang === '仁')
    assert.equal(renEntry, undefined, '仁 should NOT trigger for confirmative multi-question')
  })
})
