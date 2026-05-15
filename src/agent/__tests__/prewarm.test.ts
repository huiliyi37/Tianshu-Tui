import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PrewarmCache } from '../prewarm.js'

describe('PrewarmCache', () => {
  it('stores and retrieves cached content', () => {
    const cache = new PrewarmCache()
    cache.set('src/auth.ts', 'file content here')
    assert.equal(cache.get('src/auth.ts'), 'file content here')
  })

  it('returns undefined for missing keys', () => {
    const cache = new PrewarmCache()
    assert.equal(cache.get('nonexistent'), undefined)
  })

  it('expires entries after TTL', () => {
    const cache = new PrewarmCache(50) // 50ms TTL
    cache.set('key', 'value')
    assert.equal(cache.get('key'), 'value')
    cache.expireAll()
    assert.equal(cache.get('key'), undefined)
  })

  it('invalidates on file path', () => {
    const cache = new PrewarmCache()
    cache.set('src/auth.ts', 'old content')
    cache.invalidate('src/auth.ts')
    assert.equal(cache.get('src/auth.ts'), undefined)
  })

  it('tracks hit rate', () => {
    const cache = new PrewarmCache()
    cache.set('a', 'content')
    cache.get('a') // hit
    cache.get('b') // miss
    const stats = cache.stats()
    assert.equal(stats.hits, 1)
    assert.equal(stats.misses, 1)
    assert.equal(stats.hitRate, 0.5)
  })

  it('limits max entries', () => {
    const cache = new PrewarmCache(30000, 3)
    cache.set('a', '1')
    cache.set('b', '2')
    cache.set('c', '3')
    cache.set('d', '4') // evicts 'a'
    assert.equal(cache.get('a'), undefined)
    assert.equal(cache.get('d'), '4')
  })
})
