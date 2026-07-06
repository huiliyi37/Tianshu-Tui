import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { clearRuntimeCache, sendPrompt } from '../client.js'

// ── helpers ──────────────────────────────────────────────────────────

let originalFetch: typeof globalThis.fetch
let fetchCalls: Array<{ url: string; init: RequestInit }> = []

function mockFetch(status: number, body: unknown) {
  globalThis.fetch = ((_url: string, _init: RequestInit) => {
    fetchCalls.push({ url: _url, init: _init })
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  }) as typeof globalThis.fetch
}

function mockFetchNonJson(status: number, text: string) {
  globalThis.fetch = ((_url: string, _init: RequestInit) => {
    fetchCalls.push({ url: _url, init: _init })
    return Promise.resolve(
      new Response(text, { status, headers: { 'Content-Type': 'text/plain' } }),
    )
  }) as typeof globalThis.fetch
}

before(() => {
  originalFetch = globalThis.fetch
  // 让 getRuntimeInfo 走 env fallback（Tauri invoke 在测试环境不可用）
  process.env.VITE_RIVET_PORT = '19999'
  process.env.VITE_RIVET_TOKEN = 'test-token'
  clearRuntimeCache()
})

after(() => {
  globalThis.fetch = originalFetch
  delete process.env.VITE_RIVET_PORT
  delete process.env.VITE_RIVET_TOKEN
})

// ── readErrorBody → apiPost 错误消息 ────────────────────────────────

test('apiPost surfaces server error body in thrown Error', async () => {
  mockFetch(400, { error: 'Unknown slash command: "/". Use the command menu.' })

  await assert.rejects(
    sendPrompt('test-session', '/'),
    (err: Error) => err.message.includes('Unknown slash command'),
  )
})

test('apiPost falls back to status-only message when body is not JSON', async () => {
  mockFetchNonJson(500, 'Internal Server Error')

  await assert.rejects(
    sendPrompt('test-session', 'hello'),
    (err: Error) => err.message.includes('POST') && err.message.includes('500'),
  )
})

test('apiPost does not include error field when missing from JSON body', async () => {
  mockFetch(400, { code: 42 }) // no "error" key

  await assert.rejects(
    sendPrompt('test-session', 'hello'),
    (err: Error) => err.message.includes('POST') && err.message.includes('400'),
  )
})
