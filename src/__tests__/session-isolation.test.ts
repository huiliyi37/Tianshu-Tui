import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

describe('session isolation', () => {
  it('randomUUID generates unique IDs (100 iterations)', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) {
      ids.add(randomUUID())
    }
    assert.equal(ids.size, 100, 'All 100 UUIDs should be unique')
  })

  it('randomUUID produces v4 UUID format', () => {
    const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    for (let i = 0; i < 10; i++) {
      const id = randomUUID()
      assert.match(id, uuidV4Regex, `UUID "${id}" should match v4 format`)
    }
  })
})
