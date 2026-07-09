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
  setEffort,
  listSkills,
  setSkillEnabled,
  getHooks,
  setHooks,
  delegateWorker,
  abortDelegateWorker,
  sendPrompt,
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

test('setEffort POSTs the effort level', async () => {
  clearRuntimeCache()
  const { calls } = stubFetch({ id: 's1', effort: 'max' })
  try {
    await setEffort('s1', 'max')
    assert.match(calls[0]!.url, /\/sessions\/s1\/effort$/)
    assert.equal(calls[0]!.method, 'POST')
    assert.equal(JSON.parse(calls[0]!.body!).effort, 'max')
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

test('delegateWorker POSTs objective/profile/files to /delegate', async () => {
  clearRuntimeCache()
  const { calls } = stubFetch({ workerId: 'user:abc' })
  try {
    const res = await delegateWorker('s1', { objective: 'go', profile: 'code_scout', files: ['a.ts'] })
    assert.equal(res.workerId, 'user:abc')
    assert.match(calls[0]!.url, /\/sessions\/s1\/delegate$/)
    assert.equal(calls[0]!.method, 'POST')
    const body = JSON.parse(calls[0]!.body!)
    assert.equal(body.objective, 'go')
    assert.equal(body.profile, 'code_scout')
    assert.deepEqual(body.files, ['a.ts'])
  } finally {
    globalThis.fetch = realFetch
  }
})

test('abortDelegateWorker POSTs to /delegate/:workerId/abort', async () => {
  clearRuntimeCache()
  const { calls } = stubFetch({ ok: true })
  try {
    await abortDelegateWorker('s1', 'user:abc')
    assert.match(calls[0]!.url, /\/sessions\/s1\/delegate\/user:abc\/abort$/)
    assert.equal(calls[0]!.method, 'POST')
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

// ── apiPost error-body surfacing (67e6ca7f) ─────────────────────────

function mockFetch(status: number, body: unknown) {
  globalThis.fetch = ((_url: string, _init?: RequestInit) => {
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  }) as typeof globalThis.fetch
}

function mockFetchNonJson(status: number, text: string) {
  globalThis.fetch = ((_url: string, _init?: RequestInit) => {
    return Promise.resolve(
      new Response(text, { status, headers: { 'Content-Type': 'text/plain' } }),
    )
  }) as typeof globalThis.fetch
}

test('apiPost surfaces server error body in thrown Error', async () => {
  clearRuntimeCache()
  mockFetch(400, { error: 'Unknown slash command: "/". Use the command menu.' })
  try {
    await assert.rejects(
      sendPrompt('test-session', '/'),
      (err: Error) => err.message.includes('Unknown slash command'),
    )
  } finally {
    globalThis.fetch = realFetch
  }
})

test('apiPost falls back to status-only message when body is not JSON', async () => {
  clearRuntimeCache()
  mockFetchNonJson(500, 'Internal Server Error')
  try {
    await assert.rejects(
      sendPrompt('test-session', 'hello'),
      (err: Error) => err.message.includes('POST') && err.message.includes('500'),
    )
  } finally {
    globalThis.fetch = realFetch
  }
})

test('apiPost does not include error field when missing from JSON body', async () => {
  clearRuntimeCache()
  mockFetch(400, { code: 42 }) // no "error" key
  try {
    await assert.rejects(
      sendPrompt('test-session', 'hello'),
      (err: Error) => err.message.includes('POST') && err.message.includes('400'),
    )
  } finally {
    globalThis.fetch = realFetch
  }
})
