import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createCompactionAmnesiaHook, summarizeAmnesiaRows, type AmnesiaShadowRow } from '../compaction-amnesia-hook.js'
import type { RuntimeHookContext, RuntimeToolEvent } from '../../runtime-hooks.js'

// W3-C1: shadow-only amnesia ledger. The hook records unchanged-hash full
// re-reads within the post-compact window and never touches the prompt.

function ctx(turn: number): RuntimeHookContext {
  return { snapshot: { turn } } as unknown as RuntimeHookContext
}

function readEvent(target: string, content: string, input: Record<string, unknown> = {}): RuntimeToolEvent {
  return { name: 'read_file', success: true, target, resultContent: content, input }
}

function makeHarness() {
  const compactEvents: Array<{ turn: number }> = []
  const rows: AmnesiaShadowRow[] = []
  const hook = createCompactionAmnesiaHook({
    getCompactEvents: () => compactEvents,
    record: r => rows.push(r),
  })
  return { hook, compactEvents, rows }
}

describe('compaction-amnesia shadow hook', () => {
  it('records an unchanged-hash full re-read shortly after a compact', () => {
    const { hook, compactEvents, rows } = makeHarness()

    hook.run(ctx(1), readEvent('src/a.ts', 'stable content'))
    compactEvents.push({ turn: 3 })
    hook.run(ctx(4), readEvent('src/a.ts', 'stable content'))

    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.kind, 'full-reread')
    assert.equal(rows[0]!.target, 'src/a.ts')
    assert.equal(rows[0]!.turnsSinceCompact, 1)
    assert.equal(rows[0]!.exclusion, undefined)
  })

  it('does not record when the content hash changed (legitimate re-read)', () => {
    const { hook, compactEvents, rows } = makeHarness()
    hook.run(ctx(1), readEvent('src/a.ts', 'v1 content'))
    compactEvents.push({ turn: 2 })
    hook.run(ctx(3), readEvent('src/a.ts', 'v2 content — edited meanwhile'))
    assert.equal(rows.length, 0)
  })

  it('marks the row excluded when the prior observation was lossy', () => {
    const { hook, compactEvents, rows } = makeHarness()
    const lossyBody = '<microcompacted tool_result original_chars="90000">\npreview\n</microcompacted tool_result>'
    hook.run(ctx(1), readEvent('src/big.ts', lossyBody))
    compactEvents.push({ turn: 2 })
    hook.run(ctx(3), readEvent('src/big.ts', lossyBody))
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.exclusion, 'prior-lossy')
  })

  it('ignores narrowed reads (offset/limit) and reads outside the window', () => {
    const { hook, compactEvents, rows } = makeHarness()
    hook.run(ctx(1), readEvent('src/a.ts', 'stable'))
    compactEvents.push({ turn: 2 })
    // Narrowed read: not a full re-read.
    hook.run(ctx(3), readEvent('src/a.ts', 'stable', { offset: 10, limit: 50 }))
    // Outside the 10-turn window.
    hook.run(ctx(20), readEvent('src/a.ts', 'stable'))
    assert.equal(rows.length, 0)
  })

  it('records nothing before any compact has happened', () => {
    const { hook, rows } = makeHarness()
    hook.run(ctx(1), readEvent('src/a.ts', 'stable'))
    hook.run(ctx(2), readEvent('src/a.ts', 'stable'))
    assert.equal(rows.length, 0)
  })

  it('summarizeAmnesiaRows separates strong signals from exclusions', () => {
    const rows: AmnesiaShadowRow[] = [
      { event: 'amnesia_shadow', kind: 'full-reread', generation: 1, turn: 4, turnsSinceCompact: 1, target: 'a.ts', contentHash: 'h1' },
      { event: 'amnesia_shadow', kind: 'full-reread', generation: 1, turn: 5, turnsSinceCompact: 2, target: 'a.ts', contentHash: 'h1' },
      { event: 'amnesia_shadow', kind: 'full-reread', generation: 1, turn: 6, turnsSinceCompact: 3, target: 'b.ts', contentHash: 'h2', exclusion: 'prior-lossy' },
    ]
    const summary = summarizeAmnesiaRows(rows)
    assert.equal(summary.total, 3)
    assert.equal(summary.strongSignals, 2)
    assert.equal(summary.excluded, 1)
    assert.equal(summary.byTarget['a.ts'], 2)
  })
})
