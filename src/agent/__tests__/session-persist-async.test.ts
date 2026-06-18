import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SessionPersist } from '../session-persist.js'

describe('SessionPersist load round-trip (S10)', () => {
  it('loadOai returns messages previously written via appendOaiWithChecksum', async () => {
    const sessionId = `roundtrip-test-${Date.now()}`
    const p = new SessionPersist(sessionId, process.cwd())
    await p.appendOaiWithChecksum({ role: 'user', content: 'hello' } as any)
    const loaded = p.loadOai()
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0]!.content, 'hello')
    p.delete()
  })

  it('loadOai returns [] for a session with no prior messages', () => {
    const p = new SessionPersist(`empty-test-${Date.now()}`, process.cwd())
    assert.deepEqual(p.loadOai(), [])
  })
})
