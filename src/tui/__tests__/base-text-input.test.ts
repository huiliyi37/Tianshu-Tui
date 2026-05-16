import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Replicate the helper functions from base-text-input.tsx for testing
function getLineCol(text: string, pos: number): { line: number; col: number } {
  let line = 0
  let col = 0
  for (let i = 0; i < pos && i < text.length; i++) {
    if (text[i] === '\n') {
      line++
      col = 0
    } else {
      col++
    }
  }
  return { line, col }
}

function posFromLineCol(lines: string[], line: number, col: number): number {
  let pos = 0
  for (let i = 0; i < line && i < lines.length; i++) {
    pos += (lines[i]?.length ?? 0) + 1
  }
  if (line < lines.length) {
    pos += Math.min(col, lines[line]!.length)
  }
  return pos
}

function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

describe('getLineCol', () => {
  it('returns line 0 col 0 for start of string', () => {
    assert.deepEqual(getLineCol('hello', 0), { line: 0, col: 0 })
  })

  it('tracks column within single line', () => {
    assert.deepEqual(getLineCol('hello', 3), { line: 0, col: 3 })
  })

  it('moves to next line on newline', () => {
    assert.deepEqual(getLineCol('hello\nworld', 6), { line: 1, col: 0 })
  })

  it('tracks column on second line', () => {
    assert.deepEqual(getLineCol('hello\nworld', 9), { line: 1, col: 3 })
  })

  it('handles multiple newlines', () => {
    assert.deepEqual(getLineCol('a\nb\nc', 4), { line: 2, col: 0 })
  })

  it('handles empty lines', () => {
    assert.deepEqual(getLineCol('hello\n\nworld', 7), { line: 2, col: 0 })
  })

  it('handles position at end of string', () => {
    assert.deepEqual(getLineCol('hello', 5), { line: 0, col: 5 })
  })
})

describe('posFromLineCol', () => {
  it('returns 0 for line 0 col 0', () => {
    assert.equal(posFromLineCol(['hello', 'world'], 0, 0), 0)
  })

  it('computes position on first line', () => {
    assert.equal(posFromLineCol(['hello', 'world'], 0, 3), 3)
  })

  it('computes position on second line', () => {
    // hello\nworld — \n at pos 5, so line 1 col 3 = 5 + 1 + 3 = 9
    assert.equal(posFromLineCol(['hello', 'world'], 1, 3), 9)
  })

  it('clamps col to line length', () => {
    assert.equal(posFromLineCol(['hi', 'world'], 0, 10), 2)
  })

  it('handles col 0 on second line', () => {
    // hello\nworld — pos 6
    assert.equal(posFromLineCol(['hello', 'world'], 1, 0), 6)
  })

  it('roundtrip: getLineCol then posFromLineCol', () => {
    const text = 'line1\nline2\nline3'
    const lines = text.split('\n')
    for (let pos = 0; pos <= text.length; pos++) {
      const { line, col } = getLineCol(text, pos)
      const restored = posFromLineCol(lines, line, col)
      assert.equal(restored, pos, `roundtrip failed at pos ${pos}`)
    }
  })
})

describe('normalizeLineEndings', () => {
  it('normalizes \\r\\n to \\n', () => {
    assert.equal(normalizeLineEndings('hello\r\nworld'), 'hello\nworld')
  })

  it('normalizes standalone \\r to \\n', () => {
    assert.equal(normalizeLineEndings('hello\rworld'), 'hello\nworld')
  })

  it('handles mixed line endings', () => {
    assert.equal(normalizeLineEndings('a\r\nb\rc\n'), 'a\nb\nc\n')
  })

  it('leaves \\n unchanged', () => {
    assert.equal(normalizeLineEndings('hello\nworld'), 'hello\nworld')
  })

  it('handles empty string', () => {
    assert.equal(normalizeLineEndings(''), '')
  })

  it('handles \\r\\n\\r\\n (double Windows newline)', () => {
    assert.equal(normalizeLineEndings('hello\r\n\r\nworld'), 'hello\n\nworld')
  })
})

describe('Multi-line navigation scenarios', () => {
  it('up arrow from line 1 goes to line 0', () => {
    const text = 'line1\nline2'
    const lines = text.split('\n')
    const pos = 8 // on 'line2', col 2
    const { line, col } = getLineCol(text, pos)
    assert.equal(line, 1)
    assert.equal(col, 2)
    const newPos = posFromLineCol(lines, line - 1, col)
    assert.equal(newPos, 2) // col 2 on 'line1'
  })

  it('up arrow clamps col when target line is shorter', () => {
    const text = 'ab\nlongline'
    const lines = text.split('\n')
    const pos = 9 // on 'longline', col 5
    const { line, col } = getLineCol(text, pos)
    assert.equal(line, 1)
    const newPos = posFromLineCol(lines, line - 1, col)
    assert.equal(newPos, 2) // clamped to end of 'ab'
  })

  it('down arrow from line 0 goes to line 1', () => {
    const text = 'line1\nline2'
    const lines = text.split('\n')
    const pos = 3 // col 3 on 'line1'
    const { line, col } = getLineCol(text, pos)
    assert.equal(line, 0)
    const newPos = posFromLineCol(lines, line + 1, col)
    assert.equal(newPos, 9) // col 3 on 'line2'
  })

  it('home key moves to start of current line', () => {
    const text = 'line1\nline2\nline3'
    const lines = text.split('\n')
    const pos = 9 // col 3 on 'line2'
    const { line } = getLineCol(text, pos)
    assert.equal(line, 1)
    const homePos = posFromLineCol(lines, line, 0)
    assert.equal(homePos, 6) // start of 'line2'
  })

  it('end key moves to end of current line', () => {
    const text = 'line1\nline2\nline3'
    const lines = text.split('\n')
    const pos = 7 // col 1 on 'line2'
    const { line } = getLineCol(text, pos)
    assert.equal(line, 1)
    const endPos = posFromLineCol(lines, line, lines[line]!.length)
    assert.equal(endPos, 11) // end of 'line2'
  })
})
