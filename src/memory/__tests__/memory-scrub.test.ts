import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { containsSensitive, scrubMemoryText } from '../memory-scrub.js'

describe('memory scrub（阶段5安全）', () => {
  it('redacts common credential patterns to ***', () => {
    assert.equal(scrubMemoryText('连接用了 sk-abc123XYZ789opqrs'), '连接用了 ***')
    assert.equal(scrubMemoryText('Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig 失效'), '*** 失效')
    assert.match(scrubMemoryText('password = hunter2hunter2')!, /\*\*\*/)
    assert.equal(containsSensitive('sk-somekey1234567890abcdef'), true)
  })

  it('keeps normal prose untouched', () => {
    assert.equal(scrubMemoryText('实现了意图门控 STM，走 appendixDelta'), '实现了意图门控 STM，走 appendixDelta')
    assert.equal(scrubMemoryText('发现 run_tests 有并发竞争'), '发现 run_tests 有并发竞争')
    assert.equal(containsSensitive('普通文本无凭据'), false)
  })

  it('returns null when the summary is dominated by secrets (drop the entry)', () => {
    assert.equal(scrubMemoryText('sk-aaaaaaaaaaaaaaaaaaaa sk-aaaaaaaaaaaaaaaaaaaa'), null)
  })
})
