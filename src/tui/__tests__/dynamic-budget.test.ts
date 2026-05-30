import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeBudget, CHROME_ROWS, MAX_CARD_LINES } from '../dynamic-budget.js'

/**
 * The fundamental invariant: streamLines + N × cardLines + CHROME_ROWS ≤ termRows.
 * This must hold for ALL terminal sizes × ALL live tool counts.
 * If it fails, Ink cursor-up overflows → screen flicker.
 */
describe('computeBudget invariant', () => {
  const termSizes = [20, 24, 30, 40, 50, 60, 80]
  const cardCounts = [0, 1, 2, 3, 5]

  for (const rows of termSizes) {
    for (const nCards of cardCounts) {
      it(`term=${rows} cards=${nCards}: stream + N×card + chrome ≤ termRows`, () => {
        const { streamLines, cardLines } = computeBudget(rows, nCards)
        const total = streamLines + nCards * cardLines + CHROME_ROWS
        assert.ok(
          total <= rows,
          `overflow: stream=${streamLines} + ${nCards}×card=${nCards * cardLines} + chrome=${CHROME_ROWS} = ${total} > ${rows}`,
        )
      })
    }
  }

  for (const rows of termSizes) {
    it(`term=${rows}: expanded + chrome ≤ termRows`, () => {
      const { expandedLines } = computeBudget(rows, 1)
      const total = expandedLines + CHROME_ROWS
      assert.ok(
        total <= rows,
        `expanded overflow: ${expandedLines} + ${CHROME_ROWS} = ${total} > ${rows}`,
      )
    })
  }

  // Expanded invariant with multiple cards:
  // 1(min stream) + expandedLines + (N-1)*cardLines + CHROME_ROWS ≤ termRows
  for (const rows of termSizes) {
    for (const nCards of [1, 2, 3, 5]) {
      it(`term=${rows} cards=${nCards}: 1 + expanded + (N-1)×card + chrome ≤ termRows`, () => {
        const { cardLines, expandedLines } = computeBudget(rows, nCards)
        const othersCollapsed = Math.max(0, nCards - 1) * cardLines
        const total = 1 + expandedLines + othersCollapsed + CHROME_ROWS
        assert.ok(
          total <= rows,
          `expanded+multi overflow: 1 + ${expandedLines} + ${Math.max(0, nCards - 1)}×${cardLines}(${othersCollapsed}) + ${CHROME_ROWS} = ${total} > ${rows}`,
        )
      })
    }
  }
})

describe('computeBudget sanity', () => {
  it('cardLines never exceeds MAX_CARD_LINES=15', () => {
    for (const rows of [40, 50, 60, 80, 100, 200]) {
      for (const nCards of [0, 1, 3]) {
        const { cardLines } = computeBudget(rows, nCards)
        assert.ok(cardLines <= MAX_CARD_LINES, `cardLines=${cardLines} > ${MAX_CARD_LINES} at rows=${rows}`)
      }
    }
  })

  it('streamLines ≥ 1 (minimum stream)', () => {
    for (const rows of [20, 24, 30]) {
      for (const nCards of [0, 1, 3, 5]) {
        const { streamLines } = computeBudget(rows, nCards)
        assert.ok(streamLines >= 1, `streamLines=${streamLines} < 1 at rows=${rows} cards=${nCards}`)
      }
    }
  })

  it('cardLines ≥ 1 (minimum card)', () => {
    for (const rows of [20, 24, 30]) {
      for (const nCards of [1, 3, 5]) {
        const { cardLines } = computeBudget(rows, nCards)
        assert.ok(cardLines >= 1, `cardLines=${cardLines} < 1 at rows=${rows} cards=${nCards}`)
      }
    }
  })

  it('0 cards: stream gets almost all available space', () => {
    const { streamLines, cardLines } = computeBudget(40, 0)
    assert.equal(streamLines, 34) // 40 - 6 chrome
    assert.equal(cardLines, 15)   // max cap, unused
  })

  it('3 cards on 40-row: equal division', () => {
    const { streamLines, cardLines } = computeBudget(40, 3)
    // available=34, slots=4, perSlot=8, cards=3×8=24, stream=34-24=10
    assert.equal(cardLines, 8)
    assert.equal(streamLines, 10)
  })

  it('expanded ≥ collapsed (expanded always shows more)', () => {
    for (const rows of [24, 40, 60]) {
      const { cardLines, expandedLines } = computeBudget(rows, 1)
      assert.ok(expandedLines >= cardLines, `expanded=${expandedLines} < collapsed=${cardLines} at rows=${rows}`)
    }
  })
})
