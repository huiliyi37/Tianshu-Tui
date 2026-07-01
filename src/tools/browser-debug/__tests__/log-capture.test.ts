import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LogCapture,
  normalizeConsoleLevel,
  formatConsoleLine,
  formatNetworkLine,
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

test('LogCapture failed_only keeps 4xx/5xx and network failures', () => {
  const cap = new LogCapture()
  cap.startRequest('a', 'GET', 'http://localhost/ok')
  cap.completeRequest('a', 200)
  cap.startRequest('b', 'POST', 'http://localhost/bad')
  cap.completeRequest('b', 500)
  cap.failRequest('c', 'GET', 'http://localhost/down', 'aborted')

  const all = cap.getNetwork()
  assert.equal(all.length, 3)
  const failed = cap.getNetwork(true)
  assert.equal(failed.length, 2)
  assert.equal(failed.some((e) => e.status === 500), true)
  assert.equal(failed.some((e) => e.failed), true)
})

test('LogCapture clear wipes buffers', () => {
  const cap = new LogCapture()
  cap.addConsole('log', 'hi')
  cap.startRequest('x', 'GET', '/')
  cap.clear()
  assert.equal(cap.getConsole().length, 0)
  assert.equal(cap.getNetwork().length, 0)
})
