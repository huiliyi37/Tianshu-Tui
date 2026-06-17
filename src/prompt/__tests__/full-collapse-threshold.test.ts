import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PromptEngine } from '../engine.js'
import type { OaiMessage } from '../../api/oai-types.js'

/**
 * Regression lock for option A: the T7 full collapse pass (semantic collapse of
 * old tool results, which breaks the exact-prefix cache on DeepSeek) must be
 * deferred until the window is genuinely near-full (FULL_COLLAPSE_FILL_RATIO =
 * 0.85), not at the old 0.5 trigger.
 *
 * Diagnosed from session mqhs5ckvp75gz7t7 turn 15: a full pass fired while the
 * real billed prompt was only ~27% of a 1M window, breaking the prefix cache
 * and rebuilding ~240K tokens (≈0.71元 at the 3元/M miss rate, ~27% of the
 * session's total spend). The estTokens gate counts echoed reasoning_content,
 * so it runs well ahead of the billed prompt — 0.5 fired far too early.
 */

const CONTEXT_WINDOW = 1_000_000
const CHARS_PER_TOKEN = 4

function makeEngine(): PromptEngine {
  return new PromptEngine({
    model: 'test-model',
    maxTokens: 4096,
    staticCtx: { tools: [] },
    volatileCtx: { cwd: '/test/project', gitStatus: 'Current branch: main', rivetMd: '# Test' },
    // collapseAge 8 (default) → boundary trails the head by 8 user turns.
  })
}

/** A collapsible grep tool result (>200 chars, real grep shape). */
function bigGrepResult(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `src/module/file${i}.ts:${i + 10}: const match${i} = compute(${i})`).join('\n')
}

/**
 * Build a message array whose estimated tokens land at a target fill ratio.
 * estTokens = (Σ content chars + reasoning chars) / 4. We pad a recent user
 * message with filler so the OLD tool result (turn 1) stays byte-identifiable.
 */
function buildMessages(targetFillRatio: number, oldToolContent: string): OaiMessage[] {
  const msgs: OaiMessage[] = [
    { role: 'user', content: 'turn 1: explore the codebase' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'grep_c1', type: 'function', function: { name: 'grep', arguments: JSON.stringify({ pattern: 'compute' }) } }] },
    { role: 'tool', tool_call_id: 'grep_c1', content: oldToolContent },
  ]
  // 8 more user turns so turn 1's age >= collapseAge(8) → boundary > 0.
  for (let t = 2; t <= 10; t++) {
    msgs.push({ role: 'user', content: `turn ${t}` })
    msgs.push({ role: 'assistant', content: `reply ${t}` })
  }

  const baseChars = msgs.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0)
  const targetChars = targetFillRatio * CONTEXT_WINDOW * CHARS_PER_TOKEN
  const fillerChars = Math.max(0, Math.ceil(targetChars - baseChars))
  // Filler rides on the latest user message (recent → never collapsed itself).
  msgs.push({ role: 'user', content: `latest. ${'x'.repeat(fillerChars)}` })
  return msgs
}

describe('T7 full-collapse fill-ratio threshold (option A)', () => {
  it('does NOT semantically collapse old tool results at 60% fill (between old 0.5 and new 0.85)', () => {
    const engine = makeEngine()
    const oldTool = bigGrepResult(40)
    const messages = buildMessages(0.6, oldTool)

    const req = engine.buildOaiRequest(messages, undefined, CONTEXT_WINDOW)

    // Locate the old tool result (turn 1) in the built request.
    const toolMsg = req.messages.find(m => m.role === 'tool' && m.tool_call_id === 'grep_c1')
    assert.ok(toolMsg, 'old tool result must still be present')
    const content = toolMsg!.content as string
    // At 0.6 fill the lightweight pass runs but the FULL semantic collapse must
    // not — the old grep result keeps its original bytes (no [collapsed grep:]).
    assert.equal(content, oldTool, 'old tool result must stay byte-identical below 0.85 fill')
    assert.ok(!content.startsWith('[collapsed '), 'must not be semantically collapsed below 0.85')
  })

  it('DOES semantically collapse old tool results at 90% fill (above new 0.85)', () => {
    const engine = makeEngine()
    const oldTool = bigGrepResult(40)
    const messages = buildMessages(0.9, oldTool)

    const req = engine.buildOaiRequest(messages, undefined, CONTEXT_WINDOW)

    const toolMsg = req.messages.find(m => m.role === 'tool' && m.tool_call_id === 'grep_c1')
    assert.ok(toolMsg, 'old tool result must still be present')
    const content = toolMsg!.content as string
    assert.ok(content.length < oldTool.length, 'old tool result must shrink above 0.85 fill')
    assert.ok(content.startsWith('[collapsed grep:'), 'must be semantically collapsed above 0.85')
  })
})

/**
 * Build messages where an OLD assistant message (turn 1, age >= collapseAge)
 * carries reasoning_content. The lightweight collapse pass strips reasoning
 * below the watermark — that strip is a history rewrite that breaks exact-prefix.
 * Below COLLAPSE_FLOOR_FILL_RATIO the whole T7 block must not run, so the old
 * reasoning survives byte-identical (no rewrite, no cache break).
 */
function buildMessagesWithOldReasoning(targetFillRatio: number, reasoning: string): OaiMessage[] {
  const msgs: OaiMessage[] = [
    { role: 'user', content: 'turn 1: explore' },
    { role: 'assistant', content: 'looked', reasoning_content: reasoning, tool_calls: [{ id: 'grep_c1', type: 'function', function: { name: 'grep', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'grep_c1', content: 'x'.repeat(400) },
  ]
  for (let t = 2; t <= 10; t++) {
    msgs.push({ role: 'user', content: `turn ${t}` })
    msgs.push({ role: 'assistant', content: `reply ${t}` })
  }
  const baseChars = msgs.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0) + reasoning.length
  const fillerChars = Math.max(0, Math.ceil(targetFillRatio * CONTEXT_WINDOW * CHARS_PER_TOKEN - baseChars))
  msgs.push({ role: 'user', content: `latest. ${'x'.repeat(fillerChars)}` })
  return msgs
}

describe('T7 collapse FLOOR — no rewrite below COLLAPSE_FLOOR_FILL_RATIO', () => {
  const OLD_REASONING = 'OLD_REASONING_MARKER ' + 'deliberation '.repeat(50)

  it('does NOT strip old reasoning at 30% fill (below floor) — prefix stays cacheable', () => {
    const engine = makeEngine()
    const messages = buildMessagesWithOldReasoning(0.3, OLD_REASONING)
    const req = engine.buildOaiRequest(messages, undefined, CONTEXT_WINDOW)
    const oldAsst = req.messages.find(m => m.role === 'assistant' && typeof (m as { reasoning_content?: string }).reasoning_content === 'string' && (m as { reasoning_content?: string }).reasoning_content!.includes('OLD_REASONING_MARKER'))
    assert.ok(oldAsst, 'old reasoning must survive below floor — no history rewrite, no cache break')
  })

  it('DOES strip old reasoning at 60% fill (above floor) — lightweight pass runs', () => {
    const engine = makeEngine()
    const messages = buildMessagesWithOldReasoning(0.6, OLD_REASONING)
    const req = engine.buildOaiRequest(messages, undefined, CONTEXT_WINDOW)
    const stillHasMarker = req.messages.some(m => typeof (m as { reasoning_content?: string }).reasoning_content === 'string' && (m as { reasoning_content?: string }).reasoning_content!.includes('OLD_REASONING_MARKER'))
    assert.equal(stillHasMarker, false, 'old reasoning must be stripped above floor (lightweight pass active)')
  })
})
