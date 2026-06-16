import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDomainPickerEntries } from '../domain-picker-entries.js'
import type { ActiveStarDomain } from '../star-domain.js'

test('Auto is current when selection is undefined', () => {
  const entries = buildDomainPickerEntries(undefined)
  assert.equal(entries[0]!.key, 'auto')
  assert.equal(entries[0]!.current, true)
  assert.equal(entries[1]!.key, 'off')
  assert.equal(entries[1]!.current, false)
})

test('Off is current when selection is null', () => {
  const entries = buildDomainPickerEntries(null)
  assert.equal(entries.find((e) => e.key === 'off')!.current, true)
  assert.equal(entries.find((e) => e.key === 'auto')!.current, false)
})

test('a pinned domain is the only current entry', () => {
  const pinned: ActiveStarDomain = { id: 'tianshu', name: '天枢', volatileBlock: '...', motto: 'm' }
  const entries = buildDomainPickerEntries(pinned)
  const current = entries.filter((e) => e.current)
  assert.equal(current.length, 1)
  assert.equal(current[0]!.key, 'tianshu')
})

test('every domain entry carries a non-empty essence + meta', () => {
  const entries = buildDomainPickerEntries(undefined)
  const tianshu = entries.find((e) => e.key === 'tianshu')!
  assert.ok(tianshu.essence.length > 0)
  assert.ok(tianshu.meta.length > 0)
})
