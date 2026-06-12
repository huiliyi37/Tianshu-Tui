import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { routeReviewWorkflow } from '../review-router.js'
import type { ChangeSet } from '../review-discipline.js'
import type { ReviewRouterDeps, VerifierResult } from '../review-router.js'

const fixChange: ChangeSet = { files: ['package.json'], crossModule: false, isFix: true }

const okDeps: ReviewRouterDeps = {
  spawnVerifier: async () => ({ verdict: 'verified', evidence: 'ran: npx tsx --test src/server/__tests__/task-registry.test.ts → 43/43' }),
  spawnPatcher: async () => ({ patched: true }),
  spawnSquadron: async () => ({ findings: [] }),
}

describe('routeReviewWorkflow', () => {
  it('routes L1 README to nudge only and spawns no agents', async () => {
    let verifierCalls = 0
    let patcherCalls = 0
    let squadronCalls = 0
    const outcome = await routeReviewWorkflow(
      { files: ['README.md'], crossModule: false, isFix: false },
      {
        spawnVerifier: async () => { verifierCalls++; return { verdict: 'verified', evidence: 'ran: docs check' } },
        spawnPatcher: async () => { patcherCalls++; return { patched: true } },
        spawnSquadron: async () => { squadronCalls++; return { findings: [] } },
      },
    )

    assert.equal(outcome.tier, 'L1')
    assert.equal(outcome.verdict, 'nudge')
    assert.equal(verifierCalls, 0)
    assert.equal(patcherCalls, 0)
    assert.equal(squadronCalls, 0)
  })

  it('routes L1 test-only fix to nudge (isFix does NOT force L2)', async () => {
    let verifierCalls = 0
    const outcome = await routeReviewWorkflow(
      { files: ['src/agent/__tests__/theta-check.test.ts'], crossModule: false, isFix: true },
      {
        ...okDeps,
        spawnVerifier: async () => { verifierCalls++; return { verdict: 'verified', evidence: 'ran: ok' } },
      },
    )

    assert.equal(outcome.tier, 'L1')
    assert.equal(outcome.verdict, 'nudge')
    assert.equal(verifierCalls, 0, 'test-only fix should not spawn verifier')
  })

  it('routes security boundary file to L3 squadron', async () => {
    let squadronCalls = 0
    const outcome = await routeReviewWorkflow(
      { files: ['src/agent/approval-risk.ts'], crossModule: false, isFix: true },
      {
        ...okDeps,
        spawnSquadron: async () => { squadronCalls++; return { findings: [] } },
      },
    )

    assert.equal(outcome.tier, 'L3')
    assert.equal(outcome.verdict, 'verified')
    assert.equal(squadronCalls, 1, 'security boundary file should trigger squadron')
  })

  it('routes L2 fix through verifier and passes only with evidence', async () => {
    const outcome = await routeReviewWorkflow(fixChange, okDeps)

    assert.equal(outcome.tier, 'L2')
    assert.equal(outcome.verdict, 'verified')
    assert.match(outcome.evidence ?? '', /ran:/)
    assert.equal(outcome.rounds, 1)
  })

  it('treats verified without evidence as rejected and patches before retrying', async () => {
    const verdicts: VerifierResult[] = [
      { verdict: 'verified', evidence: '   ' },
      { verdict: 'verified', evidence: 'ran: npx test → pass' },
    ]
    let patcherCalls = 0

    const outcome = await routeReviewWorkflow(fixChange, {
      ...okDeps,
      spawnVerifier: async () => verdicts.shift() ?? { verdict: 'verified', evidence: 'ran: fallback' },
      spawnPatcher: async () => { patcherCalls++; return { patched: true } },
    }, { maxRounds: 2 })

    assert.equal(outcome.verdict, 'verified')
    assert.equal(outcome.rounds, 2)
    assert.equal(patcherCalls, 1)
  })

  it('closed loop is bounded by maxRounds and then escalates', async () => {
    let verifierCalls = 0
    let patcherCalls = 0
    const outcome = await routeReviewWorkflow(fixChange, {
      ...okDeps,
      spawnVerifier: async () => { verifierCalls++; return { verdict: 'rejected', evidence: 'counterexample: concurrent create duplicates task' } },
      spawnPatcher: async () => { patcherCalls++; return { patched: true } },
    }, { maxRounds: 3 })

    assert.equal(outcome.tier, 'L2')
    assert.equal(outcome.verdict, 'rejected')
    assert.equal(outcome.escalated, true)
    assert.equal(outcome.rounds, 3)
    assert.equal(verifierCalls, 3)
    assert.equal(patcherCalls, 3)
  })

  it('routes L3 through squadron before verifier workflow', async () => {
    let squadronCalls = 0
    const outcome = await routeReviewWorkflow(
      { files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'], crossModule: false, isFix: false },
      {
        ...okDeps,
        spawnSquadron: async () => { squadronCalls++; return { findings: [] } },
      },
    )

    assert.equal(outcome.tier, 'L3')
    assert.equal(outcome.verdict, 'verified')
    assert.equal(squadronCalls, 1)
  })

  it('rejects L3 when squadron reports high-severity findings before verifier can pass it', async () => {
    let verifierCalls = 0
    const outcome = await routeReviewWorkflow(
      { files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'], crossModule: false, isFix: false },
      {
        ...okDeps,
        spawnVerifier: async () => { verifierCalls++; return { verdict: 'verified', evidence: 'ran: should not matter' } },
        spawnSquadron: async () => ({ findings: [{ severity: 'HIGH', claim: 'race' }], infraFailures: [] }),
      },
    )

    assert.equal(outcome.tier, 'L3')
    assert.equal(outcome.verdict, 'rejected')
    assert.equal(outcome.escalated, true)
    assert.match(outcome.evidence ?? '', /squadron/i)
    assert.equal(verifierCalls, 0)
  })

  it('L3 squadron with infra-only failures returns verified (no L2 fallthrough)', async () => {
    let verifierCalls = 0
    const outcome = await routeReviewWorkflow(
      { files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'], crossModule: false, isFix: false },
      {
        ...okDeps,
        spawnVerifier: async () => { verifierCalls++; return { verdict: 'verified', evidence: 'ran: npx tsc --noEmit → ok' } },
        spawnSquadron: async () => ({
          findings: [],
          infraFailures: [{ kind: 'json', claim: 'Worker result did not contain a JSON object' }],
        }),
      },
    )

    assert.equal(outcome.tier, 'L3')
    assert.equal(outcome.verdict, 'verified')
    assert.equal(verifierCalls, 0, 'L3 squadron pass skips L2 verifier')
    assert.equal(outcome.infraFailures?.length, 1)
    assert.match(outcome.evidence ?? '', /squadron/i)
  })

  it('L3 squadron with infra-only failures still passes (no L2 fallthrough)', async () => {
    const outcome = await routeReviewWorkflow(
      { files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'], crossModule: false, isFix: false },
      {
        ...okDeps,
        spawnVerifier: async () => ({ verdict: 'verified', evidence: '   ' }),
        spawnSquadron: async () => ({
          findings: [],
          infraFailures: [{ kind: 'timeout', claim: 'review worker timed out' }],
        }),
      },
    )

    assert.equal(outcome.tier, 'L3')
    assert.equal(outcome.verdict, 'verified', 'L3 squadron pass: no blocking findings → verified')
    assert.equal(outcome.infraFailures?.length, 1)
  })

  describe('auto mode (in-task review)', () => {
    const codeChange: ChangeSet = { files: ['src/agent/loop.ts'], crossModule: false, isFix: false }

    it('routes non-trivial change to a single wiring reviewer, not squadron/verifier', async () => {
      let wiringCalls = 0
      let squadronCalls = 0
      let verifierCalls = 0
      const outcome = await routeReviewWorkflow(codeChange, {
        spawnVerifier: async () => { verifierCalls++; return { verdict: 'verified', evidence: 'ran: x' } },
        spawnPatcher: async () => ({ patched: true }),
        spawnSquadron: async () => { squadronCalls++; return { findings: [] } },
        spawnWiringReviewer: async () => { wiringCalls++; return { findings: [], infraFailures: [] } },
      }, { mode: 'auto' })

      assert.equal(outcome.tier, 'auto')
      assert.equal(outcome.verdict, 'verified')
      assert.equal(wiringCalls, 1)
      assert.equal(squadronCalls, 0, 'auto mode must never spawn the full squadron')
      assert.equal(verifierCalls, 0, 'auto mode must never spawn the adversarial verifier')
    })

    it('downgrades structural L3 signals to the single wiring reviewer in auto mode', async () => {
      let wiringCalls = 0
      let squadronCalls = 0
      const outcome = await routeReviewWorkflow(
        { files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'], crossModule: true, isFix: false },
        {
          ...okDeps,
          spawnSquadron: async () => { squadronCalls++; return { findings: [] } },
          spawnWiringReviewer: async () => { wiringCalls++; return { findings: [] } },
        },
        { mode: 'auto' },
      )

      assert.equal(outcome.tier, 'auto')
      assert.equal(wiringCalls, 1)
      assert.equal(squadronCalls, 0)
    })

    it('blocks on CRITICAL/HIGH wiring findings', async () => {
      const outcome = await routeReviewWorkflow(codeChange, {
        ...okDeps,
        spawnWiringReviewer: async () => ({
          findings: [{ severity: 'HIGH', claim: 'dead param: activeTaskIds has zero callers' }],
        }),
      }, { mode: 'auto' })

      assert.equal(outcome.tier, 'auto')
      assert.equal(outcome.verdict, 'rejected')
      assert.match(outcome.evidence ?? '', /dead param/)
    })

    it('fails open on infra failures as INCONCLUSIVE — never claims verified', async () => {
      let calls = 0
      const outcome = await routeReviewWorkflow(codeChange, {
        ...okDeps,
        spawnWiringReviewer: async () => {
          calls++
          return {
            findings: [],
            infraFailures: [{ kind: 'timeout', claim: 'wiring reviewer timed out' }],
          }
        },
      }, { mode: 'auto' })

      assert.equal(outcome.verdict, 'inconclusive', 'infra failure must not produce a verified verdict')
      assert.equal(outcome.infraFailures?.length, 1)
      assert.match(outcome.evidence ?? '', /DID NOT run/)
      assert.doesNotMatch(outcome.evidence ?? '', /verified/i)
      assert.equal(calls, 1, 'timeout infra failure must NOT be retried — budget is exhausted')
    })

    it('retries once on non-timeout infra failure and recovers a real verdict', async () => {
      let calls = 0
      const outcome = await routeReviewWorkflow(codeChange, {
        ...okDeps,
        spawnWiringReviewer: async () => {
          calls++
          if (calls === 1) {
            return { findings: [], infraFailures: [{ kind: 'json', claim: 'non-JSON worker output' }] }
          }
          return { findings: [], infraFailures: [] }
        },
      }, { mode: 'auto' })

      assert.equal(calls, 2, 'one quick retry on worker/json infra failure')
      assert.equal(outcome.verdict, 'verified')
      assert.equal(outcome.recoveredByRetry, true)
    })

    it('stays inconclusive when the retry also fails, accumulating failure kinds', async () => {
      let calls = 0
      const outcome = await routeReviewWorkflow(codeChange, {
        ...okDeps,
        spawnWiringReviewer: async () => {
          calls++
          return { findings: [], infraFailures: [{ kind: 'worker', claim: `attempt ${calls} crashed` }] }
        },
      }, { mode: 'auto' })

      assert.equal(calls, 2)
      assert.equal(outcome.verdict, 'inconclusive')
      assert.equal(outcome.infraFailures?.length, 2, 'both attempts recorded')
      assert.match(outcome.evidence ?? '', /retry also failed/)
    })

    it('keeps trivial docs/test-only changes at nudge with no child agents', async () => {
      let wiringCalls = 0
      const outcome = await routeReviewWorkflow(
        { files: ['README.md', 'src/agent/__tests__/x.test.ts'], crossModule: false, isFix: false },
        { ...okDeps, spawnWiringReviewer: async () => { wiringCalls++; return { findings: [] } } },
        { mode: 'auto' },
      )

      assert.equal(outcome.verdict, 'nudge')
      assert.equal(wiringCalls, 0)
    })

    it('degrades to nudge when spawnWiringReviewer is not wired', async () => {
      const outcome = await routeReviewWorkflow(codeChange, okDeps, { mode: 'auto' })
      assert.equal(outcome.tier, 'auto')
      assert.equal(outcome.verdict, 'nudge')
    })
  })

  it('escalates immediately when patcher reports it did not patch a verifier rejection', async () => {
    let verifierCalls = 0
    let patcherCalls = 0
    const outcome = await routeReviewWorkflow(fixChange, {
      ...okDeps,
      spawnVerifier: async () => { verifierCalls++; return { verdict: 'rejected', evidence: 'broken' } },
      spawnPatcher: async () => { patcherCalls++; return { patched: false } },
    }, { maxRounds: 3 })

    assert.equal(outcome.tier, 'L2')
    assert.equal(outcome.verdict, 'rejected')
    assert.equal(outcome.escalated, true)
    assert.equal(outcome.rounds, 1)
    assert.equal(outcome.evidence, 'broken')
    assert.equal(verifierCalls, 1)
    assert.equal(patcherCalls, 1)
  })
})
