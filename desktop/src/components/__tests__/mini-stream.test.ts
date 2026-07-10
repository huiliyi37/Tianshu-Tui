import { test } from 'node:test'
import assert from 'node:assert/strict'
import { miniTail, miniLinesEqual } from '../MiniStream.tsx'
import type { ConvoBlock } from '../../state/event-reducer'

function block(key: string, kind: ConvoBlock['kind'], text: string, extra: Partial<ConvoBlock> = {}): ConvoBlock {
  return { key, kind, text, ...extra }
}

test('miniTail keeps only the last 4 glance-worthy blocks in order', () => {
  const blocks: ConvoBlock[] = [
    block('u1', 'user', 'question'),
    block('p1', 'phase', 'noise'),          // filtered out
    block('t1', 'tool', 'x', { role: 'tool · bash' }),
    block('r1', 'result', 'ok', { role: 'result · bash' }),
    block('a1', 'assistant', 'answer line one\nline two'),
    block('th1', 'thinking', 'hmm'),
  ]
  const lines = miniTail(blocks)
  assert.deepEqual(lines.map((l) => l.key), ['t1', 'r1', 'a1', 'th1'])
  assert.equal(lines[2]!.text, 'answer line one', 'only the first line is projected')
})

test('miniTail truncates a long first line to a stable 120-char prefix', () => {
  const long = 'x'.repeat(400)
  const [line] = miniTail([block('a1', 'assistant', long)])
  assert.ok(line!.text.length <= 120)
  assert.ok(line!.text.endsWith('…'))
})

test('streaming deltas beyond the visible first line produce EQUAL slices (no card re-render)', () => {
  // Same first line, growing body — the mission-card glance is unchanged, so
  // the selector's isEqual must return true and skip the re-render.
  const before = miniTail([block('a1', 'assistant', 'stable first line\npartial bo')])
  const after = miniTail([block('a1', 'assistant', 'stable first line\npartial body grew a lot more')])
  assert.ok(miniLinesEqual(before, after))
})

test('a change in the visible line or a new block breaks equality', () => {
  const a = miniTail([block('a1', 'assistant', 'first')])
  const b = miniTail([block('a1', 'assistant', 'first grew')])
  assert.ok(!miniLinesEqual(a, b), 'growing first line must re-render')

  const c = miniTail([block('a1', 'assistant', 'first'), block('t1', 'tool', '', { role: 'tool · bash' })])
  assert.ok(!miniLinesEqual(a, c), 'new block must re-render')

  const ok = miniTail([block('r1', 'result', 'done', { role: 'result · bash' })])
  const err = miniTail([block('r1', 'result', 'done', { role: 'result · bash', isError: true })])
  assert.ok(!miniLinesEqual(ok, err), 'error flip must re-render')
})
