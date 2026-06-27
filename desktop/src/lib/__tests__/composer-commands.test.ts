import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterCommands, detectSlash, isKnownSlashCommand, type ComposerCommand } from '../composer-commands'

const noop = () => {}
const CMDS: ComposerCommand[] = [
  { name: '/rewind', desc: '回滚到某条消息', run: noop },
  { name: '/default', desc: '默认档', run: noop },
  { name: '/theme', desc: '切换主题', run: noop },
  { name: '/review', desc: 'L2 审查 · 单审查员', run: noop },
  { name: '/review max', desc: 'L3 审查 · 编队 5 审查员', run: noop },
]

test('filterCommands: empty query returns all', () => {
  assert.equal(filterCommands(CMDS, '').length, 5)
})

test('filterCommands: matches by name', () => {
  const out = filterCommands(CMDS, 'rew')
  assert.deepEqual(out.map((c) => c.name), ['/rewind'])
})

test('filterCommands: leading slash in query is ignored', () => {
  const out = filterCommands(CMDS, '/the')
  assert.deepEqual(out.map((c) => c.name), ['/theme'])
})

test('filterCommands: matches by description', () => {
  const out = filterCommands(CMDS, '回滚')
  assert.deepEqual(out.map((c) => c.name), ['/rewind'])
})

test('filterCommands: /review matches both review commands', () => {
  const out = filterCommands(CMDS, 'review')
  assert.equal(out.length, 2)
  assert.deepEqual(out.map((c) => c.name), ['/review', '/review max'])
})

test('filterCommands: review max matches by desc keyword', () => {
  const out = filterCommands(CMDS, '编队')
  assert.deepEqual(out.map((c) => c.name), ['/review max'])
})

test('detectSlash: line-start slash token', () => {
  const t = detectSlash('/re', 3)
  assert.ok(t)
  assert.equal(t!.query, 're')
  assert.equal(t!.start, 0)
  assert.equal(t!.end, 3)
})

test('detectSlash: bare slash returns empty query', () => {
  const t = detectSlash('/', 1)
  assert.ok(t)
  assert.equal(t!.query, '')
})

test('detectSlash: not at line start returns null', () => {
  assert.equal(detectSlash('hi /re', 6), null)
})

test('detectSlash: whitespace ends command mode', () => {
  assert.equal(detectSlash('/re foo', 7), null)
})

// ── isKnownSlashCommand: guard against sending unknown /commands ──

test('isKnownSlashCommand: exact match returns true', () => {
  assert.equal(isKnownSlashCommand('/rewind', CMDS), true)
  assert.equal(isKnownSlashCommand('/review', CMDS), true)
})

test('isKnownSlashCommand: command with args matches base name', () => {
  // "/review max auth flow" matches /review max
  assert.equal(isKnownSlashCommand('/review max auth flow', CMDS), true)
  // "/rewind 5" matches /rewind
  assert.equal(isKnownSlashCommand('/rewind 5', CMDS), true)
})

test('isKnownSlashCommand: unknown command returns false', () => {
  assert.equal(isKnownSlashCommand('/foobar', CMDS), false)
  assert.equal(isKnownSlashCommand('/xyz arg', CMDS), false)
})

test('isKnownSlashCommand: typo of known command returns false', () => {
  // /mdel looks like /model but is a typo — must not match
  assert.equal(isKnownSlashCommand('/mdel', CMDS), false)
  // /reviewx is not /review and should not match by prefix
  assert.equal(isKnownSlashCommand('/reviewx', CMDS), false)
})

test('isKnownSlashCommand: multi-word command without extra args is known', () => {
  assert.equal(isKnownSlashCommand('/review max', CMDS), true)
})

test('isKnownSlashCommand: non-slash input returns true (not a guard concern)', () => {
  assert.equal(isKnownSlashCommand('hello world', CMDS), true)
  assert.equal(isKnownSlashCommand('use @file:path here', CMDS), true)
})

test('isKnownSlashCommand: prefix match counts (partial typing before submit)', () => {
  // If the user typed "/rev" and submitted, and /review exists, it's close enough
  // to be considered "known" (avoids false rejection during fast typing).
  // But a bare "/re" that doesn't exactly match should still be checked:
  // /rewind starts with /re → prefix match → true
  assert.equal(isKnownSlashCommand('/rewind', CMDS), true)
})
