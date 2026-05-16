import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PrewarmCache } from '../prewarm.js'
import type { PrewarmValue } from '../prewarm-file.js'

function pv(content: string): PrewarmValue {
  return { canonicalPath: '/abs', content, uiContent: content }
}

describe('PrewarmCache', () => {
  it('stores and retrieves cached content', () => {
    const cache = new PrewarmCache()
    cache.set('src/auth.ts', pv('file content here'))
    assert.equal(cache.get('src/auth.ts')?.content, 'file content here')
  })

  it('returns undefined for missing keys', () => {
    const cache = new PrewarmCache()
    assert.equal(cache.get('nonexistent'), undefined)
  })

  it('expires entries after TTL', () => {
    const cache = new PrewarmCache(50) // 50ms TTL
    cache.set('key', pv('value'))
    assert.equal(cache.get('key')?.content, 'value')
    cache.expireAll()
    assert.equal(cache.get('key'), undefined)
  })

  it('invalidates on file path', () => {
    const cache = new PrewarmCache()
    cache.set('src/auth.ts', pv('old content'))
    cache.invalidate('src/auth.ts')
    assert.equal(cache.get('src/auth.ts'), undefined)
  })

  it('tracks hit rate', () => {
    const cache = new PrewarmCache()
    cache.set('a', pv('content'))
    cache.get('a') // hit
    cache.get('b') // miss
    const stats = cache.stats()
    assert.equal(stats.hits, 1)
    assert.equal(stats.misses, 1)
    assert.equal(stats.hitRate, 0.5)
  })

  it('limits max entries', () => {
    const cache = new PrewarmCache(30000, 3)
    cache.set('a', pv('1'))
    cache.set('b', pv('2'))
    cache.set('c', pv('3'))
    cache.set('d', pv('4')) // evicts 'a'
    assert.equal(cache.get('a'), undefined)
    assert.equal(cache.get('d')?.content, '4')
  })

  it('evicts least recently used entry when full', () => {
    const cache = new PrewarmCache(30_000, 3)
    cache.set('a', pv('1'))
    cache.set('b', pv('2'))
    cache.set('c', pv('3'))

    assert.equal(cache.get('a')?.content, '1')
    cache.set('d', pv('4'))

    assert.equal(cache.get('a')?.content, '1')
    assert.equal(cache.get('b'), undefined)
    assert.equal(cache.get('c')?.content, '3')
    assert.equal(cache.get('d')?.content, '4')
  })

  it('refreshes recency on get', () => {
    const cache = new PrewarmCache(30_000, 2)
    cache.set('a', pv('1'))
    cache.set('b', pv('2'))
    assert.equal(cache.get('a')?.content, '1')

    cache.set('c', pv('3'))

    assert.equal(cache.get('a')?.content, '1')
    assert.equal(cache.get('b'), undefined)
    assert.equal(cache.get('c')?.content, '3')
  })
})
