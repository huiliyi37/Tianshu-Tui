import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitStableSegments, MIN_SEGMENT_CHARS, type StreamSegments } from '../stream-segments.ts'

/** A paragraph block big enough to satisfy MIN_SEGMENT_CHARS on its own. */
function bigPara(label: string): string {
  return `${label} ${'lorem ipsum dolor sit amet '.repeat(Math.ceil(MIN_SEGMENT_CHARS / 27))}`
}

function joinAll(s: StreamSegments): string {
  return s.stable.join('') + s.tail
}

test('empty and tiny inputs stay entirely in the tail', () => {
  assert.deepEqual(splitStableSegments(''), { stable: [], tail: '' })
  const s = splitStableSegments('hello **world**')
  assert.deepEqual(s, { stable: [], tail: 'hello **world**' })
})

test('cuts after a blank line once the segment exceeds the minimum size', () => {
  const a = bigPara('first')
  // Trailing \n: only COMPLETE lines participate in cut decisions.
  const text = `${a}\n\nsecond paragraph starts here\n`
  const s = splitStableSegments(text)
  assert.equal(s.stable.length, 1)
  assert.equal(s.stable[0], `${a}\n\n`)
  assert.equal(s.tail, 'second paragraph starts here\n')
  assert.equal(joinAll(s), text)
})

test('never cuts inside an unclosed fence, cuts after it closes', () => {
  const a = bigPara('intro')
  const fenceBody = `const x = 1\n\n// blank lines above/below are INSIDE the fence\n\n${'// padding line\n'.repeat(80)}`
  const open = `${a}\n\n\`\`\`ts\n${fenceBody}`
  const s1 = splitStableSegments(open)
  // The only candidate cut is before ```ts (blank line above it) — blank
  // lines inside the open fence are never cut points.
  assert.equal(s1.stable.length, 1)
  assert.equal(s1.stable[0], `${a}\n\n`)
  assert.ok(s1.tail.startsWith('```ts'))

  const closed = `${open}\`\`\`\n\nafter the block\n`
  const s2 = splitStableSegments(closed, s1)
  // Fence closed (body > MIN_SEGMENT_CHARS) + blank line -> cut before "after".
  assert.equal(s2.stable.length, 2)
  assert.ok(s2.stable[1]!.endsWith('```\n\n'))
  assert.equal(s2.tail, 'after the block\n')
  assert.equal(joinAll(s2), closed)
})

test('never cuts inside a $$ math block', () => {
  const a = bigPara('math intro')
  const mathBody = `\\sum_{k=1}^n k\n\n${'x_{i} + y_{i} \\\\\n'.repeat(80)}\nstill math`
  const text = `${a}\n\n$$\n${mathBody}\n$$\n\nprose after\n`
  const s = splitStableSegments(text)
  // Cut before the $$ opener and after the closed block — never between,
  // despite the blank lines inside the (oversized) math body.
  assert.equal(joinAll(s), text)
  for (const seg of s.stable) {
    const opens = (seg.match(/\$\$/g) ?? []).length
    assert.equal(opens % 2, 0, `segment must not split a $$ block: ${JSON.stringify(seg.slice(-40))}`)
  }
  assert.equal(s.tail, 'prose after\n')
})

test('does not cut between items of a loose list', () => {
  const a = bigPara('list intro')
  const text = `${a}\n\n- ${'item one '.repeat(150)}\n\n- item two\n\n- item three`
  const s = splitStableSegments(text)
  // The list items are separated by blank lines and item one alone exceeds
  // MIN_SEGMENT_CHARS — but a cut between "- one" and "- two" would split the
  // list into two <ul>s. Only the intro may freeze.
  assert.equal(s.stable.length, 1)
  assert.equal(s.stable[0], `${a}\n\n`)
  assert.ok(s.tail.startsWith('- '))
})

test('does not cut before an indented continuation line', () => {
  const a = bigPara('para')
  const text = `${a}\n\n    indented code line\nmore`
  const s = splitStableSegments(text)
  assert.equal(s.stable.length, 0)
  assert.equal(s.tail, text)
})

test('cut decision ignores the partial last line', () => {
  const a = bigPara('x')
  // Last line has no trailing newline — it may still grow into e.g. an
  // indented line, so no cut may be placed before it.
  const text = `${a}\n\npartial`
  const s = splitStableSegments(text)
  assert.equal(s.stable.length, 0)
  const s2 = splitStableSegments(`${text} grew\nnext line\n`, s)
  assert.equal(s2.stable.length, 1)
  assert.equal(s2.stable[0], `${a}\n\n`)
})

test('segments below the minimum size are not frozen', () => {
  const text = 'short one\n\nshort two\n\nshort three'
  const s = splitStableSegments(text)
  assert.equal(s.stable.length, 0)
  assert.equal(s.tail, text)
})

test('incremental calls with append-only input return === segment references', () => {
  const a = bigPara('ref-a')
  const b = bigPara('ref-b')
  const c = bigPara('ref-c')
  const full = `${a}\n\n${b}\n\n${c}\n\ntail bit\n`

  // Stream in uneven chunks, threading prev through every call.
  let prev: StreamSegments | undefined
  const seen: string[][] = []
  for (let len = 0; len <= full.length; len += 137) {
    prev = splitStableSegments(full.slice(0, Math.min(len, full.length)), prev)
    seen.push([...prev.stable])
  }
  prev = splitStableSegments(full, prev)

  // Frozen-prefix invariant: every earlier snapshot's segments are the SAME
  // references (===) as the final result's corresponding segments.
  for (const snapshot of seen) {
    snapshot.forEach((seg, i) => {
      assert.ok(Object.is(seg, prev!.stable[i]), `segment ${i} must be reference-stable`)
    })
  }
  assert.equal(joinAll(prev), full)
  assert.equal(prev.stable.length, 3)
})

test('unchanged input returns the previous result object (no re-render churn)', () => {
  const a = bigPara('same')
  const text = `${a}\n\ntail`
  const s1 = splitStableSegments(text)
  const s2 = splitStableSegments(text, s1)
  assert.ok(Object.is(s1, s2))
})

test('non-append input (regenerate) resets cleanly instead of corrupting', () => {
  const a = bigPara('old')
  const s1 = splitStableSegments(`${a}\n\ntail one\n`)
  assert.equal(s1.stable.length, 1)
  const b = bigPara('new-content')
  const s2 = splitStableSegments(`${b}\n\nfresh tail\n`, s1)
  assert.equal(joinAll(s2), `${b}\n\nfresh tail\n`)
  assert.equal(s2.stable[0], `${b}\n\n`)
})

test('multiple blank lines collapse into one cut point', () => {
  const a = bigPara('multi')
  const text = `${a}\n\n\n\nnext\n`
  const s = splitStableSegments(text)
  assert.equal(s.stable.length, 1)
  assert.equal(s.stable[0], `${a}\n\n\n\n`)
  assert.equal(s.tail, 'next\n')
})

test('tables are not split (blank line ends the table before any cut)', () => {
  const a = bigPara('table intro')
  const table = '| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |'
  const text = `${a}\n\n${table}\n\nafter table`
  const s = splitStableSegments(text)
  assert.equal(joinAll(s), text)
  // The table rows all land in one segment (or the tail) — never split mid-table.
  const holder = [...s.stable, s.tail].find((part) => part.includes('| a | b |'))
  assert.ok(holder)
  assert.ok(holder.includes('| 3 | 4 |'))
})
