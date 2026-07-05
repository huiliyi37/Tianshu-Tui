import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PromptEngine } from '../engine.js'
import type { OaiMessage } from '../../api/oai-types.js'

/**
 * Prefix-divergence probe (2026-07-05 cache investigation).
 *
 * DeepSeek's disk cache matches discrete "prefix units" — a cacheRead that
 * regresses below the previous call's input means either a client-side byte
 * change in history or a provider-side落盘 failure. The probe records, per
 * main-turn buildOaiRequest, whether the serialized messages are a pure append
 * over the previous request; if not, WHICH message diverged. cache-log joins
 * this with cacheRead regressions to attribute the break.
 */

function makeEngine(): PromptEngine {
  return new PromptEngine({
    model: 'test-model',
    maxTokens: 4096,
    staticCtx: { tools: [] },
    volatileCtx: { cwd: '/test/project', gitStatus: 'Current branch: main', rivetMd: '# Test' },
  })
}

function baseMessages(): OaiMessage[] {
  return [
    { role: 'user', content: 'turn 1: explore' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'grep', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'grep result: 42 matches' },
  ]
}

describe('prefix-divergence probe', () => {
  it('pure append records no divergence', () => {
    const engine = makeEngine()
    const msgs = baseMessages()
    engine.buildOaiRequest(msgs)
    assert.equal(engine.consumePrefixDivergence(), null, 'first build has no baseline')

    engine.buildOaiRequest([
      ...msgs,
      { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c2', content: 'file content' },
    ])
    assert.equal(engine.consumePrefixDivergence(), null, 'append-only must not report divergence')
  })

  it('mutating a historical tool result reports divergence at that index', () => {
    const engine = makeEngine()
    engine.buildOaiRequest(baseMessages())
    engine.consumePrefixDivergence()

    const mutated = baseMessages()
    mutated[2] = { ...mutated[2]!, content: 'grep result: REWRITTEN' } as OaiMessage
    engine.buildOaiRequest([
      ...mutated,
      { role: 'assistant', content: 'done' },
    ])

    const d = engine.consumePrefixDivergence()
    assert.ok(d, 'mutation must be reported')
    // idx 0 is the system message; the tool result sits at request index 3.
    assert.equal(d!.idx, 3)
    assert.equal(d!.role, 'tool')
    assert.equal(d!.kind, 'message_changed')
    assert.ok(d!.approxCharPos > 0)
  })

  it('history shrink with intact shared prefix reports message_removed', () => {
    const engine = makeEngine()
    engine.buildOaiRequest(baseMessages())
    engine.consumePrefixDivergence()

    // Clean shrink: history rewritten down to just the first user message
    // (no orphaned tool_calls, so the preflight repair stays out of the way).
    engine.buildOaiRequest(baseMessages().slice(0, 1))
    const d = engine.consumePrefixDivergence()
    assert.ok(d, 'shrink must be reported')
    assert.equal(d!.kind, 'message_removed')
    assert.ok(d!.newCount < d!.prevCount)
  })

  it('consume is one-shot', () => {
    const engine = makeEngine()
    engine.buildOaiRequest(baseMessages())
    const mutated = baseMessages()
    mutated[0] = { role: 'user', content: 'turn 1: CHANGED' }
    engine.buildOaiRequest(mutated)

    assert.ok(engine.consumePrefixDivergence())
    assert.equal(engine.consumePrefixDivergence(), null)
  })

  it('sidePath builds (compaction summaries) are hermetic — no baseline poisoning, no state writes', () => {
    const engine = makeEngine()
    const msgs = baseMessages()
    const mainReq1 = engine.buildOaiRequest(msgs)
    engine.consumePrefixDivergence()

    // Side-path summary request: unrelated message array, hermetic build.
    engine.buildOaiRequest(
      [{ role: 'user', content: '请总结以上对话' }],
      undefined,
      undefined,
      { sidePath: true },
    )

    // Next main-turn build: must be byte-identical on the shared prefix AND
    // report no divergence (side path neither probes nor mutates fresh-cache).
    const mainReq2 = engine.buildOaiRequest([
      ...msgs,
      { role: 'assistant', content: 'continuing' },
    ])
    assert.equal(engine.consumePrefixDivergence(), null, 'side-path build must not create a phantom divergence')
    for (let i = 0; i < mainReq1.messages.length; i++) {
      assert.deepEqual(mainReq2.messages[i], mainReq1.messages[i], `message ${i} must stay byte-identical across a side-path build`)
    }
  })

  it('reasoning_content changes on a historical assistant message are detected', () => {
    const engine = makeEngine()
    const withReasoning: OaiMessage[] = [
      { role: 'user', content: 'turn 1' },
      { role: 'assistant', content: 'reply', reasoning_content: 'thinking A' } as OaiMessage,
    ]
    engine.buildOaiRequest(withReasoning)
    engine.consumePrefixDivergence()

    const stripped: OaiMessage[] = [
      { role: 'user', content: 'turn 1' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'turn 2' },
    ]
    engine.buildOaiRequest(stripped)
    const d = engine.consumePrefixDivergence()
    assert.ok(d, 'reasoning strip is a byte change and must be reported')
    assert.equal(d!.idx, 2)
    assert.equal(d!.role, 'assistant')
  })
})
