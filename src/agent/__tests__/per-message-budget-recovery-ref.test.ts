import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  enforcePerMessageBudget,
  enforceTurnReadBudget,
  enforceContextPressureTruncation,
  enforceToolTypeBudgets,
  type BudgetEntry,
} from '../per-message-budget.js'

// W0/W1-A2 RED baseline → GREEN gate: every lossy budget transform must
// preserve a trailing `[artifact:ID]` recovery marker. The marker contract
// (marker is the LAST token of the content) is defined in
// src/compact/stale-round.ts:4-10; stale-round already honors it — these are
// the remaining budget-layer paths.

const MARKER = '[artifact:abc_123]'

function entryWithMarker(toolName: string, bodyLines: number, lineWidth = 200): BudgetEntry {
  const body = Array.from({ length: bodyLines }, (_, i) => `line ${i} ${'x'.repeat(lineWidth)}`).join('\n')
  return {
    toolUseId: `${toolName}_test_1`,
    toolName,
    content: `${body}\n${MARKER}`,
  }
}

function lastToken(content: string): string {
  return content.trimEnd().split(/\s+/).at(-1) ?? ''
}

describe('budget truncation preserves trailing [artifact:ID] recovery marker', () => {
  it('path 1: enforcePerMessageBudget eviction keeps the marker in the replacement', () => {
    const big = entryWithMarker('bash', 3000, 400) // ~1.2MB, forces eviction
    const small: BudgetEntry = { toolUseId: 'grep_1', toolName: 'grep', content: 'small result' }
    const out = enforcePerMessageBudget([big, small], 100_000)
    const evicted = out[0]!
    assert.ok(evicted.content.length < big.content.length, 'entry must actually be evicted')
    assert.ok(
      evicted.content.includes(MARKER),
      `evicted replacement must carry the recovery marker; got: ${evicted.content.slice(0, 200)}`,
    )
    assert.equal(lastToken(evicted.content), MARKER, 'marker must remain the last token')
  })

  it('path 2: enforceTurnReadBudget summary keeps the marker', () => {
    const first = entryWithMarker('read_file', 4000, 400)
    const second = entryWithMarker('read_file', 4000, 400)
    // 64K window → budget = 64000 * 0.15 * 4 ≈ 38.4K chars; both entries exceed it.
    const out = enforceTurnReadBudget([first, second], 64_000)
    const truncated = out.filter(r => r.content.length < first.content.length)
    assert.ok(truncated.length > 0, 'at least one entry must be truncated')
    for (const t of truncated) {
      assert.ok(t.content.includes(MARKER), 'turn-read-budget summary must keep the marker')
      assert.equal(lastToken(t.content), MARKER, 'marker must remain the last token')
    }
  })

  it('path 3: enforceContextPressureTruncation head-only preview keeps the marker', () => {
    const entry = entryWithMarker('read_file', 200, 100)
    const out = enforceContextPressureTruncation([entry], 0.9)
    const t = out[0]!
    assert.ok(t.content.length < entry.content.length, 'entry must be truncated under pressure')
    assert.ok(
      t.content.includes(MARKER),
      'context-pressure truncation must keep the recovery marker (head-only preview drops it today)',
    )
    assert.equal(lastToken(t.content), MARKER, 'marker must remain the last token')
  })

  it('path 4a: enforceToolTypeBudgets per-call hard slice keeps the marker', () => {
    // Few very long lines → head+tail branch cannot fit → hard slice branch.
    const longLines = Array.from({ length: 25 }, () => 'q'.repeat(20_000)).join('\n')
    const entry: BudgetEntry = { toolUseId: 'bash_1', toolName: 'bash', content: `${longLines}\n${MARKER}` }
    const out = enforceToolTypeBudgets([entry], 64_000)
    const t = out[0]!
    assert.ok(t.content.length < entry.content.length, 'per-call budget must truncate')
    assert.ok(t.content.includes(MARKER), 'per-call hard slice must keep the recovery marker')
    assert.equal(lastToken(t.content), MARKER, 'marker must remain the last token')
  })

  it('path 4b: enforceToolTypeBudgets cumulative summary keeps the marker', () => {
    // Multiple mid-size results of the same tool to cross summarizeAfter.
    const entries = Array.from({ length: 12 }, (_, i) => {
      const e = entryWithMarker('bash', 400, 200)
      return { ...e, toolUseId: `bash_${i}` }
    })
    const out = enforceToolTypeBudgets(entries, 64_000)
    const summarized = out.filter(r => r.content.includes('[budget-summarized:'))
    assert.ok(summarized.length > 0, 'cumulative budget must summarize at least one entry')
    for (const s of summarized) {
      assert.ok(s.content.includes(MARKER), 'cumulative summary must keep the recovery marker')
      assert.equal(lastToken(s.content), MARKER, 'marker must remain the last token')
    }
  })

  it('no marker: transforms leave replacement untouched (no spurious marker invented)', () => {
    const entry: BudgetEntry = {
      toolUseId: 'read_file_1',
      toolName: 'read_file',
      content: Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(100)}`).join('\n'),
    }
    const out = enforceContextPressureTruncation([entry], 0.9)
    assert.ok(!out[0]!.content.includes('[artifact:'), 'must not invent a marker where none existed')
  })

  it('marker already in replacement is not duplicated', () => {
    const big = entryWithMarker('bash', 3000, 400)
    const out = enforcePerMessageBudget([big], 1_000)
    const count = out[0]!.content.split(MARKER).length - 1
    assert.equal(count, 1, 'marker must appear exactly once')
  })
})
