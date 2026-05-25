import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decideReadPolicy } from '../read-policy.js'

describe('decideReadPolicy', () => {
  it('previews log-like files over the guard size when no explicit range is provided', () => {
    const decision = decideReadPolicy({ filePath: '/repo/logs/app.log', sizeBytes: 20_000, hasExplicitRange: false })
    assert.equal(decision.kind, 'log')
    assert.equal(decision.action, 'preview')
    assert.equal(decision.previewLines, 80)
    assert.equal(decision.maxRangeLines, 200)
  })

  it('allows explicit ranges for JSONL files', () => {
    const decision = decideReadPolicy({ filePath: '/repo/logs/app.jsonl', sizeBytes: 20_000, hasExplicitRange: true })
    assert.equal(decision.kind, 'jsonl')
    assert.equal(decision.action, 'full')
  })

  it('allows normal source files below the hard size guard', () => {
    const decision = decideReadPolicy({ filePath: '/repo/src/app.ts', sizeBytes: 20_000, hasExplicitRange: false })
    assert.equal(decision.kind, 'source')
    assert.equal(decision.action, 'full')
  })

  it('rejects generated minified files unless a range is explicit', () => {
    const decision = decideReadPolicy({ filePath: '/repo/dist/app.min.js', sizeBytes: 20_000, hasExplicitRange: false })
    assert.equal(decision.kind, 'minified')
    assert.equal(decision.action, 'reject-with-range')
  })
})
