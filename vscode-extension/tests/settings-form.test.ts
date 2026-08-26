import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCheckpointTurns, parseDefaultDomain, parseDefaultModel, wireApproval } from '../webview-ui/src/settings-form.ts'

test('parseCheckpointTurns: 非负整数通过，其它失败', () => {
  assert.deepEqual(parseCheckpointTurns('0'), { ok: true, value: 0 })
  assert.deepEqual(parseCheckpointTurns('20'), { ok: true, value: 20 })
  assert.deepEqual(parseCheckpointTurns(' 8 '), { ok: true, value: 8 })
  assert.equal(parseCheckpointTurns('').ok, false)
  assert.equal(parseCheckpointTurns('-1').ok, false)
  assert.equal(parseCheckpointTurns('1.5').ok, false)
  assert.equal(parseCheckpointTurns('abc').ok, false)
})

test('wireApproval: 隐档 auto-accept 显示为自动；未知回退监督', () => {
  assert.equal(wireApproval('manual'), 'manual')
  assert.equal(wireApproval('auto-safe'), 'auto-safe')
  assert.equal(wireApproval('dangerously-skip-permissions'), 'dangerously-skip-permissions')
  assert.equal(wireApproval('auto-accept'), 'auto-safe')
  assert.equal(wireApproval('suggest'), 'manual')
  assert.equal(wireApproval(''), 'auto-safe')
})

test('parseDefaultModel: provider:modelId，modelId 可含斜杠', () => {
  assert.deepEqual(parseDefaultModel('deepseek:deepseek-v4-pro'), { ok: true, value: 'deepseek:deepseek-v4-pro' })
  assert.deepEqual(parseDefaultModel(' siliconflow:deepseek-ai/DeepSeek-V4-Pro '), {
    ok: true,
    value: 'siliconflow:deepseek-ai/DeepSeek-V4-Pro',
  })
  assert.equal(parseDefaultModel('').ok, false)
  assert.equal(parseDefaultModel('nocolon').ok, false)
  assert.equal(parseDefaultModel(':only-model').ok, false)
  assert.equal(parseDefaultModel('provider:').ok, false)
})

test('parseDefaultDomain: auto 恒过；有清单时拒未知 id', () => {
  assert.deepEqual(parseDefaultDomain('auto'), { ok: true, value: 'auto' })
  assert.deepEqual(parseDefaultDomain(' tianshu '), { ok: true, value: 'tianshu' })
  assert.deepEqual(parseDefaultDomain('tianshu', ['tianshu', 'pojun']), { ok: true, value: 'tianshu' })
  assert.equal(parseDefaultDomain('').ok, false)
  assert.equal(parseDefaultDomain('nope', ['tianshu']).ok, false)
})
