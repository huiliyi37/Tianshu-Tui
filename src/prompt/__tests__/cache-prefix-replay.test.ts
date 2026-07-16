import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PromptEngine } from '../engine.js'
import type { OaiMessage } from '../../api/oai-types.js'

/**
 * W0/W5: local deterministic cache-prefix gate (earliest-divergence replay).
 *
 * Canonical serialization of consecutive requests: outside an explicit compact
 * boundary, every message of request N must be a byte-identical prefix of
 * request N+1. On failure we report the earliest divergence index and both
 * byte strings — this is the offline stand-in for the real provider smoke test
 * (scripts/verify-cache-hit-rate.ts, which needs DEEPSEEK_API_KEY).
 */

function makeEngine() {
  return new PromptEngine({
    model: 'test-model',
    maxTokens: 4096,
    staticCtx: { tools: [] },
    volatileCtx: {
      cwd: '/test/project',
      gitStatus: 'Current branch: main\nStatus:\nM src/foo.ts',
      rivetMd: '# Test Project',
    },
  })
}

interface DivergenceReport {
  index: number
  prev: string
  cur: string
}

/** Returns the earliest index where prev is NOT a byte prefix of cur, or null. */
function earliestDivergence(prev: string[], cur: string[]): DivergenceReport | null {
  for (let i = 0; i < prev.length; i++) {
    if (i >= cur.length) {
      return { index: i, prev: prev[i]!, cur: '<missing — request shrank>' }
    }
    if (prev[i] !== cur[i]) {
      return { index: i, prev: prev[i]!, cur: cur[i]! }
    }
  }
  return null
}

function serialize(messages: OaiMessage[]): string[] {
  return messages.map(m => JSON.stringify(m))
}

describe('cache-prefix replay: earliest-divergence gate', () => {
  it('append-only multi-turn conversation never diverges inside the previous prefix', () => {
    const engine = makeEngine()
    const conv: OaiMessage[] = []
    let prev: string[] = []

    for (let turn = 1; turn <= 6; turn++) {
      conv.push({ role: 'user', content: `question ${turn}` })
      const req = engine.buildOaiRequest(
        conv,
        turn > 1 ? [{ tool: 'read_file', target: `f${turn}.ts`, status: 'success' as const }] : undefined,
      )
      const bytes = serialize(req.messages)
      const div = earliestDivergence(prev, bytes)
      assert.equal(
        div,
        null,
        div
          ? `turn ${turn}: unexpected divergence at index ${div.index}\nprev: ${div.prev.slice(0, 200)}\ncur:  ${div.cur.slice(0, 200)}`
          : undefined,
      )
      assert.ok(bytes.length >= prev.length, `turn ${turn}: request must not shrink outside a compact boundary`)
      prev = bytes
      conv.push({ role: 'assistant', content: `answer ${turn}` })
    }
  })

  it('tool-call rounds keep the previous request as a byte prefix', () => {
    const engine = makeEngine()
    const conv: OaiMessage[] = [
      { role: 'user', content: 'do the task' },
    ]
    const req1 = engine.buildOaiRequest(conv)
    const bytes1 = serialize(req1.messages)

    // Simulate a tool round: assistant tool_call + tool result appended.
    conv.push({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'read_file_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
    })
    conv.push({ role: 'tool', tool_call_id: 'read_file_1', content: 'file body'.repeat(10) })
    const req2 = engine.buildOaiRequest(conv, [{ tool: 'read_file', target: 'a.ts', status: 'success' as const }])
    const bytes2 = serialize(req2.messages)

    const div = earliestDivergence(bytes1, bytes2)
    assert.equal(
      div,
      null,
      div
        ? `divergence at ${div.index}\nprev: ${div.prev.slice(0, 200)}\ncur:  ${div.cur.slice(0, 200)}`
        : undefined,
    )
  })

  it('reports a precise earliest-divergence index when history IS rewritten (sanity of the gate itself)', () => {
    const prev = ['{"a":1}', '{"b":2}', '{"c":3}']
    const cur = ['{"a":1}', '{"b":CHANGED}', '{"c":3}']
    const div = earliestDivergence(prev, cur)
    assert.ok(div)
    assert.equal(div!.index, 1)
  })

  it('flags request shrink (message disappeared) as divergence', () => {
    const prev = ['{"a":1}', '{"b":2}']
    const cur = ['{"a":1}']
    const div = earliestDivergence(prev, cur)
    assert.ok(div)
    assert.equal(div!.index, 1)
  })
})

describe('control-plane appendix cache gate (Wave 4)', () => {
  it('off/shadow: setControlPlaneAppendix(null) is byte-identical to never calling it', () => {
    const untouched = makeEngine()
    const nulled = makeEngine()
    nulled.setControlPlaneAppendix(null)
    const conv: OaiMessage[] = [{ role: 'user', content: 'same task' }]
    const a = serialize(untouched.buildOaiRequest(conv).messages)
    const b = serialize(nulled.buildOaiRequest(conv).messages)
    assert.deepEqual(b, a)
  })

  it('active: setting a control block never diverges earlier than the dynamic boundary (history prefix intact)', () => {
    const engine = makeEngine()
    const conv: OaiMessage[] = [{ role: 'user', content: 'q1' }]
    const req1 = engine.buildOaiRequest(conv)
    const bytes1 = serialize(req1.messages)

    // Frame changed → active mode sets a new block before the next build.
    engine.setControlPlaneAppendix('<control-plane>\n- [attention] worker wo-1 wrote 2 file(s) without transcript verification evidence\n</control-plane>')
    conv.push({ role: 'assistant', content: 'a1' })
    conv.push({ role: 'user', content: 'q2' })
    const req2 = engine.buildOaiRequest(conv)
    const bytes2 = serialize(req2.messages)

    // Previous request must remain a byte prefix — the block may only appear
    // in the NEW tail user message, never rewrite history.
    const div = earliestDivergence(bytes1, bytes2)
    assert.equal(div, null, div ? `divergence at ${div.index}` : undefined)
    assert.ok(bytes2.at(-1)?.includes('control-plane'), 'block must attach to the newest user message')
    for (const b of bytes2.slice(0, -1)) {
      assert.ok(!b.includes('<control-plane>'), 'block must not leak into historical messages')
    }
  })

  it('active: unchanged frame → identical bytes across consecutive builds (appendixDelta steady state)', () => {
    const engine = makeEngine()
    engine.setControlPlaneAppendix('<control-plane>\n- [info] stable fact\n</control-plane>')
    const conv: OaiMessage[] = [{ role: 'user', content: 'q1' }]
    const a = serialize(engine.buildOaiRequest(conv).messages)
    const b = serialize(engine.buildOaiRequest(conv).messages)
    assert.deepEqual(b, a)
  })
})
