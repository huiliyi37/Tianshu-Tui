import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { persistRawOutput, buildModelOutput, buildUiOutput } from '../output-store.js'

describe('output-store', () => {
  const meta = { command: 'npm test', exitCode: 0, durationMs: 1500 }

  describe('persistRawOutput', () => {
    const rawDir = join(tmpdir(), 'rivet-raw')

    afterEach(() => {
      try {
        const files = ['test-id', '../escape'].map(id => {
          const hash = require('node:crypto').createHash('sha256').update(id).digest('hex').slice(0, 24)
          return join(rawDir, `${hash}.raw`)
        })
        for (const f of files) {
          if (existsSync(f)) rmSync(f)
        }
      } catch { /* ignore */ }
    })

    it('writes raw output to file and returns path', async () => {
      const path = await persistRawOutput('test-id', 'hello world')
      assert.ok(existsSync(path))
      assert.ok(path.endsWith('.raw'))
      assert.ok(path.includes('rivet-raw'))
    })

    it('does not use toolUseId directly as a file path', async () => {
      const rawPath = await persistRawOutput('../escape', 'secret')
      assert.ok(rawPath.includes('rivet-raw'))
      assert.ok(!rawPath.includes('..'))
      assert.ok(rawPath.endsWith('.raw'))
    })
  })

  describe('buildModelOutput', () => {
    it('includes header with command, exit code, duration, line count', () => {
      const result = buildModelOutput('line1\nline2\n', meta)
      assert.ok(result.startsWith('[npm test] exit=0 time=1.5s lines=2'))
      assert.ok(result.includes('line1'))
      assert.ok(result.includes('line2'))
    })

    it('passes through small output unchanged', () => {
      const small = 'hello world'
      const result = buildModelOutput(small, meta)
      assert.ok(result.includes(small))
    })

    it('truncates large output with head/tail by lines', () => {
      const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
      const result = buildModelOutput(lines, { ...meta, exitCode: 1 })
      assert.ok(result.includes('lines omitted'))
      assert.ok(result.startsWith('[npm test] exit=1'))
    })

    it('handles empty output', () => {
      const result = buildModelOutput('', meta)
      assert.ok(result.includes('lines=0'))
    })

    // --- Success folding (Phase 1: deterministic output trimming) ---
    const SUCCESS_INLINE_LINES = 20

    it('success + ≤20 lines: returns full output inline', () => {
      const lines = Array.from({ length: 5 }, (_, i) => `line ${i}`).join('\n')
      const result = buildModelOutput(lines, { ...meta, exitCode: 0 })
      assert.ok(result.includes('line 0'), 'short success output should be inline')
      assert.ok(result.includes('line 4'), 'short success output should be inline')
      assert.ok(!result.includes('suppressed'), 'short success should not be folded')
    })

    it('success + exactly 20 lines: returns full output (boundary)', () => {
      const lines = Array.from({ length: SUCCESS_INLINE_LINES }, (_, i) => `line ${i}`).join('\n')
      const result = buildModelOutput(lines, { ...meta, exitCode: 0 })
      assert.ok(result.includes('line 0'), 'boundary success should be inline')
      assert.ok(!result.includes('suppressed'), 'boundary success should not be folded')
    })

    it('success + >20 lines: folds to header summary only', () => {
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
      const result = buildModelOutput(lines, { ...meta, exitCode: 0 })
      assert.ok(result.startsWith('[npm test] exit=0'), 'should have header')
      assert.ok(result.includes('suppressed'), 'should indicate output was suppressed')
      assert.ok(result.includes('50 lines'), 'should report line count')
      assert.ok(!result.includes('line 0'), 'body should be folded away')
      assert.ok(!result.includes('line 49'), 'body should be folded away')
    })

    it('failure + >20 lines: never folds, returns full/truncated output', () => {
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
      const result = buildModelOutput(lines, { ...meta, exitCode: 1 })
      assert.ok(result.includes('line 0'), 'failure output should include body')
      assert.ok(!result.includes('suppressed'), 'failure should never be folded')
    })

    it('failure + >200 lines: still applies existing head/tail truncation', () => {
      const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
      const result = buildModelOutput(lines, { ...meta, exitCode: 1 })
      assert.ok(result.includes('lines omitted'), 'large failure should be truncated')
      assert.ok(result.startsWith('[npm test] exit=1'))
      assert.ok(!result.includes('suppressed'), 'failure should never be folded')
    })
  })

  describe('buildUiOutput', () => {
    it('shows checkmark for success', () => {
      const result = buildUiOutput('', meta)
      assert.ok(result.startsWith('✓'))
    })

    it('shows cross for failure', () => {
      const result = buildUiOutput('', { ...meta, exitCode: 1 })
      assert.ok(result.startsWith('✗'))
    })

    it('shows all lines when under limit', () => {
      const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n')
      const result = buildUiOutput(lines, meta)
      assert.ok(result.includes('line 9'))
      assert.ok(!result.includes('omitted'))
    })

    it('truncates to last N lines when over limit', () => {
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
      const result = buildUiOutput(lines, meta, 20)
      assert.ok(result.includes('lines omitted'))
      assert.ok(result.includes('line 49'))
      assert.ok(!result.includes('line 0'))
    })

    it('shows duration in seconds', () => {
      const result = buildUiOutput('', { command: 'echo hi', exitCode: 0, durationMs: 2345 })
      assert.ok(result.includes('2.3s'))
    })

    it('error-aware: prioritizes error lines over pure tail for failed commands', () => {
      const lines: string[] = []
      for (let i = 1; i <= 40; i++) lines.push(`info: line ${i}`)
      lines.push('error TS2345: type mismatch at src/foo.ts:42')
      lines.push('  expected string, got number')
      for (let i = 41; i <= 60; i++) lines.push(`info: line ${i}`)
      const raw = lines.join('\n')
      const result = buildUiOutput(raw, { ...meta, exitCode: 1 }, 20)
      // Should include the error lines, not just tail
      assert.ok(result.includes('error TS2345') || result.includes('expected string'),
        'error-aware output should include diagnostic lines')
      assert.ok(result.includes('non-error lines skipped') || result.includes('lines skipped'),
        'should indicate omitted non-error content')
    })

    it('error-aware: falls back to head+tail when no error markers found', () => {
      const lines = Array.from({ length: 50 }, (_, i) => `info: line ${i}`)
      const raw = lines.join('\n')
      const result = buildUiOutput(raw, { ...meta, exitCode: 1 }, 20)
      // Should still truncate (no error markers → fallback)
      assert.ok(result.includes('no error markers detected') || result.includes('line 0'),
        'should fall back to head+tail when no error patterns match')
    })
  })
})
