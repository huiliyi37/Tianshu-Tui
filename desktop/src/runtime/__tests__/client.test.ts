import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  rivetFetch,
  getRuntimeInfo,
  clearRuntimeCache,
  __peekRuntimeCache,
} from '../client.ts'

// No Tauri here, so getRuntimeInfo() resolves via the env fallback (port 3100,
// empty token). We stub global fetch to drive rivetFetch's invalidation paths.
const realFetch = globalThis.fetch

test('clearRuntimeCache drops the memoized handle; getRuntimeInfo re-memoizes', async () => {
  clearRuntimeCache()
  assert.equal(__peekRuntimeCache(), null)
  const info = await getRuntimeInfo()
  assert.ok(info.port > 0)
  assert.notEqual(__peekRuntimeCache(), null, 'getRuntimeInfo memoizes the handle')
  clearRuntimeCache()
  assert.equal(__peekRuntimeCache(), null)
})

test('rivetFetch invalidates the cache on a network error (sidecar down)', async () => {
  clearRuntimeCache()
  await getRuntimeInfo() // prime the cache
  globalThis.fetch = (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch
  try {
    await assert.rejects(() => rivetFetch('/health'))
    assert.equal(__peekRuntimeCache(), null, 'a connection failure clears the stale handle')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('rivetFetch invalidates the cache on a 401 (token rotated)', async () => {
  clearRuntimeCache()
  await getRuntimeInfo()
  globalThis.fetch = (() => Promise.resolve(new Response('', { status: 401 }))) as typeof fetch
  try {
    const res = await rivetFetch('/health')
    assert.equal(res.status, 401)
    assert.equal(__peekRuntimeCache(), null, 'a 401 clears the stale token handle')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('rivetFetch keeps the cache on a normal 200', async () => {
  clearRuntimeCache()
  globalThis.fetch = (() => Promise.resolve(new Response('{}', { status: 200 }))) as typeof fetch
  try {
    const res = await rivetFetch('/health')
    assert.equal(res.status, 200)
    assert.notEqual(__peekRuntimeCache(), null, 'a healthy response retains the handle')
  } finally {
    globalThis.fetch = realFetch
  }
})
