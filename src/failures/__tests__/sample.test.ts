import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createFailureSample } from '../sample.js'

describe('failure sample library', () => {
  it('writes redacted failure sample files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'failure-sample-'))
    try {
      const result = await createFailureSample(dir, {
        slug: 'tool-json-invalid',
        task: 'Run tests',
        model: 'deepseek-v4',
        transcript: 'apiKey=sk-secret-value-longstringhere',
        expected: 'tests pass',
        actual: 'tool JSON invalid',
        rootCause: 'model emitted malformed JSON',
        fix: 'repair JSON before parsing',
      })

      const transcript = readFileSync(join(result.path, 'transcript.redacted.jsonl'), 'utf-8')
      assert.ok(!transcript.includes('sk-secret-value-longstringhere'))
      assert.ok(transcript.includes('sk-xxx'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
