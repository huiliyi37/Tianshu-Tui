import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { StreamOutput } from '../stream.js'

describe('StreamOutput', () => {
  it('exports StreamOutput component', () => {
    assert.ok(StreamOutput, 'StreamOutput should be defined')
    assert.equal(typeof StreamOutput, 'object')
  })
})
