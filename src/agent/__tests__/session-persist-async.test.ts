import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SessionPersist } from '../session-persist.js'

describe('SessionPersist.loadOaiAsync (S10)', () => {
  it('returns same messages as loadOai but via a Promise', async () => {
    const sessionId = `async-test-${Date.now()}`
    const p = new SessionPersist(sessionId)
    await p.appendOaiWithChecksum({ role: 'user', content: 'hello' } as any)
    const sync = p.loadOai()
    const asyncResult = await p.loadOaiAsync()
    assert.deepEqual(asyncResult, sync)
    p.delete()
  })

  it('resolves to [] for a non-existent session file', async () => {
    const p = new SessionPersist(`missing-${Date.now()}`)
    assert.deepEqual(await p.loadOaiAsync(), [])
  })
})
