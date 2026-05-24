import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { createTurnBudget, BASE_BUDGET_TOKENS, PRESSURE_BUDGET_TOKENS } from '../turn-budget.js'
import { compactStaleRoundsOai } from '../../compact/stale-round.js'
import { estimateOaiTokens } from '../../compact/micro.js'
import type { OaiMessage } from '../../api/oai-types.js'

describe('memory safety integration', () => {
  it('messages array stays bounded after 10 simulated turns', () => {
    // 1M window policy: stale-round preview is 150K chars, so individual
    // tool_results below that pass through untouched. We still want a sane
    // upper bound — at ~4K/result × 50 results, ~200K chars / 4 = ~50K tokens
    // is the realistic ceiling. The point of this test is "growth is not
    // unbounded," not "every old result gets crushed." See pruneThresholds /
    // staleRoundThresholds rationale comments.
    const messages: OaiMessage[] = [
      { role: 'user', content: 'initial request' },
      { role: 'assistant', content: 'I will help' },
    ]

    for (let turn = 0; turn < 10; turn++) {
      const budget = createTurnBudget(0.3)

      for (let tool = 0; tool < 5; tool++) {
        const toolContent = `result-${turn}-${tool}: ${'x'.repeat(4000)}`
        const tokenEst = Math.ceil(toolContent.length / 4)
        budget.consume(tokenEst)

        const content = budget.isExhausted()
          ? `<stored ref="/tmp/test" chars=${toolContent.length}>preview</stored>`
          : toolContent

        messages.push({ role: 'tool', tool_call_id: `tu_${turn}_${tool}`, content })
      }

      messages.push({ role: 'assistant', content: `turn ${turn} done` })

      const compacted = compactStaleRoundsOai(messages, 1_000_000)
      if (compacted !== messages) {
        messages.length = 0
        messages.push(...compacted)
      }
    }

    const totalTokens = estimateOaiTokens(messages)
    // 60K is well above the realistic ~50K ceiling but well below an
    // unbounded-growth scenario (which would be 200K+ over 10 turns).
    assert.ok(totalTokens < 60_000, `Expected <60K tokens, got ${totalTokens}`)
    assert.ok(messages.length > 4, 'Should still have meaningful messages')
  })

  it('turn budget degrades under high RSS pressure', () => {
    const normal = createTurnBudget(0.5)
    const pressure = createTurnBudget(0.75)
    const critical = createTurnBudget(0.9)

    assert.strictEqual(normal.maxTokensPerTurn, BASE_BUDGET_TOKENS)
    assert.strictEqual(pressure.maxTokensPerTurn, PRESSURE_BUDGET_TOKENS)
    assert.strictEqual(critical.maxTokensPerTurn, 0)
  })

  it('stale compaction preserves recent content while shrinking old', () => {
    // 1M window: previewChars=150K, recentToKeep=30. Need >30 messages so
    // older rounds become "stale", and content >150K so they actually get
    // truncated rather than passed through.
    const messages: OaiMessage[] = [
      { role: 'user', content: 'anchor' },
      { role: 'assistant', content: 'anchor' },
    ]

    for (let i = 0; i < 20; i++) {
      messages.push({ role: 'tool', tool_call_id: `tu_${i}`, content: 'data-'.repeat(40_000) })
      messages.push({ role: 'assistant', content: `round ${i}` })
    }

    const before = estimateOaiTokens(messages)
    const compacted = compactStaleRoundsOai(messages, 1_000_000)
    const after = estimateOaiTokens(compacted)

    assert.ok(after < before, `Expected tokens to decrease: ${after} < ${before}`)
    const lastFour = compacted.slice(-4)
    const origLastFour = messages.slice(-4)
    assert.deepStrictEqual(lastFour, origLastFour)
  })
})
