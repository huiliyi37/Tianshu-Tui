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

  // Vision choice step (added between context and apikey).
  assert.equal(flow.view().kind, 'choice')
  flow.submitChoice('no')
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
  assert.equal(result.commit.model.supportsVision, undefined, '「否」不标视觉')
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
  flow.submitChoice('yes')
  const result = flow.submitInput('sk-x')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit' || result.commit.mode !== 'custom') return
  assert.equal(result.commit.model.contextWindow, 1000000)
  assert.equal(result.commit.model.maxTokens, 64000)
  assert.equal(result.commit.model.supportsVision, true, '「是」标视觉')
})

test('custom path rejects a non-numeric context window', () => {
  const flow = new ConnectFlow()
  flow.submitChoice('custom')
  flow.submitInput('https://api.example.com/v1')
  flow.submitInput('m')
  const result = flow.submitInput('abc')
  assert.equal(result.kind, 'error')
})

test('add-model option is hidden when no providers are configured', () => {
  const flow = new ConnectFlow()
  const ids = (flow.view().options ?? []).map(o => o.id)
  assert.ok(!ids.includes('existing'), 'no configured providers → no add-model option')
})

test('add-model option appears when providers exist', () => {
  const flow = new ConnectFlow([{ name: 'deepseek', label: 'DeepSeek', modelCount: 2 }])
  const ids = (flow.view().options ?? []).map(o => o.id)
  assert.ok(ids.includes('existing'))
})

test('add-model path: pick provider → model → context → vision commits add-model', () => {
  const flow = new ConnectFlow([
    { name: 'deepseek', label: 'DeepSeek', modelCount: 2 },
    { name: 'glm', label: 'GLM', modelCount: 3 },
  ])
  // provider step → add-model branch
  assert.equal(flow.submitChoice('existing').kind, 'next')
  const pickView = flow.view()
  assert.equal(pickView.kind, 'choice')
  assert.equal(pickView.title, '为哪个服务商添加模型？')
  const pickIds = (pickView.options ?? []).map(o => o.id)
  assert.deepEqual(pickIds, ['deepseek', 'glm'])

  // pick the provider → straight to model id (no URL step)
  assert.equal(flow.submitChoice('glm').kind, 'next')
  assert.equal(flow.view().title, '输入模型型号')
  assert.equal(flow.view().stepLabel, '步骤 1 / 3')

  assert.equal(flow.submitInput('glm-vision-x').kind, 'next')
  assert.equal(flow.view().stepLabel, '步骤 2 / 3')
  assert.equal(flow.submitInput('131072').kind, 'next')
  assert.equal(flow.view().stepLabel, '步骤 3 / 3')

  // vision choice ends the flow — no API key step for an existing provider
  const result = flow.submitChoice('yes')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit') return
  assert.equal(result.commit.mode, 'add-model')
  if (result.commit.mode !== 'add-model') return
  assert.equal(result.commit.providerName, 'glm')
  assert.equal(result.commit.model.id, 'glm-vision-x')
  assert.equal(result.commit.model.contextWindow, 131072)
  assert.equal(result.commit.model.maxTokens, 64000)
  assert.equal(result.commit.model.supportsVision, true)
  assert.match(result.summary, /glm.*glm-vision-x/)
})

test('add-model path: vision "no" leaves supportsVision absent', () => {
  const flow = new ConnectFlow([{ name: 'deepseek', modelCount: 1 }])
  flow.submitChoice('existing')
  flow.submitChoice('deepseek')
  flow.submitInput('text-only-x')
  flow.submitInput('')
  const result = flow.submitChoice('no')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit' || result.commit.mode !== 'add-model') return
  assert.equal(result.commit.model.supportsVision, undefined)
})

test('add-model path: unknown provider choice is rejected', () => {
  const flow = new ConnectFlow([{ name: 'deepseek', modelCount: 1 }])
  flow.submitChoice('existing')
  const result = flow.submitChoice('ghost')
  assert.equal(result.kind, 'error')
  assert.equal(flow.view().kind, 'choice')
})

test('diy path still shows 5-step labels after the change', () => {
  const flow = new ConnectFlow()
  flow.submitChoice('custom')
  flow.submitInput('https://api.example.com/v1')
  assert.equal(flow.view().stepLabel, '步骤 2 / 5')
  flow.submitInput('m')
  assert.equal(flow.view().stepLabel, '步骤 3 / 5')
  flow.submitInput('')
  assert.equal(flow.view().stepLabel, '步骤 4 / 5')
  flow.submitChoice('no')
  assert.equal(flow.view().stepLabel, '步骤 5 / 5')
})
