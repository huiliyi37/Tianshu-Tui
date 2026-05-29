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

  it('silently absorbs execution errors without unhandled rejection', async () => {
    let unhandledCount = 0
    const handler = () => { unhandledCount++ }
    process.on('unhandledRejection', handler)

    const queue = new ShadowQueue({
      execute: async () => { throw new Error('speculative failure') },
    })
    queue.enqueue({ tool: 'read_file', probability: 0.8, likelyTarget: 'src/foo.ts' })

    // Wait for the speculative execution to settle
    await new Promise(r => setTimeout(r, 50))

    // The result should NOT be cached (execution failed)
    const hit = queue.checkHit('read_file', 'src/foo.ts')
    assert.equal(hit, undefined)

    // inflight should be decremented even on failure
    assert.equal(queue.pending(), 0)

    // No unhandled rejection should have occurred
    assert.equal(unhandledCount, 0, 'speculative execution should not cause unhandled rejection')

    process.off('unhandledRejection', handler)
  })
})
