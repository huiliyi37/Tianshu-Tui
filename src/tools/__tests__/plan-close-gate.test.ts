import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PLAN_TOOL } from '../plan.js'
import type { DeliveryGateResult } from '../../agent/delivery-gate-v2.js'
import type { VerificationSummary } from '../../agent/evidence.js'

/**
 * 防伪闭环 (evidence-gated plan closure): plan_close no longer trusts the model's
 * self-reported deliveryState/verifiedCommands when the session wired a real
 * delivery gate. A claimed-GREEN close is blocked when the gate is RED; the
 * closure records the REAL verified commands; the EXECUTED status marker is
 * written only on gate-backed GREEN. Absent a gate, behavior is unchanged.
 */
describe('plan tool close — evidence gate', () => {
  let dir = ''
  const planRel = '.rivet/plans/gate-plan.md'

  const PLAN_BODY = [
    '# Gate Plan',
    '',
    '## 6. Tasks',
    '',
    '### Task 1: Do the thing',
    '- [ ] step one',
    '- [ ] step two',
    '',
  ].join('\n')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-plan-gate-'))
    const abs = join(dir, planRel)
    mkdirSync(join(dir, '.rivet/plans'), { recursive: true })
    writeFileSync(abs, PLAN_BODY, 'utf-8')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function makeGate(over: Partial<DeliveryGateResult> = {}): DeliveryGateResult {
    return {
      state: 'GREEN',
      canDeliver: true,
      isBlocked: false,
      ownedFileCount: 1,
      externalFileCount: 0,
      verificationCount: 1,
      supersededFailures: 0,
      staleSnapshotDropped: 0,
      staleFailureCandidates: 0,
      toolInvocationFailureCandidates: [],
      ...over,
    }
  }

  function makeSummary(over: Partial<VerificationSummary> = {}): VerificationSummary {
    return { total: 1, verified: 1, pending: 0, files: [{ path: 'src/foo.ts', level: 'tested' }], ...over }
  }

  function close(input: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return PLAN_TOOL.execute({
      cwd: dir,
      input: { action: 'close', file_path: planRel, tasks: 'all', ...input },
      toolUseId: 'test-tool-use',
      ...extra,
    } as any)
  }

  const read = () => readFileSync(join(dir, planRel), 'utf-8')

  it('blocks a claimed-GREEN close when the real gate is RED (no write)', async () => {
    const before = read()
    const result = await close(
      { apply: true, deliveryState: 'GREEN', verifiedCommands: ['npm test'] },
      {
        assessDelivery: () => makeGate({
          state: 'RED',
          canDeliver: false,
          isBlocked: true,
          verificationCount: 0,
          blockingReason: 'owned files modified but unverified',
          shortestNextStep: 'run npm run typecheck',
        }),
        getVerificationEvidence: () => makeSummary({ verified: 0, pending: 1 }),
      },
    )

    assert.equal(result.isError, true)
    assert.ok(result.content.includes('blocked'))
    assert.ok(result.content.includes('run npm run typecheck'), 'includes shortestNextStep')
    assert.equal(read(), before, 'file must not be written when blocked')
  })

  it('blocks when deliveryState omitted (implicit GREEN) and gate is RED', async () => {
    const before = read()
    const result = await close(
      { apply: true },
      { assessDelivery: () => makeGate({ state: 'RED', isBlocked: true, canDeliver: false, verificationCount: 0 }) },
    )
    assert.equal(result.isError, true)
    assert.equal(read(), before)
  })

  it('writes EXECUTED marker + real verified commands on gate-backed GREEN', async () => {
    const result = await close(
      { apply: true, deliveryState: 'GREEN', verifiedCommands: ['npm test'] },
      {
        assessDelivery: () => makeGate({ state: 'GREEN', verificationCount: 2 }),
        getVerificationEvidence: () => makeSummary({ verified: 2, total: 2 }),
      },
    )

    assert.ok(!result.isError, result.content)
    const written = read()
    assert.ok(written.includes('> **Status: EXECUTED**'), 'EXECUTED marker written on real GREEN')
    assert.ok(written.includes('npm test'), 'real verified command recorded in closure')
    assert.ok(written.includes('- [x] step one'), 'checkboxes closed')
    assert.ok(result.content.includes('marked EXECUTED'))
  })

  it('allows an honest RED close (checkpoint) without EXECUTED marker', async () => {
    const result = await close(
      { apply: true, deliveryState: 'RED' },
      { assessDelivery: () => makeGate({ state: 'RED', isBlocked: true, canDeliver: false, verificationCount: 0 }) },
    )

    assert.ok(!result.isError, result.content)
    const written = read()
    assert.ok(!written.includes('Status: EXECUTED'), 'no EXECUTED marker on RED')
    assert.ok(written.includes('- [x] step one'), 'progress checkpoint still closes checkboxes')
    assert.ok(written.includes('交付门检查：RED'))
  })

  it('records the real (empty) verified set and notes mismatch when evidence is empty', async () => {
    const result = await close(
      { apply: true, deliveryState: 'GREEN', verifiedCommands: ['npm test', 'npm run typecheck'] },
      {
        assessDelivery: () => makeGate({ state: 'GREEN', verificationCount: 0 }),
        getVerificationEvidence: () => makeSummary({ verified: 0, total: 0, pending: 0, files: [] }),
      },
    )

    assert.ok(!result.isError, result.content)
    const written = read()
    assert.ok(!written.includes('npm test'), 'claimed-but-unbacked command must not be recorded')
    assert.ok(written.includes('未传入显式验证命令'), 'closure records the real (empty) set')
    assert.ok(result.content.includes('Evidence:'), 'mismatch noted in tool output')
  })

  it('degrades to legacy trust-claimed behavior when no gate is wired (backward compat)', async () => {
    const result = await close(
      { apply: true, deliveryState: 'GREEN', verifiedCommands: ['npm test'] },
      // no assessDelivery / getVerificationEvidence
    )

    assert.ok(!result.isError, result.content)
    const written = read()
    assert.ok(!written.includes('Status: EXECUTED'), 'legacy close never writes EXECUTED marker')
    assert.ok(written.includes('npm test'), 'legacy trusts claimed verified commands')
    assert.ok(written.includes('- [x] step one'))
    assert.ok(written.includes('交付门检查：GREEN'))
  })

  it('preview (apply omitted) never writes and warns when apply would be blocked', async () => {
    const before = read()
    const result = await close(
      { deliveryState: 'GREEN' },
      { assessDelivery: () => makeGate({ state: 'RED', isBlocked: true, canDeliver: false, verificationCount: 0 }) },
    )
    assert.ok(!result.isError)
    assert.ok(result.content.includes('preview'))
    assert.ok(result.content.includes('blocked'))
    assert.equal(read(), before, 'preview never writes')
  })
})
