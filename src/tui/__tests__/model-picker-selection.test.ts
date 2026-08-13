import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isCurrentModelSelection } from '../model-picker-selection.js'

test('同名模型只在 provider 与 model id 都匹配时标记为 current', () => {
  assert.equal(isCurrentModelSelection('first', 'shared-model', 'second', 'shared-model'), false)
  assert.equal(isCurrentModelSelection('second', 'shared-model', 'second', 'shared-model'), true)
})

test('provider 相同但 model id 不同时不标记为 current', () => {
  assert.equal(isCurrentModelSelection('second', 'other-model', 'second', 'shared-model'), false)
})
