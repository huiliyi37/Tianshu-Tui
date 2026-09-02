import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDomainPickerEntries, DOMAIN_SHARED_CAPABILITY_NOTE } from '../domain-picker-entries.js'
import type { ActiveStarDomain } from '../star-domain.js'

test('Auto is current when selection is undefined', () => {
  const entries = buildDomainPickerEntries(undefined)
  assert.equal(entries[0]!.key, 'auto')
  assert.equal(entries[0]!.current, true)
  // First domain entry follows Auto directly (Off removed).
  assert.notEqual(entries[1]!.key, 'off')
  assert.match(entries[0]!.essence, /回退天权/)
  assert.match(entries[0]!.meta, /关键词自动匹配/)
})

test('Off option is removed — no picker entry has key "off"', () => {
  const entries = buildDomainPickerEntries(undefined)
  assert.equal(entries.find((e) => e.key === 'off'), undefined)
})

test('null selection (env kill switch) reflects as Auto-current (no Off entry)', () => {
  const entries = buildDomainPickerEntries(null)
  assert.equal(entries.find((e) => e.key === 'off'), undefined)
  assert.equal(entries.find((e) => e.key === 'auto')!.current, true)
})

test('a pinned domain is the only current entry', () => {
  const pinned: ActiveStarDomain = { id: 'tianshu', name: '天枢', volatileBlock: '...', motto: 'm', courageThreshold: 0.65 }
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

test('every built-in entry carries a plain explanation and Auto carries its own', () => {
  const entries = buildDomainPickerEntries(undefined)
  for (const entry of entries) {
    assert.ok(entry.plain && entry.plain.length >= 10, `${entry.key}: plain 特质说明缺失或过短`)
  }
  assert.match(entries[0]!.plain!, /关键词/)
  // 共有能力只放外层，不再在每个域里重复。
  assert.match(DOMAIN_SHARED_CAPABILITY_NOTE, /通用工程全量保留/)
  for (const entry of entries.slice(1)) {
    assert.doesNotMatch(entry.plain!, /通用工程全量保留/)
    assert.ok(entry.plain!.length >= 30, `${entry.key}: 去掉共有前缀后应保留足够具体的特质信息`)
  }
  assert.match(entries.find((e) => e.key === 'tianliang')!.plain!, /先核对计划/)
  assert.match(entries.find((e) => e.key === 'wenqu')!.plain!, /功能一样不少/)
})

test('built-in domain entries carry founder + expertise from genesis data', () => {
  const entries = buildDomainPickerEntries(undefined)
  const tianshu = entries.find((e) => e.key === 'tianshu')!
  assert.equal(tianshu.founder, 'GPT-5.5')
  assert.ok(tianshu.expertise && tianshu.expertise.length >= 10)
  const auto = entries.find((e) => e.key === 'auto')!
  assert.equal(auto.founder, undefined, 'Auto 无创始星')
})
