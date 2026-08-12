import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ConnectFlow, suggestProviderName } from '../connect-flow.js'
import type { ProbeReport } from '../../api/provider-probe.js'

function report(overrides: Partial<ProbeReport> = {}): ProbeReport {
  return {
    models: [],
    modelsOk: true,
    completionOk: true,
    hints: {},
    errors: [],
    ...overrides,
  }
}

/** Drive the DIY flow to the probe request and return it. */
function toProbe(flow: ConnectFlow, { url = 'https://api.example.com/v1', key = 'sk-x' } = {}) {
  flow.submitChoice('custom')
  flow.submitInput(url)
  const result = flow.submitInput(key)
  assert.equal(result.kind, 'probe')
  if (result.kind !== 'probe') throw new Error('unreachable')
  assert.equal(flow.view().kind, 'busy')
  return result
}

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

test('diy path: url → key emits a probe request (empty key allowed for local endpoints)', () => {
  const flow = new ConnectFlow()
  const probe = toProbe(flow)
  assert.equal(probe.baseUrl, 'https://api.example.com/v1')
  assert.equal(probe.apiKey, 'sk-x')
  assert.equal(probe.protocol, 'openai')

  const local = new ConnectFlow()
  local.submitChoice('custom')
  local.submitInput('http://127.0.0.1:11434/v1')
  const localProbe = local.submitInput('')
  assert.equal(localProbe.kind, 'probe')
  if (localProbe.kind === 'probe') assert.equal(localProbe.apiKey, undefined)
})

test('diy path rejects a non-url base address', () => {
  const flow = new ConnectFlow()
  flow.submitChoice('custom')
  const result = flow.submitInput('not-a-url')
  assert.equal(result.kind, 'error')
  assert.equal(flow.view().title, '输入服务商 API 地址')
})

test('diy path: probed models become a multi-select with metadata backfill', () => {
  const flow = new ConnectFlow()
  toProbe(flow)
  const applied = flow.applyProbe(report({
    models: ['deepseek-v4-pro', 'totally-new-model'],
    hints: { reasoningSplit: true },
  }))
  assert.equal(applied.kind, 'next')
  const view = flow.view()
  assert.equal(view.kind, 'multi-choice')
  assert.equal(view.options?.length, 2)
  // All models checked by default.
  assert.deepEqual(view.options?.map(o => o.checked), [true, true])
  // Known model shows its canonical match; unknown shows the TODO hint.
  assert.match(view.options?.[0]?.description ?? '', /deepseek-v4-pro/)
  assert.match(view.options?.[1]?.description ?? '', /未知模型/)

  // Toggle one off.
  assert.equal(flow.toggle('0').kind, 'next')
  assert.deepEqual(flow.view().options?.map(o => o.checked), [false, true])

  // Empty-after-toggle guard only fires when nothing is checked.
  flow.toggle('1')
  const empty = flow.confirm()
  assert.equal(empty.kind, 'error')
  flow.toggle('1')

  const confirmed = flow.confirm()
  assert.equal(confirmed.kind, 'next')

  // Thinking question — hint pre-recommends the split option.
  const thinkingView = flow.view()
  assert.equal(thinkingView.kind, 'choice')
  const split = thinkingView.options?.find(o => o.id === 'split')
  assert.equal(split?.recommended, true)
  assert.equal(flow.submitChoice('split').kind, 'next')

  // Provider name — blank uses the host-derived default.
  const nameView = flow.view()
  assert.equal(nameView.kind, 'input')
  assert.equal(nameView.defaultValue, 'example-com')
  const result = flow.submitInput('')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit' || result.commit.mode !== 'custom') return
  assert.equal(result.commit.providerName, 'example-com')
  assert.equal(result.commit.baseUrl, 'https://api.example.com/v1')
  assert.equal(result.commit.apiKey, 'sk-x')
  assert.equal(result.commit.makeDefault, true)
  assert.equal(result.commit.models.length, 1)
  const model = result.commit.models[0]!
  // RAW endpoint id kept as the config id; alias-table metadata backfilled.
  assert.equal(model.id, 'totally-new-model')
  // Unknown model picks up the thinking answer.
  assert.deepEqual(model.capabilities, { reasoningSplit: true })
})

test('diy path: known model backfills contextWindow and keeps its own capabilities', () => {
  const flow = new ConnectFlow()
  toProbe(flow)
  flow.applyProbe(report({ models: ['deepseek-v4-pro'] }))
  flow.confirm()
  flow.submitChoice('split')
  const result = flow.submitInput('my-relay')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit' || result.commit.mode !== 'custom') return
  assert.equal(result.commit.providerName, 'my-relay')
  const model = result.commit.models[0]!
  assert.equal(model.id, 'deepseek-v4-pro')
  assert.equal(model.contextWindow, 1_000_000)
  assert.equal(model.maxTokens, 384_000)
})

test('diy path: probe with no models but working completion falls back to manual entry', () => {
  const flow = new ConnectFlow()
  toProbe(flow)
  flow.applyProbe(report({ models: [], modelsOk: false, errors: ['models endpoint 404'] }))
  const view = flow.view()
  assert.equal(view.kind, 'input')
  assert.match(view.title, /输入模型型号/)

  assert.equal(flow.submitInput('my-model-v1').kind, 'next')
  assert.equal(flow.submitChoice('none').kind, 'next')
  const result = flow.submitInput('my-relay')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit' || result.commit.mode !== 'custom') return
  // Manual path ships a bare id — registerProvider materializes sizes.
  assert.deepEqual(result.commit.models, [{ id: 'my-model-v1' }])
})

test('diy path: total probe failure offers manual entry or going back', () => {
  const flow = new ConnectFlow()
  toProbe(flow)
  flow.applyProbe(report({ models: [], modelsOk: false, completionOk: false, errors: ['auth-failed'] }))
  const view = flow.view()
  assert.equal(view.kind, 'choice')
  assert.match(view.subtitle ?? '', /auth-failed/)

  // back → url step
  assert.equal(flow.submitChoice('back').kind, 'next')
  assert.equal(flow.view().title, '输入服务商 API 地址')
})

test('diy path: probeFailed (network error) routes to the probe-failed choice', () => {
  const flow = new ConnectFlow()
  toProbe(flow)
  const result = flow.probeFailed('fetch timeout')
  assert.equal(result.kind, 'next')
  const view = flow.view()
  assert.equal(view.kind, 'choice')
  assert.match(view.subtitle ?? '', /fetch timeout/)
  // manual → model entry
  assert.equal(flow.submitChoice('manual').kind, 'next')
  assert.equal(flow.view().kind, 'input')
})

test('diy path: preset name is rejected at the name step', () => {
  const flow = new ConnectFlow()
  toProbe(flow)
  flow.applyProbe(report({ models: ['some-model'] }))
  flow.confirm()
  flow.submitChoice('none')
  const result = flow.submitInput('deepseek')
  assert.equal(result.kind, 'error')
  assert.match((result as { message: string }).message, /内置服务商/)
})

test('diy path: invalid provider name characters rejected', () => {
  const flow = new ConnectFlow()
  toProbe(flow)
  flow.applyProbe(report({ models: ['some-model'] }))
  flow.confirm()
  flow.submitChoice('none')
  const result = flow.submitInput('My Provider!')
  assert.equal(result.kind, 'error')
})

test('suggestProviderName derives a slug from the host', () => {
  assert.equal(suggestProviderName('https://api.example.com/v1'), 'example-com')
  assert.equal(suggestProviderName('http://127.0.0.1:3000/v1'), '127-0-0-1')
  assert.equal(suggestProviderName('not a url'), 'custom')
  // Host is lowercased by the URL parser, so mixed case normalizes too.
  assert.equal(suggestProviderName('https://API.Example.COM/v1'), 'example-com')
  // Port never leaks into the slug (hostname excludes it).
  assert.equal(suggestProviderName('http://localhost:11434/v1'), 'localhost')
  // Multi-level subdomains keep everything after api.
  assert.equal(suggestProviderName('https://api.gw.example.co.uk/v1'), 'gw-example-co-uk')
  // Host without the api. prefix passes through as-is.
  assert.equal(suggestProviderName('https://relay.internal.lan/v1'), 'relay-internal-lan')
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
