import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { createTurnBudget, BASE_BUDGET_TOKENS, PRESSURE_BUDGET_TOKENS } from '../turn-budget.js'
import { compactStaleRounds } from '../../compact/stale-round.js'
import { estimateTokens } from '../../compact/micro.js'
import type { Message } from '../../api/types.js'

describe('memory safety integration', () => {
  it('messages array stays bounded after 10 simulated turns', () => {
    const messages: Message[] = [
      { role: 'user', content: 'initial request' },
      { role: 'assistant', content: [{ type: 'text', text: 'I will help' }] },
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

        messages.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: `tu_${turn}_${tool}`, content }],
        })
      }

      messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: `turn ${turn} done` }],
      })

      const compacted = compactStaleRounds(messages, 1_000_000)
      if (compacted !== messages) {
        messages.length = 0
        messages.push(...compacted)
      }
    }

    const totalTokens = estimateTokens(messages)
    assert.ok(totalTokens < 30_000, `Expected <30K tokens, got ${totalTokens}`)
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
    const messages: Message[] = [
      { role: 'user', content: 'anchor' },
      { role: 'assistant', content: [{ type: 'text', text: 'anchor' }] },
    ]

    for (let i = 0; i < 6; i++) {
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `tu_${i}`, content: 'data-'.repeat(1000) }],
      })
      messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: `round ${i}` }],
      })
    }

    const before = estimateTokens(messages)
    const compacted = compactStaleRounds(messages, 1_000_000)
    const after = estimateTokens(compacted)

    assert.ok(after < before, `Expected tokens to decrease: ${after} < ${before}`)
    const lastFour = compacted.slice(-4)
    const origLastFour = messages.slice(-4)
    assert.deepStrictEqual(lastFour, origLastFour)
  })
})
