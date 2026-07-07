import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ConnectFlow } from '../connect-flow.js'

test('provider step lists built-in presets plus a custom option', () => {
  const flow = new ConnectFlow()
  const view = flow.view()
  assert.equal(view.kind, 'choice')
  const ids = (view.options ?? []).map(o => o.id)
  assert.ok(ids.includes('deepseek'))
  assert.ok(ids.includes('custom'))
  // Recommended preset (deepseek) sorts first.
  assert.equal(view.options?.[0]?.id, 'deepseek')
  assert.equal(view.options?.[0]?.recommended, true)
  // Preset options expose their base URL as the description.
  const deepseek = view.options?.find(o => o.id === 'deepseek')
  assert.match(deepseek?.description ?? '', /^https?:\/\//)
})

test('preset path: pick provider then paste key commits a preset setup', () => {
  const flow = new ConnectFlow()
  const afterPick = flow.submitChoice('deepseek')
  assert.equal(afterPick.kind, 'next')
  const keyView = flow.view()
  assert.equal(keyView.kind, 'input')
  assert.equal(keyView.masked, true)

  const result = flow.submitInput('sk-test-123')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit') return
  assert.equal(result.commit.mode, 'preset')
  if (result.commit.mode !== 'preset') return
  assert.equal(result.commit.setup.providerName, 'deepseek')
  assert.equal(result.commit.setup.preset, 'deepseek')
  assert.equal(result.commit.setup.apiKey, 'sk-test-123')
  assert.equal(result.commit.setup.makeDefault, true)
})

test('preset path: empty key is rejected without leaving the step', () => {
  const flow = new ConnectFlow()
  flow.submitChoice('glm')
  const result = flow.submitInput('   ')
  assert.equal(result.kind, 'error')
  assert.equal(flow.view().kind, 'input')
})

test('oauth preset commits immediately without asking for a key', () => {
  const flow = new ConnectFlow()
  const result = flow.submitChoice('codex')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit') return
  assert.equal(result.commit.mode, 'preset')
  if (result.commit.mode !== 'preset') return
  assert.equal(result.commit.setup.apiKey, undefined)
  assert.match(result.summary, /OAuth|login|登录/i)
})

test('custom path walks url → model → context → key and commits a custom provider', () => {
  const flow = new ConnectFlow()
  flow.submitChoice('custom')
  assert.equal(flow.view().title, '输入服务商 API 地址')

  assert.equal(flow.submitInput('https://api.example.com/v1').kind, 'next')
  assert.equal(flow.view().title, '输入模型型号')

  assert.equal(flow.submitInput('my-model-v1').kind, 'next')
  assert.equal(flow.view().title.includes('上下文'), true)

  // Blank context uses the default.
  assert.equal(flow.submitInput('').kind, 'next')
  assert.equal(flow.view().masked, true)

  const result = flow.submitInput('sk-custom')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit' || result.commit.mode !== 'custom') return
  assert.equal(result.commit.baseUrl, 'https://api.example.com/v1')
  assert.equal(result.commit.apiKey, 'sk-custom')
  assert.equal(result.commit.model.id, 'my-model-v1')
  assert.equal(result.commit.model.contextWindow, 131072)
  assert.equal(result.commit.providerName, 'custom-my-model-v1')
  assert.equal(result.commit.makeDefault, true)
})

test('custom path rejects a non-url base address', () => {
  const flow = new ConnectFlow()
  flow.submitChoice('custom')
  const result = flow.submitInput('not-a-url')
  assert.equal(result.kind, 'error')
  assert.equal(flow.view().title, '输入服务商 API 地址')
})

test('custom path honours an explicit context window and caps output tokens', () => {
  const flow = new ConnectFlow()
  flow.submitChoice('custom')
  flow.submitInput('https://api.example.com/v1')
  flow.submitInput('deepseek-v4')
  flow.submitInput('1000000')
  const result = flow.submitInput('sk-x')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit' || result.commit.mode !== 'custom') return
  assert.equal(result.commit.model.contextWindow, 1000000)
  assert.equal(result.commit.model.maxTokens, 64000)
})

test('custom path rejects a non-numeric context window', () => {
  const flow = new ConnectFlow()
  flow.submitChoice('custom')
  flow.submitInput('https://api.example.com/v1')
  flow.submitInput('m')
  const result = flow.submitInput('abc')
  assert.equal(result.kind, 'error')
})
