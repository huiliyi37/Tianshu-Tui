import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { probeProviderKey } from '../key-probe.js'
import { mock } from 'node:test'

describe('probeProviderKey', () => {
  let originalFetch: typeof global.fetch

  beforeEach(() => {
    originalFetch = global.fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('returns ok=true for a 200 response', async () => {
    global.fetch = mock.fn(async () =>
      new Response(JSON.stringify({ id: 'test' }), { status: 200 })
    ) as any
    const result = await probeProviderKey('sk-test', 'https://api.example.com/v1')
    assert.equal(result.ok, true)
    assert.equal(result.status, 200)
    assert.equal(result.error, undefined)
  })

  it('normalizes trailing slash in baseUrl before appending /models', async () => {
    let capturedUrl = ''
    global.fetch = mock.fn(async (url: string) => {
      capturedUrl = url
      return new Response(JSON.stringify({}), { status: 200 })
    }) as any
    await probeProviderKey('sk-test', 'https://api.example.com/v1/')
    assert.match(capturedUrl, /https:\/\/api\.example\.com\/v1\/models/)
  })

  it('returns auth-failed for 401', async () => {
    global.fetch = mock.fn(async () =>
      new Response(JSON.stringify({}), { status: 401 })
    )
    const result = await probeProviderKey('sk-bad', 'https://api.example.com/v1')
    assert.equal(result.ok, false)
    assert.equal(result.status, 401)
    assert.equal(result.error, 'auth-failed')
  })

  it('returns auth-failed for 403', async () => {
    global.fetch = mock.fn(async () =>
      new Response(JSON.stringify({}), { status: 403 })
    )
    const result = await probeProviderKey('sk-bad', 'https://api.example.com/v1')
    assert.equal(result.ok, false)
    assert.equal(result.error, 'auth-failed')
  })

  it('returns http-N for other error statuses', async () => {
    global.fetch = mock.fn(async () =>
      new Response(JSON.stringify({}), { status: 500 })
    )
    const result = await probeProviderKey('sk-test', 'https://api.example.com/v1')
    assert.equal(result.ok, false)
    assert.equal(result.status, 500)
    assert.equal(result.error, 'http-500')
  })

  it('returns network-error on fetch exception', async () => {
    global.fetch = mock.fn(async () =>
      Promise.reject(new Error('ECONNREFUSED'))
    )
    const result = await probeProviderKey('sk-test', 'https://api.example.com/v1')
    assert.equal(result.ok, false)
    assert.equal(result.error, 'network-error')
  })

  it('returns timeout on timeout error', async () => {
    global.fetch = mock.fn(async () =>
      Promise.reject(new DOMException('timeout', 'AbortError'))
    )
    const result = await probeProviderKey('sk-test', 'https://api.example.com/v1')
    assert.equal(result.ok, false)
    assert.equal(result.error, 'timeout')
  })

  it('rejects empty apiKey', async () => {
    global.fetch = mock.fn(async () => new Response('', { status: 200 }))
    const result = await probeProviderKey('', 'https://api.example.com/v1')
    assert.equal(result.ok, false)
    assert.equal(result.error, 'API key is empty')
    assert.equal((global.fetch as any).mock.calls.length, 0)
  })

  it('rejects whitespace-only apiKey', async () => {
    global.fetch = mock.fn(async () => new Response('', { status: 200 }))
    const result = await probeProviderKey('   ', 'https://api.example.com/v1')
    assert.equal(result.ok, false)
    assert.equal(result.error, 'API key is empty')
  })

  it('strips multiple trailing slashes', async () => {
    let capturedUrl = ''
    global.fetch = mock.fn(async (url: string) => {
      capturedUrl = url
      return new Response(JSON.stringify({}), { status: 200 })
    }) as any
    await probeProviderKey('sk-test', 'https://api.example.com/v1///')
    assert.match(capturedUrl, /https:\/\/api\.example\.com\/v1\/models/)
  })

  it('sends Bearer Authorization header with trimmed key', async () => {
    let capturedHeaders: Record<string, string> = {}
    global.fetch = mock.fn(async (_url: string, init?: Record<string, unknown>) => {
      capturedHeaders = (init?.headers as Record<string, string>) ?? {}
      return new Response(JSON.stringify({}), { status: 200 })
    }) as any
    await probeProviderKey('  sk-trimmed  ', 'https://api.example.com/v1')
    assert.equal(capturedHeaders.Authorization, 'Bearer sk-trimmed')
  })
})

describe('probeProviderKey — models 列表（批量添加「从接口拉取」的数据源）', () => {
  let originalFetch: typeof global.fetch

  beforeEach(() => {
    originalFetch = global.fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('200 响应解析 data[].id 按序返回', async () => {
    global.fetch = mock.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }, { id: 'model-c' }] }), { status: 200 })
    ) as any
    const result = await probeProviderKey('sk-test', 'https://api.example.com/v1')
    assert.equal(result.ok, true)
    assert.deepEqual(result.models, ['model-a', 'model-b', 'model-c'])
  })

  it('响应没有 data 数组时 models 缺省——探测语义不变', async () => {
    global.fetch = mock.fn(async () =>
      new Response(JSON.stringify({ id: 'test' }), { status: 200 })
    ) as any
    const result = await probeProviderKey('sk-test', 'https://api.example.com/v1')
    assert.equal(result.ok, true)
    assert.equal(result.models, undefined)
  })

  it('条目缺 id 或非字符串跳过，id 去重', async () => {
    global.fetch = mock.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: 'model-a' }, { object: 'model' }, { id: 'model-a' }, { id: '  ' }, null, { id: 42 }] }), { status: 200 })
    ) as any
    const result = await probeProviderKey('sk-test', 'https://api.example.com/v1')
    assert.deepEqual(result.models, ['model-a'])
  })

  it('超长列表截断到 200（聚合端点巨列表防护）', async () => {
    const data = Array.from({ length: 500 }, (_, i) => ({ id: `model-${i}` }))
    global.fetch = mock.fn(async () =>
      new Response(JSON.stringify({ data }), { status: 200 })
    ) as any
    const result = await probeProviderKey('sk-test', 'https://api.example.com/v1')
    assert.equal(result.models?.length, 200)
    assert.equal(result.models?.[0], 'model-0')
    assert.equal(result.models?.[199], 'model-199')
  })

  it('ok=false 时不带 models', async () => {
    global.fetch = mock.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: 'model-a' }] }), { status: 401 })
    ) as any
    const result = await probeProviderKey('sk-bad', 'https://api.example.com/v1')
    assert.equal(result.ok, false)
    assert.equal(result.models, undefined)
  })
})

// ── 协议感知鉴权头 ──────────────────────────────────────────────────────

describe('probeProviderKey — protocol', () => {
  let originalFetch: typeof global.fetch
  beforeEach(() => { originalFetch = global.fetch })
  afterEach(() => { global.fetch = originalFetch })

  it('anthropic 协议发 x-api-key + anthropic-version，不发 Bearer', async () => {
    let capturedHeaders: Record<string, string> | undefined
    global.fetch = mock.fn(async (_url: string, init?: { headers?: Record<string, string> }) => {
      capturedHeaders = init?.headers
      return new Response(JSON.stringify({ data: [{ id: 'claude-x' }] }), { status: 200 })
    }) as any
    const result = await probeProviderKey('sk-ant-test', 'https://api.example.com/v1', 'anthropic')
    assert.equal(result.ok, true)
    assert.equal(capturedHeaders?.['x-api-key'], 'sk-ant-test')
    assert.ok(capturedHeaders?.['anthropic-version'])
    assert.equal(capturedHeaders?.['Authorization'], undefined)
  })

  it('openai 协议（默认）发 Authorization Bearer，不发 x-api-key', async () => {
    let capturedHeaders: Record<string, string> | undefined
    global.fetch = mock.fn(async (_url: string, init?: { headers?: Record<string, string> }) => {
      capturedHeaders = init?.headers
      return new Response('{}', { status: 200 })
    }) as any
    const result = await probeProviderKey('sk-test', 'https://api.example.com/v1')
    assert.equal(result.ok, true)
    assert.equal(capturedHeaders?.['Authorization'], 'Bearer sk-test')
    assert.equal(capturedHeaders?.['x-api-key'], undefined)
  })
})
