import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DomainDriftDetector } from '../domain-drift-detector.js'

describe('DomainDriftDetector', () => {
  test('one winning keyword suggests an alternative domain immediately', () => {
    const detector = new DomainDriftDetector('tianliang')

    const drift = detector.evaluate('请审查')

    assert.equal(drift?.currentId, 'tianliang')
    assert.equal(drift?.recommendedId, 'tianquan')
    assert.deepEqual(drift?.matchedKeywords, ['审查'])
  })

  test('returns winning keywords up to the payload cap', () => {
    const detector = new DomainDriftDetector('tianliang')

    const drift = detector.evaluate('请审查评估这个架构方案并权衡取舍')

    assert.equal(drift?.recommendedId, 'tianquan')
    assert.deepEqual(drift?.matchedKeywords, ['审查', '评估', '权衡', '取舍'])
  })

  test('current-domain winner does not suggest drift', () => {
    const detector = new DomainDriftDetector('tianliang')

    assert.equal(detector.evaluate('继续实现和交付'), null)
  })

  test('no keyword match does not suggest drift', () => {
    const detector = new DomainDriftDetector('tianliang')

    assert.equal(detector.evaluate('继续看看'), null)
  })

  test('a top-score tie does not suggest drift', () => {
    const detector = new DomainDriftDetector('tianliang')

    assert.equal(detector.evaluate('审查验证'), null)
  })

  test('suggests each current-to-recommended direction at most once', () => {
    const detector = new DomainDriftDetector('tianliang')

    assert.equal(detector.evaluate('审查')?.recommendedId, 'tianquan')
    assert.equal(detector.evaluate('方案'), null)
  })

  test('can suggest a different direction after an earlier suggestion', () => {
    const detector = new DomainDriftDetector('tianliang')

    assert.equal(detector.evaluate('审查')?.recommendedId, 'tianquan')
    assert.equal(detector.evaluate('验证')?.recommendedId, 'yaoguang')
  })
})
