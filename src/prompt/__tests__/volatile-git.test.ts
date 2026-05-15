import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createGitStatusCache, formatGitStatus } from '../volatile-git.js'

describe('volatile git status cache', () => {
  it('formats branch and clean status', () => {
    assert.equal(
      formatGitStatus('main', ''),
      'Current branch: main\nStatus:\n(clean)',
    )
  })

  it('returns stale value immediately while refresh is running', async () => {
    let resolveRefresh!: (value: string | undefined) => void
    const cache = createGitStatusCache({
      ttlMs: 1,
      now: () => Date.now(),
      load: () => new Promise(resolve => { resolveRefresh = resolve }),
    })

    cache.prime('old status')
    const refresh = cache.refresh('/repo')

    assert.equal(cache.get('/repo'), 'old status')
    resolveRefresh('new status')
    await refresh
    assert.equal(cache.get('/repo'), 'new status')
  })

  it('coalesces concurrent refresh calls', async () => {
    let calls = 0
    const cache = createGitStatusCache({
      ttlMs: 30_000,
      now: () => Date.now(),
      load: async () => {
        calls++
        return 'status'
      },
    })

    await Promise.all([cache.refresh('/repo'), cache.refresh('/repo')])
    assert.equal(calls, 1)
    assert.equal(cache.get('/repo'), 'status')
  })
})
