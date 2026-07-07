import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGitStatusCache, formatGitStatus } from '../volatile-git.js'

describe('volatile git status cache', () => {
  it('formats branch and clean status', () => {
    assert.equal(
      formatGitStatus('main', ''),
      'Current branch: main\nStatus:\n(clean)',
    )
  })

  it('does not start an implicit refresh from the synchronous get path', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'volatile-git-cache-'))
    try {
      let calls = 0
      const cache = createGitStatusCache({
        ttlMs: 30_000,
        now: () => Date.now(),
        load: async () => {
          calls++
          return 'status'
        },
      })

      assert.equal(cache.get(cwd), undefined)
      assert.equal(calls, 0)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('returns stale value immediately while refresh is running', async () => {
    let resolveRefresh!: (value: string | undefined) => void
    const cache = createGitStatusCache({
      ttlMs: 1,
      now: () => Date.now(),
      load: () => new Promise(resolve => { resolveRefresh = resolve }),
    })

    cache.prime('/repo', 'old status')
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
