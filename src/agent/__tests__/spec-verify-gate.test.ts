import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectSpecToExecuteJump } from '../hooks/spec-verify-gate.js'

type HistoryEntry = { tool: string; target: string }

function h(tool: string, target: string): HistoryEntry {
  return { tool, target }
}

describe('detectSpecToExecuteJump', () => {
  // ── Trigger scenarios ──

  it('triggers: spec → source read → no verification', () => {
    const history: HistoryEntry[] = [
      h('read_file', 'docs/handoff-goal-interrupt-issue.md'),
      h('read_file', 'src/agent/loop.ts'),
      h('read_file', 'src/agent/goal.ts'),
      h('read_file', 'src/agent/session.ts'),
    ]
    const result = detectSpecToExecuteJump({ recentToolHistory: history })
    assert.equal(result.triggered, true)
    assert.equal(result.specDocPath, 'docs/handoff-goal-interrupt-issue.md')
    assert.deepStrictEqual(result.missingVerifications, ['run_tests', 'test_file_read', 'log_data_read'])
  })

  it('triggers: spec → grep src/ → no verification', () => {
    const history: HistoryEntry[] = [
      h('read_file', 'docs/some-issue-report.md'),
      h('grep', 'src/agent/'),
      h('read_file', 'src/agent/loop.ts'),
    ]
    const result = detectSpecToExecuteJump({ recentToolHistory: history })
    assert.equal(result.triggered, true)
    assert.equal(result.specDocPath, 'docs/some-issue-report.md')
  })

  it('triggers: spec → source read → edit (still no verify)', () => {
    const history: HistoryEntry[] = [
      h('read_file', 'docs/handoff-foo.md'),
      h('read_file', 'src/agent/loop.ts'),
      h('edit_file', 'src/agent/loop.ts'),
    ]
    const result = detectSpecToExecuteJump({ recentToolHistory: history })
    assert.equal(result.triggered, true)
  })

  it('triggers with custom specGlobs', () => {
    const history: HistoryEntry[] = [
      h('read_file', 'docs/REPRO.md'),
      h('read_file', 'src/main.tsx'),
    ]
    const result = detectSpecToExecuteJump({
      recentToolHistory: history,
      specGlobs: ['docs/REPRO*'],
    })
    assert.equal(result.triggered, true)
    assert.equal(result.specDocPath, 'docs/REPRO.md')
  })

  // ── Suppression scenarios: run_tests ──

  it('suppresses: spec → run_tests → edit', () => {
    const history: HistoryEntry[] = [
      h('read_file', 'docs/handoff-foo.md'),
      h('read_file', 'src/agent/loop.ts'),
      h('run_tests', ''),
    ]
    const result = detectSpecToExecuteJump({ recentToolHistory: history })
    assert.equal(result.triggered, false)
  })

  it('suppresses: deliver_task counts as verify', () => {
    const history: HistoryEntry[] = [
      h('read_file', 'docs/handoff-foo.md'),
      h('read_file', 'src/agent/loop.ts'),
      h('deliver_task', ''),
    ]
    const result = detectSpecToExecuteJump({ recentToolHistory: history })
    assert.equal(result.triggered, false)
  })

  it('suppresses: verifying bash (npm test)', () => {
    const history: HistoryEntry[] = [
      h('read_file', 'docs/handoff-foo.md'),
      h('read_file', 'src/agent/loop.ts'),
      h('bash', 'npx tsc --noEmit && npm test'),
    ]
    const result = detectSpecToExecuteJump({ recentToolHistory: history })
    assert.equal(result.triggered, false)
  })

  // ── Suppression scenarios: test file read ──

  it('suppresses: spec → read test file → edit', () => {
    const history: HistoryEntry[] = [
      h('read_file', 'docs/handoff-foo.md'),
      h('read_file', 'src/agent/__tests__/loop.test.ts'),
      h('edit_file', 'src/agent/loop.ts'),
    ]
    const result = detectSpecToExecuteJump({ recentToolHistory: history })
    assert.equal(result.triggered, false)
  })

  // ── Suppression scenarios: log data read ──

  it('suppresses: spec → read session JSONL → edit', () => {
    const history: HistoryEntry[] = [
      h('read_file', 'docs/handoff-foo.md'),
      h('read_file', '.rivet/sessions/abc123.jsonl'),
      h('edit_file', 'src/agent/loop.ts'),
    ]
    const result = detectSpecToExecuteJump({ recentToolHistory: history })
    assert.equal(result.triggered, false)
  })

  it('suppresses: spec → bash cat session JSONL → edit', () => {
    const history: HistoryEntry[] = [
      h('read_file', 'docs/handoff-foo.md'),
      h('bash', 'cat .rivet/sessions/abc123.jsonl | head -20'),
      h('edit_file', 'src/agent/loop.ts'),
    ]
    const result = detectSpecToExecuteJump({ recentToolHistory: history })
    assert.equal(result.triggered, false)
  })

  // ── No spec document ──

  it('no trigger: normal dev flow (no spec doc)', () => {
    const history: HistoryEntry[] = [
      h('read_file', 'src/agent/loop.ts'),
      h('grep', 'src/'),
      h('edit_file', 'src/agent/loop.ts'),
    ]
    const result = detectSpecToExecuteJump({ recentToolHistory: history })
    assert.equal(result.triggered, false)
  })

  it('no trigger: empty history', () => {
    const result = detectSpecToExecuteJump({ recentToolHistory: [] })
    assert.equal(result.triggered, false)
  })

  // ── Window boundary ──

  it('no trigger: spec outside window', () => {
    const history: HistoryEntry[] = Array.from({ length: 25 }, (_, i) =>
      h('read_file', `src/file-${i}.ts`),
    )
    // Put spec at the beginning (outside windowSize=20)
    history.unshift(h('read_file', 'docs/handoff-foo.md'))
    const result = detectSpecToExecuteJump({
      recentToolHistory: history,
      windowSize: 20,
    })
    assert.equal(result.triggered, false)
  })

  // ── Subdirectory exclusion ──

  it('no trigger: spec in docs/design/ subdirectory', () => {
    const history: HistoryEntry[] = [
      h('read_file', 'docs/design/handoff-analysis.md'),
      h('read_file', 'src/agent/loop.ts'),
    ]
    const result = detectSpecToExecuteJump({ recentToolHistory: history })
    assert.equal(result.triggered, false)
  })

  it('no trigger: spec in docs/research/ subdirectory', () => {
    const history: HistoryEntry[] = [
      h('read_file', 'docs/research/2026-issue-report.md'),
      h('read_file', 'src/agent/loop.ts'),
    ]
    const result = detectSpecToExecuteJump({ recentToolHistory: history })
    assert.equal(result.triggered, false)
  })

  // ── Edge cases ──

  it('no crash: empty target string', () => {
    const history: HistoryEntry[] = [
      h('run_tests', ''),
      h('read_file', ''),
    ]
    const result = detectSpecToExecuteJump({ recentToolHistory: history })
    assert.equal(result.triggered, false)
  })

  it('no trigger: only source reads, no spec', () => {
    const history: HistoryEntry[] = [
      h('read_file', 'src/agent/loop.ts'),
      h('read_file', 'src/prompt/engine.ts'),
    ]
    const result = detectSpecToExecuteJump({ recentToolHistory: history })
    assert.equal(result.triggered, false)
  })

  it('takes the LAST spec doc when multiple present', () => {
    const history: HistoryEntry[] = [
      h('read_file', 'docs/handoff-old.md'),
      h('read_file', 'src/a.ts'),
      h('read_file', 'docs/handoff-new.md'),
      h('read_file', 'src/b.ts'),
    ]
    const result = detectSpecToExecuteJump({ recentToolHistory: history })
    assert.equal(result.triggered, true)
    assert.equal(result.specDocPath, 'docs/handoff-new.md')
  })
})
