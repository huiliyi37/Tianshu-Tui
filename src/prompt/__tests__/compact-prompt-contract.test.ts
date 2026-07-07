import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PromptEngine } from '../engine.js'
import { extractTaskContract, renderTaskAnchor } from '../../context/task-contract.js'
import { latestUserTrailer } from './helpers/message-selectors.js'
import type { OaiMessage } from '../../api/oai-types.js'

// Safety net for the compaction work (compact-issue-1/2): the authoritative task
// anchor is the deterministic backstop that must survive a history rewrite. The
// real compact path re-injects the anchor and calls resetAppendixBaseline(); this
// test exercises that exact prompt-level contract end-to-end without driving the
// LLM compaction itself (which lives in the compaction-controller lane).
describe('compact prompt contract: task anchor survives a history rewrite', () => {
  function makeEngine() {
    return new PromptEngine({
      model: 'test-model',
      maxTokens: 4096,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/test/project', rivetMd: '# Test' },
    })
  }

  // A real contract: objective + file scope + a user hard-constraint ("don't …",
  // which the constraint extractor captures as a verbatim <constraint>).
  const userMsg = "Refactor src/auth.ts to use JWT. Don't touch the billing module."
  const contract = extractTaskContract(userMsg)
  const progress = { completed: ['wrote token helper'], remaining: ['migrate auth middleware'] }
  const anchor = renderTaskAnchor(contract, progress)

  function assertAnchorSurvives(trailerUser: string, label: string): void {
    assert.ok(trailerUser.includes('<task-anchor authoritative="true"'), `${label}: anchor block present`)
    assert.ok(trailerUser.includes('src/auth.ts'), `${label}: objective/scope (file) survives`)
    assert.ok(trailerUser.toLowerCase().includes('billing'), `${label}: user hard-constraint survives`)
    assert.ok(trailerUser.includes('wrote token helper'), `${label}: completed todo survives`)
    assert.ok(trailerUser.includes('migrate auth middleware'), `${label}: remaining todo survives`)
  }

  it('extractTaskContract captures the file scope and the user constraint', () => {
    assert.equal(contract.isActionable, true)
    assert.ok(contract.scope.mentionedFiles.includes('src/auth.ts'))
    assert.ok(contract.constraints.some(c => c.toLowerCase().includes('billing')))
    assert.ok(anchor.includes('<task-anchor authoritative="true"'))
  })

  it('anchor reaches the prompt before compaction', () => {
    const engine = makeEngine()
    engine.setActionableTurn(true)
    engine.setCognitiveProjection(anchor)

    const req = engine.buildOaiRequest([{ role: 'user', content: userMsg }])
    assertAnchorSurvives(latestUserTrailer(req.messages).user, 'pre-compaction')
  })

  it('anchor still reaches the prompt after a simulated compaction (resetAppendixBaseline + new user boundary)', () => {
    const engine = makeEngine()
    engine.setActionableTurn(true)
    engine.setCognitiveProjection(anchor)

    // Turn 1: anchor present.
    const req1 = engine.buildOaiRequest([{ role: 'user', content: userMsg }])
    assertAnchorSurvives(latestUserTrailer(req1.messages).user, 'pre-compaction')

    // Simulate what the compaction path does: history is rewritten and the
    // appendix baseline is reset, then the loop re-injects the authoritative
    // anchor for the next user boundary.
    engine.resetAppendixBaseline()
    engine.setCognitiveProjection(anchor)

    const rewritten: OaiMessage[] = [
      // Post-compaction history: an LLM summary stands in for the old turns, the
      // original objective text is gone from the live messages...
      { role: 'user', content: 'Summary: earlier work refactored auth; details elided.' },
      { role: 'assistant', content: 'Acknowledged.' },
      // ...and the user continues.
      { role: 'user', content: 'continue' },
    ]
    const req2 = engine.buildOaiRequest(rewritten)

    // The authoritative anchor (objective/constraint/todo) must still be in the
    // rebuilt prompt even though the original messages were replaced by a summary.
    assertAnchorSurvives(latestUserTrailer(req2.messages).user, 'post-compaction')
  })

  it('anchor sits in the dynamic tail, never in the frozen prefix (re-injection stays cache-safe)', () => {
    const engine = makeEngine()
    engine.setActionableTurn(true)
    engine.setCognitiveProjection(anchor)

    const req = engine.buildOaiRequest([{ role: 'user', content: userMsg }])
    const { fresh } = latestUserTrailer(req.messages)
    // The frozen volatile prefix must NOT carry the per-turn authoritative anchor,
    // otherwise re-injecting it every compaction would break the prefix cache.
    assert.ok(!fresh.includes('<task-anchor'), 'anchor must not be in the frozen prefix')
  })
})
