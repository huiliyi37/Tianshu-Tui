import { test } from 'node:test'
import assert from 'node:assert/strict'
import { APPLY_EDIT_AUTO_ACCEPT_MS } from '../src/delegation/pending-policy.ts'

test('委托编辑不因超时自动接受（0 = 等 CodeLens）', () => {
  assert.equal(APPLY_EDIT_AUTO_ACCEPT_MS, 0)
})
