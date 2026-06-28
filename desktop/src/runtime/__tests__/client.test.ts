import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  rivetFetch,
  getRuntimeInfo,
  clearRuntimeCache,
  __peekRuntimeCache,
  listModels,
  switchModel,
  listDomains,
  setDomain,
  listSkills,
  setSkillEnabled,
  getHooks,
  setHooks,
} from '../client.ts'
import type { HookEntry } from '../types.ts'

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

// ── PlusMenu client helpers ─────────────────────────────────────────

interface Captured { url: string; method: string; body?: string }

function stubFetch(json: unknown): { calls: Captured[] } {
  const calls: Captured[] = []
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined })
    return Promise.resolve(new Response(JSON.stringify(json), { status: 200 }))
  }) as typeof fetch
  return { calls }
}

test('listModels GETs /models and unwraps the array', async () => {
  clearRuntimeCache()
  const { calls } = stubFetch({ models: [{ id: 'm1', alias: 'M1', provider: 'p', current: true }] })
  try {
    const models = await listModels('s1')
    assert.equal(models.length, 1)
    assert.equal(models[0]!.id, 'm1')
    assert.match(calls[0]!.url, /\/sessions\/s1\/models$/)
    assert.equal(calls[0]!.method, 'GET')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('switchModel POSTs the modelId', async () => {
  clearRuntimeCache()
  const { calls } = stubFetch({ id: 's1', model: 'm2' })
  try {
    await switchModel('s1', 'm2')
    assert.match(calls[0]!.url, /\/sessions\/s1\/model$/)
    assert.equal(calls[0]!.method, 'POST')
    assert.equal(JSON.parse(calls[0]!.body!).modelId, 'm2')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('listDomains GETs /domains and unwraps entries', async () => {
  clearRuntimeCache()
  const { calls } = stubFetch({ entries: [{ key: 'auto', name: 'Auto', motto: '', meta: '', essence: '', current: true }] })
  try {
    const entries = await listDomains('s1')
    assert.equal(entries[0]!.key, 'auto')
    assert.match(calls[0]!.url, /\/sessions\/s1\/domains$/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('setDomain POSTs the key', async () => {
  clearRuntimeCache()
  const { calls } = stubFetch({ id: 's1', domain: 'tianshu' })
  try {
    await setDomain('s1', 'tianshu')
    assert.match(calls[0]!.url, /\/sessions\/s1\/domain$/)
    assert.equal(JSON.parse(calls[0]!.body!).key, 'tianshu')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('listSkills GETs /skills and unwraps the array', async () => {
  clearRuntimeCache()
  const { calls } = stubFetch({ skills: [{ name: 'x', description: 'd', source: 'rivet', enabled: true }] })
  try {
    const skills = await listSkills('s1')
    assert.equal(skills[0]!.name, 'x')
    assert.match(calls[0]!.url, /\/sessions\/s1\/skills$/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('setSkillEnabled POSTs name + enabled', async () => {
  clearRuntimeCache()
  const { calls } = stubFetch({ id: 's1', name: 'x', enabled: false })
  try {
    await setSkillEnabled('s1', 'x', false)
    assert.match(calls[0]!.url, /\/sessions\/s1\/skills$/)
    const parsed = JSON.parse(calls[0]!.body!)
    assert.equal(parsed.name, 'x')
    assert.equal(parsed.enabled, false)
  } finally {
    globalThis.fetch = realFetch
  }
})

// ── Hooks (I4) ──────────────────────────────────────────────────────

test('getHooks GETs /hooks and returns the config', async () => {
  clearRuntimeCache()
  const config = { hooks: [{ event: 'postTool', script: './x.sh' }] }
  const { calls } = stubFetch(config)
  try {
    const res = await getHooks('s1')
    assert.deepEqual(res, config)
    assert.match(calls[0]!.url, /\/sessions\/s1\/hooks$/)
    assert.equal(calls[0]!.method, 'GET')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('setHooks PUTs the hooks array', async () => {
  clearRuntimeCache()
  const hooks: HookEntry[] = [{ event: 'onError', script: './err.sh', timeoutMs: 3000 }]
  const { calls } = stubFetch({ hooks })
  try {
    const res = await setHooks('s1', hooks)
    assert.deepEqual(res, { hooks })
    assert.match(calls[0]!.url, /\/sessions\/s1\/hooks$/)
    assert.equal(calls[0]!.method, 'PUT')
    const parsed = JSON.parse(calls[0]!.body!)
    assert.deepEqual(parsed.hooks, hooks)
  } finally {
    globalThis.fetch = realFetch
  }
})
