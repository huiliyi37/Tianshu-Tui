import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RUNTIME_BUNDLED, SCAN_ALLOWED, verifyConsistency } from '../external-deps.js'

test('RUNTIME_BUNDLED ⊆ SCAN_ALLOWED — 随包分发必在扫描允许集内', () => {
  const allowed = new Set(SCAN_ALLOWED)
  const missing = RUNTIME_BUNDLED.filter((p) => !allowed.has(p))
  assert.deepEqual(missing, [], `RUNTIME_BUNDLED 中 ${missing.join(', ')} 未列入 SCAN_ALLOWED`)
})

test('两清单无重复条目', () => {
  const dup = (list) => {
    const seen = new Set()
    return list.filter((item) => seen.has(item) || (seen.add(item), false))
  }
  assert.deepEqual(dup(RUNTIME_BUNDLED), [], 'RUNTIME_BUNDLED 重复')
  assert.deepEqual(dup(SCAN_ALLOWED), [], 'SCAN_ALLOWED 重复')
})

test('verifyConsistency 通过合法清单', () => {
  assert.doesNotThrow(() => verifyConsistency())
})

test('verifyConsistency 拒绝 RUNTIME_BUNDLED 漏列进 SCAN_ALLOWED', () => {
  assert.throws(
    () => verifyConsistency({ runtimeBundled: ['leaked-pkg'], scanAllowed: [] }),
    /RUNTIME_BUNDLED ⊆ SCAN_ALLOWED/,
  )
})

test('verifyConsistency 拒绝重复条目', () => {
  assert.throws(
    () => verifyConsistency({ runtimeBundled: ['a', 'a'], scanAllowed: ['a'] }),
    /重复条目 'a'/,
  )
})
