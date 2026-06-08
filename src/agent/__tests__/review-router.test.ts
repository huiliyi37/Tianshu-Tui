import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { routeReviewWorkflow } from '../review-router.js'
import type { ChangeSet } from '../review-discipline.js'
import type { ReviewRouterDeps, VerifierResult } from '../review-router.js'

const fixChange: ChangeSet = { files: ['src/server/task-registry.ts'], crossModule: false, isFix: true }

const okDeps: ReviewRouterDeps = {
  spawnVerifier: async () => ({ verdict: 'verified', evidence: 'ran: npx tsx --test src/server/__tests__/task-registry.test.ts → 43/43' }),
  spawnPatcher: async () => ({ patched: true }),
  spawnSquadron: async () => ({ findings: [] }),
}

describe('routeReviewWorkflow', () => {
  it('routes L1 micro-change to nudge only and spawns no agents', async () => {
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
      { files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'], crossModule: false, isFix: false },
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
      { files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'], crossModule: false, isFix: false },
      {
        ...okDeps,
        spawnVerifier: async () => { verifierCalls++; return { verdict: 'verified', evidence: 'ran: should not matter' } },
        spawnSquadron: async () => ({ findings: [{ severity: 'HIGH', claim: 'race' }] }),
      },
    )

    assert.equal(outcome.tier, 'L3')
    assert.equal(outcome.verdict, 'rejected')
    assert.equal(outcome.escalated, true)
    assert.match(outcome.evidence ?? '', /squadron/i)
    assert.equal(verifierCalls, 0)
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
