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
      // Clean up test files
      try {
        const testFile = join(rawDir, 'test-id.raw')
        if (existsSync(testFile)) rmSync(testFile)
      } catch { /* ignore */ }
    })

    it('writes raw output to file and returns path', async () => {
      const path = await persistRawOutput('test-id', 'hello world')
      assert.ok(existsSync(path))
      assert.ok(path.endsWith('test-id.raw'))
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
  })
})
