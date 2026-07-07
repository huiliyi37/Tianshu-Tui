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

    it('passes through small success output unchanged', () => {
      const small = Array.from({ length: 5 }, (_, i) => `line ${i}`).join('\n')
      const result = buildModelOutput(small, meta)
      assert.ok(result.includes('line 0'))
      assert.ok(result.includes('line 4'))
      assert.ok(!result.includes('success output suppressed'))
    })

    it('shows tail of long success output instead of suppressing', () => {
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
      const result = buildModelOutput(lines, meta)
      assert.ok(result.startsWith('[npm test] exit=0 time=1.5s lines=50'))
      assert.ok(result.includes('truncated'), 'should show truncation marker')
      assert.ok(result.includes('30 lines omitted'), 'should show omitted count')
      assert.ok(result.includes('line 49'), 'should show tail line')
      assert.ok(!result.includes('line 0'), 'should omit head line')
      assert.ok(!result.includes('success output suppressed'), 'should NOT suppress')
    })

    it('preserves failed output instead of success-suppressing it', () => {
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
      const result = buildModelOutput(lines, { ...meta, exitCode: 1 })
      assert.ok(result.startsWith('[npm test] exit=1'))
      assert.ok(result.includes('line 0'))
      assert.ok(result.includes('line 49'))
      assert.ok(!result.includes('success output suppressed'))
    })

    it('truncates very large failed output with head/tail by lines', () => {
      const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
      const result = buildModelOutput(lines, { ...meta, exitCode: 1 })
      assert.ok(result.includes('lines omitted'))
      assert.ok(result.startsWith('[npm test] exit=1'))
    })

    it('error-aware: failed output over threshold surfaces error lines to the model', () => {
      const lines: string[] = []
      for (let i = 1; i <= 45; i++) lines.push(`info: noise line ${i}`)
      lines.push('error TS2345: type mismatch at src/foo.ts:42')
      lines.push('  expected string, got number')
      const result = buildModelOutput(lines.join('\n'), { ...meta, exitCode: 1 })
      assert.ok(result.includes('error TS2345') || result.includes('expected string'),
        'model output should surface the diagnostic line, not just head/tail noise')
      assert.ok(result.includes('error-aware'), 'should mark error-aware truncation')
      assert.ok(result.includes('lines omitted'), 'should report omitted noise lines')
    })

    it('small failed output under threshold passes through complete (no error-aware)', () => {
      const lines = Array.from({ length: 10 }, (_, i) => `fail line ${i}`).join('\n')
      const result = buildModelOutput(lines, { ...meta, exitCode: 1 })
      assert.ok(result.includes('fail line 0') && result.includes('fail line 9'))
      assert.ok(!result.includes('error-aware'), 'small failures stay complete')
    })

    it('handles empty output', () => {
      const result = buildModelOutput('', meta)
      assert.ok(result.includes('lines=0'))
    })

    it('empty output is marked as confirmed empty (not collapsed)', () => {
      const result = buildModelOutput('', meta)
      assert.ok(result.includes('[output complete: 0 lines — confirmed empty]'),
        'genuinely empty output must be explicitly marked so the model does not confuse it with collapsed output')
      assert.ok(!result.includes('truncated'), 'empty output must not show truncated marker')
    })

    it('complete output is marked as output complete', () => {
      const small = Array.from({ length: 5 }, (_, i) => `line ${i}`).join('\n')
      const result = buildModelOutput(small, meta)
      assert.ok(result.includes('output complete'), 'full output must be marked complete')
      assert.ok(!result.includes('truncated'), 'full output must not show truncated')
    })

    it('success truncation footer includes rawPath recovery hint when available', () => {
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
      const result = buildModelOutput(lines, { ...meta, rawPath: '/tmp/rivet-raw/abc.raw' })
      assert.ok(result.includes('full output: read_file /tmp/rivet-raw/abc.raw'),
        'footer must tell the model how to recover full output instead of re-running the command')
      assert.ok(result.includes('不要重跑命令'))
    })

    it('large failed-output truncation footer includes rawPath recovery hint', () => {
      const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
      const result = buildModelOutput(lines, { ...meta, exitCode: 1, rawPath: '/tmp/rivet-raw/def.raw' })
      assert.ok(result.includes('full output: read_file /tmp/rivet-raw/def.raw'))
    })

    it('omits recovery hint when rawPath is absent', () => {
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
      const result = buildModelOutput(lines, meta)
      assert.ok(!result.includes('full output: read_file'))
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
