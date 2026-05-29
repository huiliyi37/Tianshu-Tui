import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatDuration, formatThinkingSize, thinkingStatusLabel } from '../thinking.js'
import { countPhysicalLines } from '../thinking-message.js'

describe('thinking helpers', () => {
  it('formats elapsed thinking duration', () => {
    assert.equal(formatDuration(0), '0s')
    assert.equal(formatDuration(59_000), '59s')
    assert.equal(formatDuration(61_000), '1m 1s')
  })

  it('formats thinking size', () => {
    assert.equal(formatThinkingSize(999), '999 chars')
    assert.equal(formatThinkingSize(1500), '1.5k')
  })
})

describe('thinking status label', () => {
  it('shows plain duration under 30s', () => {
    assert.equal(thinkingStatusLabel({ isStreaming: true, elapsedMs: 12_000 }), '12s')
  })

  it('shows Collecting context at 30s+', () => {
    assert.equal(thinkingStatusLabel({ isStreaming: true, elapsedMs: 42_000 }), 'Collecting context... 42s')
  })

  it('shows Still thinking at 90s+', () => {
    assert.equal(thinkingStatusLabel({ isStreaming: true, elapsedMs: 95_000 }), 'Still thinking... 1m 35s')
  })

  it('shows Long think at 180s+', () => {
    assert.equal(thinkingStatusLabel({ isStreaming: true, elapsedMs: 190_000 }), 'Long think — Ctrl+C to stop (3m)')
  })

  it('shows final thinking duration after completion', () => {
    assert.equal(
      thinkingStatusLabel({ isStreaming: false, elapsedMs: 0, completedDurationMs: 128_000 }),
      'completed in 2m 8s',
    )
  })

  it('falls back to completed when no final duration is available', () => {
    assert.equal(thinkingStatusLabel({ isStreaming: false, elapsedMs: 0 }), 'completed')
  })
})

describe('countPhysicalLines', () => {
  it('counts empty string as 0', () => {
    assert.equal(countPhysicalLines('', 80), 0)
  })

  it('counts single line within columns as 1', () => {
    assert.equal(countPhysicalLines('hello', 80), 1)
  })

  it('counts empty line as 1 physical line', () => {
    assert.equal(countPhysicalLines('\n', 80), 2) // two logical lines: empty + empty
  })

  it('counts CJK characters as double width', () => {
    // 5 CJK chars = 10 cells, fits in 80 columns -> 1 physical line
    assert.equal(countPhysicalLines('你好世界啊', 80), 1)
    // 40 CJK chars = 80 cells, exactly fits -> 1 physical line
    assert.equal(countPhysicalLines('你'.repeat(40), 80), 1)
    // 41 CJK chars = 82 cells, needs 2 physical lines
    assert.equal(countPhysicalLines('你'.repeat(41), 80), 2)
  })

  it('handles mixed CJK and ASCII', () => {
    // '你' (2 cells) + 'hi' (2 cells) = 4 cells
    assert.equal(countPhysicalLines('你hi', 80), 1)
  })

  it('handles line wrapping', () => {
    // 200 chars in one line, 80 columns -> ceil(200/80) = 3 physical lines
    assert.equal(countPhysicalLines('a'.repeat(200), 80), 3)
  })

  it('handles multiple lines', () => {
    const text = 'line1\nline2\nline3'
    assert.equal(countPhysicalLines(text, 80), 3)
  })

  it('handles multiple lines with wrapping', () => {
    const text = 'a'.repeat(200) + '\n' + 'b'.repeat(100)
    // first line: 200/80 = 2.5 -> 3 physical lines
    // second line: 100/80 = 1.25 -> 2 physical lines
    assert.equal(countPhysicalLines(text, 80), 5)
  })
})
