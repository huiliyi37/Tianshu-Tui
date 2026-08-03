import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tokenizeRecallQuery } from '../query-terms.js'

describe('tokenizeRecallQuery', () => {
  it('keeps English words and produces Han bigrams for mixed-language queries', () => {
    const terms = tokenizeRecallQuery('修复 prefix cache 命中问题')
    assert.ok(terms.includes('prefix'))
    assert.ok(terms.includes('cache'))
    assert.ok(terms.includes('修复'))
    assert.ok(terms.includes('命中'))
  })

  it('does not discard a pure Chinese query', () => {
    assert.deepEqual(tokenizeRecallQuery('灾情专题'), ['灾情', '情专', '专题'])
  })
})
