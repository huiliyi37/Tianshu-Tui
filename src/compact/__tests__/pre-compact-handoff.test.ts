import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { generateHandoff } from '../pre-compact-handoff.js'

describe('generateHandoff', () => {
  it('extracts decisions and modified files from trajectory', () => {
    const entries = [
      { role: 'assistant', content: 'I will edit foo.ts to fix the bug' },
      { role: 'tool', tool_call_id: '1', name: 'edit_file', content: 'ok', input: { file_path: 'src/foo.ts' } },
      { role: 'tool', tool_call_id: '2', name: 'bash', content: 'PASS', input: { command: 'npm test' } },
      { role: 'assistant', content: 'Tests pass. The fix is complete.' },
    ]

    const handoff = generateHandoff(entries as any)
    assert.ok(handoff.filesModified.includes('src/foo.ts'))
    assert.ok(handoff.summary.length > 0)
    assert.ok(handoff.summary.length < 500)
  })

  it('captures failed tool calls', () => {
    const entries = [
      { role: 'tool', tool_call_id: '1', name: 'bash', content: 'error TS2322: ...', input: { command: 'npx tsc --noEmit' }, isError: true },
      { role: 'tool', tool_call_id: '2', name: 'edit_file', content: 'ok', input: { file_path: 'src/bar.ts' } },
      { role: 'tool', tool_call_id: '3', name: 'bash', content: '', input: { command: 'npx tsc --noEmit' } },
    ]

    const handoff = generateHandoff(entries as any)
    assert.ok(handoff.filesModified.includes('src/bar.ts'))
    assert.ok(handoff.hadFailures)
  })

  it('returns compact YAML-like format under 400 tokens', () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({
      role: 'tool', tool_call_id: String(i), name: 'read_file',
      content: 'x'.repeat(1000), input: { file_path: `src/file${i}.ts` },
    }))

    const handoff = generateHandoff(entries as any)
    // ~4 chars per token estimate
    assert.ok(handoff.summary.length < 1600)
  })
})
