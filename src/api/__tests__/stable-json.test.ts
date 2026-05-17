import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { stableStringify } from '../stable-json.js'

describe('stableStringify', () => {
  it('sorts object keys deterministically', () => {
    const a = stableStringify({ z: 1, a: 2, m: 3 })
    const b = stableStringify({ m: 3, z: 1, a: 2 })
    assert.equal(a, b)
    assert.equal(a, '{"a":2,"m":3,"z":1}')
  })

  it('sorts nested object keys', () => {
    const result = stableStringify({ b: { z: 1, a: 2 }, a: 'x' })
    assert.equal(result, '{"a":"x","b":{"a":2,"z":1}}')
  })

  it('preserves array order', () => {
    assert.equal(stableStringify([3, 1, 2]), '[3,1,2]')
  })

  it('omits undefined values', () => {
    const result = stableStringify({ a: 1, b: undefined, c: 3 })
    assert.equal(result, '{"a":1,"c":3}')
  })

  it('handles null', () => {
    assert.equal(stableStringify(null), 'null')
  })

  it('handles primitives', () => {
    assert.equal(stableStringify('hello'), '"hello"')
    assert.equal(stableStringify(42), '42')
    assert.equal(stableStringify(true), 'true')
  })
})
