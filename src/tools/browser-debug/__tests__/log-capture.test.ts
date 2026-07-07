import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LogCapture,
  normalizeConsoleLevel,
  formatConsoleLine,
  formatNetworkLine,
  formatNetworkDetail,
  shouldCaptureResponseBody,
  truncateResponseBody,
  classifyBrowserDebugLine,
  maskSensitiveHeaders,
  maskSecretValue,
  formatCookies,
  formatStorage,
  parseNetworkLine,
} from '../log-capture.js'

test('normalizeConsoleLevel maps warning to warn', () => {
  assert.equal(normalizeConsoleLevel('warning'), 'warn')
  assert.equal(normalizeConsoleLevel('error'), 'error')
  assert.equal(normalizeConsoleLevel('verbose'), 'debug')
  assert.equal(normalizeConsoleLevel('other'), 'log')
})

test('formatConsoleLine prefixes level for TUI colouring', () => {
  const line = formatConsoleLine({ level: 'error', text: 'boom', ts: 0 })
  assert.equal(line, '[error] boom')
})

test('classifyBrowserDebugLine buckets console levels', () => {
  assert.equal(classifyBrowserDebugLine('[error] boom'), 'error')
  assert.equal(classifyBrowserDebugLine('[warn] careful'), 'warn')
  assert.equal(classifyBrowserDebugLine('[info] fyi'), 'muted')
  assert.equal(classifyBrowserDebugLine('[log] noise'), 'muted')
  assert.equal(classifyBrowserDebugLine('[debug] trace'), 'muted')
})

test('classifyBrowserDebugLine buckets network lines by glyph and status', () => {
  assert.equal(classifyBrowserDebugLine('✗ GET /a (net::ERR)'), 'error')
  assert.equal(classifyBrowserDebugLine('→ GET /a'), 'pending')
  assert.equal(classifyBrowserDebugLine('← 200 GET /a (12ms)'), 'ok')
  assert.equal(classifyBrowserDebugLine('← 404 GET /a'), 'warn')
  assert.equal(classifyBrowserDebugLine('← 500 GET /a'), 'error')
  assert.equal(classifyBrowserDebugLine('← 301 GET /a'), 'muted')
  assert.equal(classifyBrowserDebugLine('plain text'), 'muted')
})

test('formatNetworkLine renders pending, success, and failure glyphs', () => {
  const pending = formatNetworkLine({ requestId: '1', method: 'GET', url: '/a', startedAt: 0 })
  assert.match(pending, /^→ GET/)
  const ok = formatNetworkLine({
    requestId: '1', method: 'GET', url: '/a', startedAt: 0, status: 200, durationMs: 12,
  })
  assert.match(ok, /^← 200 GET.*\(12ms\)/)
  const fail = formatNetworkLine({
    requestId: '2', method: 'POST', url: '/b', startedAt: 0, failed: true, errorText: 'net::ERR',
  })
  assert.match(fail, /^✗ POST/)
})

test('formatNetworkLine includeBody appends response snippet', () => {
  const line = formatNetworkLine({
    requestId: 'r1',
    method: 'POST',
    url: 'http://localhost/api/x',
    startedAt: 0,
    status: 500,
    responseBody: '{"error":"bad"}',
  }, true)
  assert.match(line, /body: \{"error":"bad"\}/)
})

test('formatNetworkDetail includes body and metadata', () => {
  const detail = formatNetworkDetail({
    requestId: 'r2',
    method: 'POST',
    url: 'http://localhost/api/login',
    startedAt: 0,
    status: 401,
    durationMs: 45,
    resourceType: 'fetch',
    contentType: 'application/json',
    responseBody: '{"message":"unauthorized"}',
  })
  assert.match(detail, /id: r2/)
  assert.match(detail, /status: 401/)
  assert.match(detail, /type: fetch/)
  assert.match(detail, /unauthorized/)
})

test('maskSensitiveHeaders redacts tokens/cookies, keeps others', () => {
  const masked = maskSensitiveHeaders({
    Authorization: 'Bearer secret-token-abcd',
    Cookie: 'session=xyz9',
    'Content-Type': 'application/json',
    'X-Api-Key': 'k',
  })
  assert.equal(masked['Authorization'], '***(…abcd)')
  assert.equal(masked['Cookie'], '***(…xyz9)')
  assert.equal(masked['X-Api-Key'], '***(…)')
  assert.equal(masked['Content-Type'], 'application/json')
})

test('LogCapture stores request headers/payload and preserves through completeRequest', () => {
  const cap = new LogCapture()
  cap.startRequest(
    'r9', 'POST', 'http://localhost/api/login', Date.now(), 'fetch',
    { Authorization: 'Bearer tok-1234', 'Content-Type': 'application/json' },
    '{"user":"a","pass":"p"}',
  )
  cap.completeRequest('r9', 401, Date.now(), 'fetch', { 'x-request-id': 'req-42' })
  const entry = cap.getByRequestId('r9')!
  assert.equal(entry.requestHeaders?.['Authorization'], 'Bearer tok-1234')
  assert.equal(entry.requestBody, '{"user":"a","pass":"p"}')
  assert.equal(entry.responseHeaders?.['x-request-id'], 'req-42')
})

test('formatNetworkDetail shows masked request/response headers and payload', () => {
  const detail = formatNetworkDetail({
    requestId: 'r9',
    method: 'POST',
    url: 'http://localhost/api/login',
    startedAt: 0,
    status: 401,
    resourceType: 'fetch',
    requestHeaders: { Authorization: 'Bearer tok-1234', 'Content-Type': 'application/json' },
    requestBody: '{"user":"a"}',
    responseHeaders: { 'set-cookie': 'sess=abcd1234' },
    responseBody: '{"message":"unauthorized"}',
  })
  assert.match(detail, /request headers:/)
  assert.match(detail, /Authorization: \*\*\*\(…1234\)/)
  assert.match(detail, /request body:/)
  assert.match(detail, /"user":"a"/)
  assert.match(detail, /response headers:/)
  assert.match(detail, /set-cookie: \*\*\*\(…1234\)/)
  assert.doesNotMatch(detail, /Bearer tok-1234/)
})

test('shouldCaptureResponseBody for xhr/fetch and 4xx+', () => {
  assert.equal(shouldCaptureResponseBody('xhr', 200), true)
  assert.equal(shouldCaptureResponseBody('fetch', 200), true)
  assert.equal(shouldCaptureResponseBody('document', 404), true)
  assert.equal(shouldCaptureResponseBody('document', 200), false)
})

test('truncateResponseBody caps at 2048 chars', () => {
  const long = 'x'.repeat(3000)
  const { body, truncated } = truncateResponseBody(long)
  assert.equal(body.length, 2048)
  assert.equal(truncated, true)
})

test('LogCapture url_filter and api_only filters', () => {
  const cap = new LogCapture()
  cap.startRequest('a', 'GET', 'http://localhost/static/app.js', Date.now(), 'script')
  cap.completeRequest('a', 200)
  cap.startRequest('b', 'POST', 'http://localhost/api/data', Date.now(), 'fetch')
  cap.completeRequest('b', 500)
  cap.attachResponseBody('b', '{"err":true}', 'application/json')

  const api = cap.getNetwork({ apiOnly: true })
  assert.equal(api.length, 1)
  assert.equal(api[0]!.requestId, 'b')

  const filtered = cap.getNetwork({ urlFilter: '/api/' })
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0]!.requestId, 'b')
})

test('LogCapture failed_only keeps 4xx/5xx and network failures', () => {
  const cap = new LogCapture()
  cap.startRequest('a', 'GET', 'http://localhost/ok')
  cap.completeRequest('a', 200)
  cap.startRequest('b', 'POST', 'http://localhost/bad')
  cap.completeRequest('b', 500)
  cap.failRequest('c', 'GET', 'http://localhost/down', 'aborted')

  const failed = cap.getNetwork({ failedOnly: true })
  assert.equal(failed.length, 2)
})

test('LogCapture getByRequestId returns entry with body', () => {
  const cap = new LogCapture()
  cap.startRequest('x', 'GET', '/')
  cap.completeRequest('x', 200)
  cap.attachResponseBody('x', 'ok', 'text/plain')
  const entry = cap.getByRequestId('x')
  assert.equal(entry?.responseBody, 'ok')
})

test('LogCapture clear wipes buffers', () => {
  const cap = new LogCapture()
  cap.addConsole('log', 'hi')
  cap.startRequest('x', 'GET', '/')
  cap.clear()
  assert.equal(cap.getConsole().length, 0)
  assert.equal(cap.getNetwork().length, 0)
})

test('maskSecretValue keeps only the last 4 chars', () => {
  assert.equal(maskSecretValue('abcdef123456'), '***(…3456)')
  assert.equal(maskSecretValue('abc'), '***(…)')
})

test('formatCookies masks values and shows flags', () => {
  const out = formatCookies([
    { name: 'session', value: 'abcdef123456', domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
    { name: 'theme', value: 'dark' },
  ])
  const lines = out.split('\n')
  assert.equal(lines[0], 'session=***(…3456)  [localhost/; httpOnly; secure; sameSite=Lax]')
  assert.equal(lines[1], 'theme=***(…)')
  assert.ok(!out.includes('abcdef123456'), 'raw cookie value must not leak')
})

test('formatCookies handles empty list', () => {
  assert.equal(formatCookies([]), '(no cookies)')
})

test('formatStorage masks secret-looking keys, shows the rest', () => {
  const out = formatStorage({ authToken: 'zzzzsecret9999', theme: 'dark' })
  const lines = out.split('\n')
  assert.ok(lines.some((l) => l === 'authToken: ***(…9999)'), 'sensitive key value masked')
  assert.ok(lines.some((l) => l === 'theme: dark'), 'non-sensitive value shown')
  assert.ok(!out.includes('zzzzsecret9999'), 'raw secret must not leak')
})

test('parseNetworkLine round-trips completed/pending/failed lines', () => {
  const ok = parseNetworkLine(formatNetworkLine({ requestId: 'r1', method: 'POST', url: 'http://localhost/api/x', status: 500, durationMs: 42, startedAt: 0, resourceType: 'fetch' }))
  assert.deepEqual(ok, { dir: 'ok', status: 500, method: 'POST', url: 'http://localhost/api/x', durationMs: 42, resourceType: 'fetch' })

  const pending = parseNetworkLine(formatNetworkLine({ requestId: 'r2', method: 'GET', url: 'http://localhost/', startedAt: 0, resourceType: 'document' }))
  assert.deepEqual(pending, { dir: 'pending', method: 'GET', url: 'http://localhost/', resourceType: 'document' })

  const failed = parseNetworkLine(formatNetworkLine({ requestId: 'r3', method: 'GET', url: 'http://localhost/down', failed: true, errorText: 'aborted', startedAt: 0 }))
  assert.deepEqual(failed, { dir: 'failed', method: 'GET', url: 'http://localhost/down', errorText: 'aborted', resourceType: undefined })
})

test('parseNetworkLine returns null for non-network lines', () => {
  assert.equal(parseNetworkLine('[error] boom'), null)
  assert.equal(parseNetworkLine('  body: {"x":1}'), null)
  assert.equal(parseNetworkLine('(no matching network activity)'), null)
  assert.equal(parseNetworkLine('session=***(…3456)'), null)
})

test('formatStorage truncates long non-sensitive values and reports empty', () => {
  assert.equal(formatStorage({}), '(empty)')
  const long = 'x'.repeat(300)
  const out = formatStorage({ blob: long })
  assert.ok(out.includes('… (truncated)'))
  assert.ok(out.length < long.length + 30)
})
