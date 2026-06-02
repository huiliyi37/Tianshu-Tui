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

// Replicate word-jump helpers from base-text-input.tsx for testing.
function prevWordStart(text: string, pos: number): number {
  if (pos <= 0) return 0
  let i = pos - 1
  while (i > 0 && !/\w/.test(text[i] ?? '')) i--
  while (i > 0 && /\w/.test(text[i - 1] ?? '')) i--
  return i
}

function nextWordEnd(text: string, pos: number): number {
  if (pos >= text.length) return pos
  let i = pos
  while (i < text.length && !/\w/.test(text[i] ?? '')) i++
  if (i >= text.length) return pos
  while (i < text.length && /\w/.test(text[i] ?? '')) i++
  return i
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

describe('prevWordStart', () => {
  it('returns 0 at start', () => {
    assert.equal(prevWordStart('hello', 0), 0)
  })
  it('jumps to start of current word', () => {
    // cursor at 5 ('world'|'Xtra'), jumps to start of 'Xtra'
    assert.equal(prevWordStart('hello worldXtra', 11), 6)
  })
  it('jumps to start of previous word from start of current word', () => {
    // "ab |cd" — pos=3 (at 'c'), walks back to start of 'ab' (pos 0)
    assert.equal(prevWordStart('ab cd', 3), 0)
  })
  it('handles punctuation correctly', () => {
    // "hello,| world" — pos=6, cursor at ' ' after 'hello,'
    // prevWordStart skips non-word (',') and walks back to start of 'hello' (0)
    assert.equal(prevWordStart('hello, world', 6), 0)
  })
  it('returns 0 when only whitespace to the left', () => {
    assert.equal(prevWordStart('   ', 2), 0)
  })
  it('handles multi-line buffers across newlines', () => {
    // "foo\n|" — pos=4, should jump to start of 'foo' (pos 0)
    assert.equal(prevWordStart('foo\nbar', 4), 0)
  })
})

describe('nextWordEnd', () => {
  it('returns length at end', () => {
    assert.equal(nextWordEnd('hello', 5), 5)
  })
  it('jumps to end of current word', () => {
    // "ab| cd" — pos=2, next word end is pos 5 (end of 'cd')
    assert.equal(nextWordEnd('ab cd', 2), 5)
  })
  it('skips leading whitespace', () => {
    // "ab |  cd" — pos=3, should jump past '  ' to start of 'cd' (pos 5), end at 7
    assert.equal(nextWordEnd('ab   cd', 3), 7)
  })
  it('returns pos when no word follows', () => {
    // "ab|," — pos=2, no word after, returns 2
    assert.equal(nextWordEnd('ab,', 2), 2)
  })
  it('handles multi-line buffers across newlines', () => {
    // "|\nbar" — pos=0, next word 'bar', end at 4
    assert.equal(nextWordEnd('\nbar', 0), 4)
  })
})

describe('Stale-closure fix: ref-based edit accumulation', () => {
  // Simulate the commitEdit pattern: when N keystrokes arrive faster than
  // React renders, each must be applied to the latest ref-stored value, not
  // a closure-captured snapshot. This test mirrors the exact logic in
  // base-text-input.tsx (useRef + read fresh + write back).
  it('preserves all N burst-inserted chars', () => {
    const ref = { value: '', cursor: 0 }
    const commit = (nv: string, nc: number) => {
      ref.value = nv
      ref.cursor = nc
    }
    // Simulate 5 keystrokes arriving between renders
    const keys = ['a', 'b', 'c', 'd', 'e']
    for (const k of keys) {
      const v = ref.value
      const p = ref.cursor
      commit(v.slice(0, p) + k + v.slice(p), p + 1)
    }
    assert.equal(ref.value, 'abcde')
    assert.equal(ref.cursor, 5)
  })

  it('interleaves insert, delete, and word-jump without dropping chars', () => {
    const ref = { value: 'hello world', cursor: 11 }
    const commit = (nv: string, nc: number) => {
      ref.value = nv
      ref.cursor = nc
    }
    // insert '!' at end
    commit(ref.value.slice(0, ref.cursor) + '!' + ref.value.slice(ref.cursor), ref.cursor + 1)
    // delete one char backward
    commit(ref.value.slice(0, ref.cursor - 1) + ref.value.slice(ref.cursor), ref.cursor - 1)
    // word jump back, then insert 'X' at new position
    ref.cursor = prevWordStart(ref.value, ref.cursor)
    commit(ref.value.slice(0, ref.cursor) + 'X' + ref.value.slice(ref.cursor), ref.cursor + 1)
    assert.equal(ref.value, 'hello Xworld')
  })
})
