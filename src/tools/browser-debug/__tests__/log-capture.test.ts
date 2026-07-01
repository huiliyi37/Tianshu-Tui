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
