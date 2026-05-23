import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ShadowQueue } from '../shadow-queue.js'

describe('ShadowQueue', () => {
  it('enqueues predicted tool execution', () => {
    const queue = new ShadowQueue({
      execute: async () => 'result',
    })
    queue.enqueue({ tool: 'read_file', probability: 0.8, likelyTarget: 'src/foo.ts' })
    assert.equal(queue.pending(), 1)
  })

  it('returns cached result on hit', async () => {
    const queue = new ShadowQueue({
      execute: async () => 'cached-content',
    })
    queue.enqueue({ tool: 'read_file', probability: 0.8, likelyTarget: 'src/foo.ts' })
    await new Promise(r => setTimeout(r, 20))
    const hit = queue.checkHit('read_file', 'src/foo.ts')
    assert.equal(hit, 'cached-content')
  })

  it('returns undefined on miss', () => {
    const queue = new ShadowQueue({ execute: async () => 'x' })
    assert.equal(queue.checkHit('read_file', 'src/other.ts'), undefined)
  })

  it('does not enqueue below probability threshold', () => {
    const queue = new ShadowQueue({ execute: async () => 'x', minProbability: 0.5 })
    queue.enqueue({ tool: 'read_file', probability: 0.3, likelyTarget: 'src/foo.ts' })
    assert.equal(queue.pending(), 0)
  })
})
