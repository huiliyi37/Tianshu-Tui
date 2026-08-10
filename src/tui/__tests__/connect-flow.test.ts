import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ConnectFlow, suggestProviderName } from '../connect-flow.js'
import { PROVIDER_PRESETS, providerPresetKeys } from '../../config/provider-presets.js'
import type { ProbeReport } from '../../api/provider-probe.js'
import type { ConnectDraft } from '../connect-draft.js'

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

test('preset path: 6 steps — key → endpoint → models → capability → connectivity → save', () => {
  const flow = new ConnectFlow()
  assert.equal(flow.submitChoice('deepseek').kind, 'next')
  const keyView = flow.view()
  assert.equal(keyView.kind, 'input')
  assert.equal(keyView.masked, true)
  assert.equal(keyView.stepLabel, '步骤 2 / 6')

  // [2/6] Endpoint confirm: official URL prefilled, Enter accepts, fires probe.
  assert.equal(flow.submitInput('sk-test-123').kind, 'next')
  const urlView = flow.view()
  assert.equal(urlView.kind, 'input')
  assert.match(urlView.title, /服务地址/)
  assert.equal(urlView.defaultValue, PROVIDER_PRESETS.deepseek.provider.baseUrl)
  assert.equal(urlView.stepLabel, '步骤 2 / 6')
  const probe = flow.submitInput('')
  assert.equal(probe.kind, 'probe')
  if (probe.kind !== 'probe') return
  assert.equal(probe.baseUrl, PROVIDER_PRESETS.deepseek.provider.baseUrl)
  assert.equal(probe.apiKey, 'sk-test-123')
  assert.equal(probe.probeModel, 'deepseek-v4-pro')

  // [3/6] Model selection — preset templates checked by default.
  assert.equal(flow.applyProbe(report({ models: ['deepseek-v4-pro'], latencyMs: 132 })).kind, 'next')
  const modelsView = flow.view()
  assert.equal(modelsView.kind, 'multi-choice')
  assert.equal(modelsView.stepLabel, '步骤 3 / 6')
  assert.deepEqual(modelsView.options?.map(o => o.label), ['deepseek-v4-pro', 'deepseek-v4-flash'])
  assert.deepEqual(modelsView.options?.map(o => o.checked), [true, true])
  assert.match(modelsView.options?.[0]?.description ?? '', /预设/)

  // [4/6] Capability check — measured rows + metadata inferences.
  assert.equal(flow.confirm().kind, 'next')
  const capView = flow.view()
  assert.match(capView.title, /能力检测/)
  assert.equal(capView.stepLabel, '步骤 4 / 6')
  const caps = (capView.report ?? []).map(l => l.text)
  assert.ok(caps.some(t => /✔ Chat Completion（实测）/.test(t)), 'completion row')
  assert.ok(caps.some(t => /✔ 流式输出 SSE（实测）/.test(t)), 'streaming row')
  assert.ok(caps.some(t => /✔ Tool Calling/.test(t)), 'tool calling row')
  assert.ok(caps.some(t => /满足 coding agent 的基本要求/.test(t)), 'verdict row')

  // [5/6] Connectivity test — full 3-check checklist.
  assert.equal(flow.submitChoice('continue').kind, 'next')
  const reportView = flow.view()
  assert.match(reportView.title, /连通性测试通过/)
  assert.equal(reportView.stepLabel, '步骤 5 / 6')
  const texts = (reportView.report ?? []).map(l => l.text)
  assert.ok(texts.some(t => /✔ 1\/3 检查端点连通性/.test(t)), 'checklist line 1')
  assert.ok(texts.some(t => /✔ 2\/3 获取模型列表（1 个）/.test(t)), 'checklist line 2')
  assert.ok(texts.some(t => /✔ 3\/3 发送最小推理请求（首字节 132ms）/.test(t)), 'checklist line 3')

  // [6/6] Save confirm with the capability-check summary.
  assert.equal(flow.submitChoice('continue').kind, 'next')
  const confirmView = flow.view()
  assert.match(confirmView.title, /确认保存/)
  assert.equal(confirmView.stepLabel, '步骤 6 / 6')
  assert.match(confirmView.subtitle ?? '', /凭证校验通过/)
  assert.match(confirmView.subtitle ?? '', /secrets\.json/)

  const result = flow.submitChoice('save')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit') return
  assert.equal(result.commit.mode, 'preset')
  if (result.commit.mode !== 'preset') return
  assert.equal(result.commit.setup.providerName, 'deepseek')
  assert.equal(result.commit.setup.preset, 'deepseek')
  assert.equal(result.commit.setup.apiKey, 'sk-test-123')
  assert.equal(result.commit.setup.makeDefault, true)
  // Template ModelConfig objects carried through (1M context preserved).
  const pro = result.commit.setup.models?.find(m => m.id === 'deepseek-v4-pro')
  assert.equal(pro?.contextWindow, 1_000_000)
})

test('preset path: failed probe shows a structured report with causes and advice', () => {
  const flow = new ConnectFlow()
  flow.submitChoice('deepseek')
  flow.submitInput('sk-bad')
  flow.submitInput('')
  flow.applyProbe(report({ models: [], modelsOk: false, completionOk: false, errors: ['Authentication failed (HTTP 401).'] }))
  const view = flow.view()
  assert.equal(view.kind, 'choice')
  assert.match(view.title, /连通性测试未通过/)
  assert.equal(view.stepLabel, '步骤 5 / 6')
  const texts = (view.report ?? []).map(l => l.text)
  assert.ok(texts.some(t => /✘ 1\/3 检查端点连通性/.test(t)))
  assert.ok(texts.some(t => /Authentication failed/.test(t)), 'error line present')
  assert.ok(texts.some(t => /可能原因/.test(t)))
  assert.ok(texts.some(t => /API Key 无效/.test(t)))
  assert.ok(texts.some(t => /建议操作/.test(t)))
  assert.deepEqual((view.options ?? []).map(o => o.id), ['rekey', 'edit-url', 'save-anyway'])
  assert.equal(view.options?.[0]?.recommended, true)

  // Save anyway → confirm step flagged as unprobed.
  const flow2 = new ConnectFlow()
  flow2.submitChoice('deepseek')
  flow2.submitInput('sk-bad')
  flow2.submitInput('')
  flow2.applyProbe(report({ models: [], modelsOk: false, completionOk: false, errors: ['boom'] }))
  assert.equal(flow2.submitChoice('save-anyway').kind, 'next')
  assert.match(flow2.view().subtitle ?? '', /探测未完全通过/)
  assert.equal(flow2.submitChoice('save').kind, 'commit')

  // Rekey returns to the key step with the previous key prefilled.
  assert.equal(flow.submitChoice('rekey').kind, 'next')
  assert.match(flow.view().title, /API 密钥/)
  assert.equal(flow.takeRestoredInput(), 'sk-bad')

  // Edit-url returns to the endpoint-confirm step with the URL prefilled.
  const flow3 = new ConnectFlow()
  flow3.submitChoice('deepseek')
  flow3.submitInput('sk-bad')
  flow3.submitInput('')
  flow3.applyProbe(report({ models: [], modelsOk: false, completionOk: false, errors: ['boom'] }))
  assert.equal(flow3.submitChoice('edit-url').kind, 'next')
  assert.match(flow3.view().title, /服务地址/)
  assert.equal(flow3.takeRestoredInput(), PROVIDER_PRESETS.deepseek.provider.baseUrl)
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
  assert.match(flow.view().title, /连通性测试/)
  assert.equal(flow.submitChoice('continue').kind, 'next')
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

  // Provider name — blank uses the host-derived default; then the confirm gate.
  const nameView = flow.view()
  assert.equal(nameView.kind, 'input')
  assert.equal(nameView.defaultValue, 'example-com')
  const named = flow.submitInput('')
  assert.equal(named.kind, 'next')
  assert.match(flow.view().title, /确认保存/)
  const result = flow.submitChoice('save')
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
  flow.submitChoice('continue')
  flow.confirm()
  flow.submitChoice('split')
  assert.equal(flow.submitInput('my-relay').kind, 'next')
  const result = flow.submitChoice('save')
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
  assert.match(flow.view().title, /连通性测试/)
  assert.equal(flow.submitChoice('continue').kind, 'next')
  const view = flow.view()
  assert.equal(view.kind, 'input')
  assert.match(view.title, /输入模型型号/)

  assert.equal(flow.submitInput('my-model-v1').kind, 'next')
  assert.equal(flow.submitChoice('none').kind, 'next')
  assert.equal(flow.submitInput('my-relay').kind, 'next')
  const result = flow.submitChoice('save')
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
  flow.submitChoice('continue')
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
  flow.submitChoice('continue')
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

// ── draft save/restore ──

function draft(overrides: Partial<ConnectDraft> = {}): ConnectDraft {
  return {
    version: 1,
    savedAt: Date.now(),
    phase: 'diy-url',
    collected: {},
    ...overrides,
  }
}

test('draft: valid draft opens the resume prompt; resume restores the key step', () => {
  const flow = new ConnectFlow([], draft({
    phase: 'preset-apikey',
    collected: { presetKey: 'deepseek' },
    pendingInput: 'sk-half',
  }))
  const view = flow.view()
  assert.equal(view.kind, 'choice')
  assert.match(view.title, /上次的配置进度/)
  assert.match(view.subtitle ?? '', /输入 API 密钥/)
  assert.ok(flow.draftPromptPending())
  assert.ok((view.options ?? []).some(o => o.id === 'resume'))

  const result = flow.submitChoice('resume')
  assert.equal(result.kind, 'next')
  assert.equal(flow.view().kind, 'input')
  assert.equal(flow.view().masked, true)
  assert.equal(flow.takeRestoredInput(), 'sk-half')
  assert.equal(flow.takeRestoredInput(), undefined) // read-once
  assert.equal(flow.submitInput('sk-test-123').kind, 'next')
  const probe = flow.submitInput('')
  assert.equal(probe.kind, 'probe')
  assert.equal(flow.applyProbe(report()).kind, 'next')      // [3/6] models
  assert.equal(flow.confirm().kind, 'next')                 // [4/6] capability
  assert.equal(flow.submitChoice('continue').kind, 'next')  // [5/6] report
  assert.equal(flow.submitChoice('continue').kind, 'next')  // [6/6] confirm
  const commit = flow.submitChoice('save')
  assert.equal(commit.kind, 'commit')
  if (commit.kind !== 'commit' || commit.commit.mode !== 'preset') return
  assert.equal(commit.commit.setup.apiKey, 'sk-test-123')
})

test('draft: diy-models resume recomputes matcher results and keeps checkbox state', () => {
  const flow = new ConnectFlow([], draft({
    phase: 'diy-models',
    collected: {
      baseUrl: 'https://api.example.com/v1',
      keyRef: 'diy-pending',
      probedSelection: [
        { rawId: 'deepseek-v4-pro', checked: true },
        { rawId: 'mystery-x', checked: false },
      ],
    },
  }), 'sk-x')
  flow.submitChoice('resume')
  const view = flow.view()
  assert.equal(view.kind, 'multi-choice')
  assert.equal(view.options?.[0]?.label, 'deepseek-v4-pro')
  assert.equal(view.options?.[0]?.checked, true)
  assert.equal(view.options?.[1]?.label, 'mystery-x')
  assert.equal(view.options?.[1]?.checked, false)
  assert.match(view.options?.[1]?.description ?? '', /未知模型/)
})

test('draft: transient phases resume at the key step with the key prefilled', () => {
  for (const phase of ['diy-probing', 'diy-probe-failed'] as const) {
    const flow = new ConnectFlow([], draft({
      phase,
      collected: { baseUrl: 'https://api.example.com/v1', keyRef: 'diy-pending' },
    }), 'sk-x')
    flow.submitChoice('resume')
    const view = flow.view()
    assert.equal(view.kind, 'input')
    assert.match(view.title, /API Key/)
    // 不预填的话，用户一回车就把存好的 key 清掉了（空输入=本地端点语义）。
    assert.equal(flow.takeRestoredInput(), 'sk-x')
  }
})

test('draft: diy-models without a stored selection falls back to the key step', () => {
  const flow = new ConnectFlow([], draft({
    phase: 'diy-models',
    collected: { baseUrl: 'https://api.example.com/v1', keyRef: 'diy-pending' },
  }), 'sk-x')
  flow.submitChoice('resume')
  assert.match(flow.view().title, /API Key/)
})

test('draft: diy-name without a thinking answer slides down to the thinking step', () => {
  const flow = new ConnectFlow([], draft({
    phase: 'diy-name',
    collected: { baseUrl: 'https://api.example.com/v1', keyRef: 'diy-pending', modelId: 'some-model' },
  }), 'sk-x')
  flow.submitChoice('resume')
  assert.match(flow.view().title, /深度思考/)
})

test('draft: unknown or OAuth preset key is rejected wholesale', () => {
  for (const presetKey of ['no-such-preset', 'codex']) {
    const flow = new ConnectFlow([], draft({ phase: 'preset-apikey', collected: { presetKey } }))
    assert.equal(flow.draftRejected, true, presetKey)
    assert.match(flow.view().title, /连接模型服务商/)
  }
})

test('draft: add-model resume rejects when the provider was deleted meanwhile', () => {
  const stale = new ConnectFlow([], draft({
    phase: 'diy-context',
    collected: { existingProvider: 'gone', modelId: 'm' },
  }))
  assert.equal(stale.draftRejected, true)
  const valid = new ConnectFlow([{ name: 'kept', modelCount: 1 }], draft({
    phase: 'diy-context',
    collected: { existingProvider: 'kept', modelId: 'm' },
  }))
  assert.equal(valid.draftRejected, false)
  valid.submitChoice('resume')
  assert.match(valid.view().title, /上下文长度/)
})

test('draft: discard returns to the provider list and flags wasDraftDiscarded', () => {
  const flow = new ConnectFlow([], draft({ pendingInput: 'https://half' }))
  assert.ok(flow.draftPromptPending())
  const result = flow.submitChoice('discard')
  assert.equal(result.kind, 'next')
  assert.ok(flow.wasDraftDiscarded())
  assert.equal(flow.hasProgress(), false)
  assert.match(flow.view().title, /连接模型服务商/)
})

test('draft: fresh flow has no progress; toDraft returns undefined', () => {
  const flow = new ConnectFlow()
  assert.equal(flow.hasProgress(), false)
  assert.equal(flow.toDraft(), undefined)
  flow.submitChoice('custom')
  assert.equal(flow.hasProgress(), true)
})

test('draft: toDraft snapshots progress, carries pending input, drops transient fields', () => {
  const flow = new ConnectFlow()
  toProbe(flow)
  flow.probeFailed('boom')
  const snap = flow.toDraft('partial')
  assert.ok(snap)
  assert.equal(snap.phase, 'diy-probe-failed')
  assert.equal(snap.collected.baseUrl, 'https://api.example.com/v1')
  // 草稿永不落明文密钥——keyRef 由 app 层在落盘前挂载。
  assert.equal('apiKey' in snap.collected, false)
  assert.equal(snap.pendingInput, 'partial')
  assert.equal('probeError' in snap.collected, false)
  // JSON 序列化安全（草稿要落盘）。
  JSON.parse(JSON.stringify(snap))
})

test('draft: toDraft from diy-models stores only the checkbox selection', () => {
  const flow = new ConnectFlow()
  toProbe(flow)
  flow.applyProbe(report({ models: ['deepseek-v4-pro', 'other-model'] }))
  flow.submitChoice('continue')
  flow.toggle('1') // uncheck the second
  const snap = flow.toDraft()
  assert.ok(snap)
  assert.deepEqual(snap.collected.probedSelection, [
    { rawId: 'deepseek-v4-pro', checked: true },
    { rawId: 'other-model', checked: false },
  ])
  assert.equal('probedModels' in snap.collected, false)
})

test('provider step lists the new spec presets (kimi/openai/volc/ollama) + compat entry', () => {
  const flow = new ConnectFlow()
  const view = flow.view()
  const ids = (view.options ?? []).map(o => o.id)
  for (const expected of ['kimi', 'openai', 'volc', 'ollama', 'openai-compat', 'custom']) {
    assert.ok(ids.includes(expected), `missing option: ${expected}`)
  }
  // 免密钥 preset 的描述标注「免密钥」。
  const ollama = view.options?.find(o => o.id === 'ollama')
  assert.match(ollama?.description ?? '', /免密钥/)
})

test('kimi preset: key → endpoint → probe → models → capability → report → commit', () => {
  const flow = new ConnectFlow()
  const afterPick = flow.submitChoice('kimi')
  assert.equal(afterPick.kind, 'next')
  assert.equal(flow.view().kind, 'input')
  assert.equal(flow.submitInput('sk-moon-123').kind, 'next')
  const probe = flow.submitInput('')
  assert.equal(probe.kind, 'probe')
  assert.equal(flow.applyProbe(report()).kind, 'next')
  if (flow.view().kind === 'multi-choice') {
    assert.equal(flow.confirm().kind, 'next')
    assert.match(flow.view().title, /能力检测/)
    assert.equal(flow.submitChoice('continue').kind, 'next')
    assert.match(flow.view().title, /连通性测试/)
    assert.equal(flow.submitChoice('continue').kind, 'next')
  }
  assert.match(flow.view().title, /确认保存/)
  const result = flow.submitChoice('save')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit') return
  assert.equal(result.commit.mode, 'preset')
  if (result.commit.mode !== 'preset') return
  assert.equal(result.commit.setup.providerName, 'kimi')
  assert.equal(result.commit.setup.apiKey, 'sk-moon-123')
})

test('openai-compat choice routes into the DIY url step', () => {
  const flow = new ConnectFlow()
  const result = flow.submitChoice('openai-compat')
  assert.equal(result.kind, 'next')
  assert.match(flow.view().title, /API 地址/)
})

test('ollama keyless: pick → probe immediately (no key step)', () => {
  const flow = new ConnectFlow()
  const result = flow.submitChoice('ollama')
  assert.equal(result.kind, 'probe')
  if (result.kind !== 'probe') return
  assert.equal(result.baseUrl, 'http://127.0.0.1:11434/v1')
  assert.equal(result.apiKey, undefined)
  assert.equal(flow.view().kind, 'busy')
})

test('ollama keyless: probe success → report → models → thinking → confirm → preset commit', () => {
  const flow = new ConnectFlow()
  flow.submitChoice('ollama')
  flow.applyProbe(report({ models: ['qwen3:8b', 'llama3.1'] }))
  assert.match(flow.view().title, /连通性测试/)
  assert.equal(flow.submitChoice('continue').kind, 'next')
  assert.equal(flow.view().kind, 'multi-choice')
  const confirmed = flow.confirm()
  assert.equal(confirmed.kind, 'next')
  assert.equal(flow.submitChoice('none').kind, 'next')
  assert.match(flow.view().title, /确认保存/)
  const result = flow.submitChoice('save')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit') return
  assert.equal(result.commit.mode, 'preset')
  if (result.commit.mode !== 'preset') return
  assert.equal(result.commit.setup.providerName, 'ollama')
  assert.equal(result.commit.setup.preset, 'ollama')
  assert.deepEqual(result.commit.setup.models?.map(m => m.id), ['qwen3:8b', 'llama3.1'])
  assert.equal(result.commit.setup.apiKey, undefined)
})

test('ollama keyless: probe without model list → manual model → preset commit', () => {
  const flow = new ConnectFlow()
  flow.submitChoice('ollama')
  flow.applyProbe(report({ models: [] }))
  assert.match(flow.view().title, /连通性测试/)
  assert.equal(flow.submitChoice('continue').kind, 'next')
  assert.equal(flow.view().kind, 'input') // diy-model
  flow.submitInput('qwen3:latest')
  assert.equal(flow.submitChoice('none').kind, 'next')
  const result = flow.submitChoice('save')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit') return
  assert.equal(result.commit.mode, 'preset')
  if (result.commit.mode !== 'preset') return
  assert.equal(result.commit.setup.providerName, 'ollama')
  assert.deepEqual(result.commit.setup.models?.map(m => m.id), ['qwen3:latest'])
})

test('confirm back: DIY returns to naming with the name prefilled', () => {
  const flow = new ConnectFlow()
  toProbe(flow)
  flow.applyProbe(report({ models: ['deepseek-v4-pro'] }))
  flow.submitChoice('continue')
  flow.confirm()
  flow.submitChoice('none')
  flow.submitInput('my-relay')
  assert.match(flow.view().title, /确认保存/)
  assert.equal(flow.submitChoice('back').kind, 'next')
  assert.match(flow.view().title, /起个名字/)
  assert.equal(flow.takeRestoredInput(), 'my-relay')
  // Re-submit lands back on confirm; save still commits the same config.
  assert.equal(flow.submitInput('my-relay').kind, 'next')
  const result = flow.submitChoice('save')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit' || result.commit.mode !== 'custom') return
  assert.equal(result.commit.providerName, 'my-relay')
})

test('draft: preset transient phases resume at the endpoint step; Enter re-probes with restored key', () => {
  for (const phase of ['preset-probing', 'probe-report'] as const) {
    const flow = new ConnectFlow([], draft({
      phase,
      collected: { presetKey: 'deepseek', keyRef: 'deepseek' },
    }), 'sk-saved')
    flow.submitChoice('resume')
    const view = flow.view()
    assert.equal(view.kind, 'input', phase)
    assert.match(view.title, /服务地址/, phase)
    const probe = flow.submitInput('')
    assert.equal(probe.kind, 'probe', phase)
    if (probe.kind === 'probe') assert.equal(probe.apiKey, 'sk-saved', phase)
  }
})

test('draft: preset confirm without a selection resumes at the key step', () => {
  const flow = new ConnectFlow([], draft({
    phase: 'confirm',
    collected: { presetKey: 'deepseek', keyRef: 'deepseek' },
  }), 'sk-saved')
  flow.submitChoice('resume')
  assert.match(flow.view().title, /API 密钥/)
  assert.equal(flow.takeRestoredInput(), 'sk-saved')
})

test('draft: preset-endpoint resume keeps the edited URL and restored key', () => {
  const flow = new ConnectFlow([], draft({
    phase: 'preset-endpoint',
    collected: { presetKey: 'deepseek', keyRef: 'deepseek', baseUrl: 'https://relay.example.com/v1' },
    pendingInput: 'https://relay.example.com/v1',
  }), 'sk-saved')
  flow.submitChoice('resume')
  assert.match(flow.view().title, /服务地址/)
  assert.equal(flow.takeRestoredInput(), 'https://relay.example.com/v1')
  const probe = flow.submitInput('https://relay.example.com/v1')
  assert.equal(probe.kind, 'probe')
  if (probe.kind === 'probe') {
    assert.equal(probe.baseUrl, 'https://relay.example.com/v1')
    assert.equal(probe.apiKey, 'sk-saved')
  }
})

test('draft: DIY confirm phase resumes at the naming step with the name prefilled', () => {
  const flow = new ConnectFlow([], draft({
    phase: 'confirm',
    collected: {
      baseUrl: 'https://api.example.com/v1',
      keyRef: 'diy-pending',
      providerName: 'my-relay',
      probedSelection: [{ rawId: 'deepseek-v4-pro', checked: true }],
    },
  }), 'sk-x')
  flow.submitChoice('resume')
  assert.match(flow.view().title, /起个名字/)
  assert.equal(flow.takeRestoredInput(), 'my-relay')
})

// 规格守卫：目标方案要求「凭证 > 探测 > 保存确认」——任何带密钥的 preset
// 都不允许从密钥步直接 commit（历史 bug：曾静默直存，跳过探测与确认）。
test('spec guard: no keyed preset commits straight from the key step', () => {
  for (const key of providerPresetKeys) {
    const preset = PROVIDER_PRESETS[key]
    if (preset.provider.auth?.type === 'oauth' || preset.keyless) continue
    const flow = new ConnectFlow()
    assert.equal(flow.submitChoice(key).kind, 'next', key)
    const billingMode = preset.billingModes?.find(m => !m.baseUrl.includes('{')) ?? preset.billingModes?.[0]
    if (preset.billingModes && preset.billingModes.length > 0) {
      assert.equal(flow.submitChoice(billingMode!.id).kind, 'next', `${key} billing step`)
    }
    assert.equal(flow.submitInput('sk-guard').kind, 'next', `${key} skipped endpoint confirm`)
    const endpointInput = billingMode && billingMode.baseUrl.includes('{')
      ? billingMode.baseUrl.replace('{WorkspaceId}', 'ws-guard')
      : ''
    const result = flow.submitInput(endpointInput)
    assert.notEqual(result.kind, 'commit', `${key} committed without probe/confirm`)
    assert.equal(result.kind, 'probe', key)
    // 探测通过 → 模型 → 能力检测 → 连通性测试 → 确认步，全程无自动落盘。
    assert.equal(flow.applyProbe(report()).kind, 'next', key)
    if (flow.view().kind === 'multi-choice') {
      assert.equal(flow.confirm().kind, 'next', key)
      assert.match(flow.view().title, /能力检测/, key)
      assert.equal(flow.submitChoice('continue').kind, 'next', key)
      assert.match(flow.view().title, /连通性测试/, key)
      assert.equal(flow.submitChoice('continue').kind, 'next', key)
    }
    assert.match(flow.view().title, /确认保存/, key)
  }
})

test('draft: preset-models resume rebuilds the selection and commits it', () => {
  const flow = new ConnectFlow([], draft({
    phase: 'preset-models',
    collected: {
      presetKey: 'deepseek',
      keyRef: 'deepseek',
      probedSelection: [
        { rawId: 'deepseek-v4-pro', checked: true },
        { rawId: 'deepseek-v4-flash', checked: false },
      ],
    },
  }), 'sk-saved')
  flow.submitChoice('resume')
  const view = flow.view()
  assert.equal(view.kind, 'multi-choice')
  assert.equal(view.stepLabel, '步骤 3 / 6')
  assert.equal(view.options?.[0]?.label, 'deepseek-v4-pro')
  assert.equal(view.options?.[0]?.checked, true)
  assert.equal(view.options?.[1]?.checked, false)
  // Save walks capability → probe-report (no report after restore) → commit.
  assert.equal(flow.confirm().kind, 'next')
  assert.match(flow.view().title, /能力检测/)
  assert.equal(flow.submitChoice('continue').kind, 'next')
  assert.match(flow.view().title, /连通性测试/)
  assert.equal(flow.submitChoice('save-anyway').kind, 'next')
  const result = flow.submitChoice('save')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit' || result.commit.mode !== 'preset') return
  assert.deepEqual(result.commit.setup.models?.map(m => m.id), ['deepseek-v4-pro'])
})

test('confirm back: preset returns to capability, then to model selection', () => {
  const flow = new ConnectFlow()
  flow.submitChoice('deepseek')
  flow.submitInput('sk-x')
  flow.submitInput('')
  flow.applyProbe(report({ models: ['deepseek-v4-pro'] }))
  flow.confirm()
  flow.submitChoice('continue')
  flow.submitChoice('continue')
  assert.match(flow.view().title, /确认保存/)
  assert.equal(flow.submitChoice('back').kind, 'next')
  assert.match(flow.view().title, /能力检测/)
  assert.equal(flow.submitChoice('back').kind, 'next')
  assert.equal(flow.view().kind, 'multi-choice')
  assert.equal(flow.view().stepLabel, '步骤 3 / 6')
  // Re-walk and save still commits the same config.
  assert.equal(flow.confirm().kind, 'next')
  flow.submitChoice('continue')
  flow.submitChoice('continue')
  assert.equal(flow.submitChoice('save').kind, 'commit')
})

// ── billing-mode step (dashscope: 按量计费 / token plan) ──

const PAYG_URL = 'https://ws-123.cn-beijing.maas.aliyuncs.com/api/v1'

test('dashscope: 7 steps — billing → key → endpoint({WorkspaceId}) → models → capability → connectivity → save', () => {
  const flow = new ConnectFlow()
  assert.equal(flow.submitChoice('dashscope').kind, 'next')

  // [2/7] Billing mode selection.
  const billingView = flow.view()
  assert.equal(billingView.kind, 'choice')
  assert.match(billingView.title, /计费模式/)
  assert.equal(billingView.stepLabel, '步骤 2 / 7')
  assert.deepEqual(billingView.options?.map(o => o.id), ['payg', 'token-plan'])
  assert.equal(billingView.options?.[0]?.recommended, true)
  assert.equal(flow.submitChoice('ghost').kind, 'error') // unknown mode rejected
  assert.equal(flow.submitChoice('payg').kind, 'next')

  // [3/7] Key step.
  assert.equal(flow.view().stepLabel, '步骤 3 / 7')
  assert.equal(flow.submitInput('sk-bailian').kind, 'next')

  // [3/7] Endpoint prefilled from the payg template — placeholder must be replaced.
  const urlView = flow.view()
  assert.equal(urlView.stepLabel, '步骤 3 / 7')
  assert.equal(urlView.defaultValue, 'https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1')
  assert.match(urlView.subtitle ?? '', /WorkspaceId/)
  const blocked = flow.submitInput('') // Enter keeps the unfilled template
  assert.equal(blocked.kind, 'error')
  assert.match(blocked.kind === 'error' ? blocked.message : '', /WorkspaceId/)
  const probe = flow.submitInput(PAYG_URL)
  assert.equal(probe.kind, 'probe')
  if (probe.kind !== 'probe') return
  assert.equal(probe.baseUrl, PAYG_URL)
  assert.equal(probe.apiKey, 'sk-bailian')

  // [4/7] models → [5/7] capability → [6/7] connectivity → [7/7] confirm.
  assert.equal(flow.applyProbe(report({ models: ['qwen3-max'] })).kind, 'next')
  assert.equal(flow.view().stepLabel, '步骤 4 / 7')
  assert.equal(flow.confirm().kind, 'next')
  assert.equal(flow.view().stepLabel, '步骤 5 / 7')
  assert.equal(flow.submitChoice('continue').kind, 'next')
  assert.equal(flow.view().stepLabel, '步骤 6 / 7')
  assert.equal(flow.submitChoice('continue').kind, 'next')
  const confirmView = flow.view()
  assert.match(confirmView.title, /确认保存/)
  assert.equal(confirmView.stepLabel, '步骤 7 / 7')

  // Commit carries the billing-mode baseUrl override.
  const result = flow.submitChoice('save')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit' || result.commit.mode !== 'preset') return
  assert.equal(result.commit.setup.baseUrl, PAYG_URL)
  assert.equal(result.commit.setup.preset, 'dashscope')
})

test('dashscope: token plan prefills its own endpoint and commits it', () => {
  const flow = new ConnectFlow()
  flow.submitChoice('dashscope')
  flow.submitChoice('token-plan')
  flow.submitInput('sk-bailian')
  const urlView = flow.view()
  assert.equal(urlView.defaultValue, 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1')
  assert.doesNotMatch(urlView.subtitle ?? '', /WorkspaceId/)
  const probe = flow.submitInput('') // Enter accepts the token-plan URL
  assert.equal(probe.kind, 'probe')
  if (probe.kind !== 'probe') return
  assert.equal(probe.baseUrl, 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1')
  flow.applyProbe(report({ models: ['qwen3-max'] }))
  flow.confirm()
  flow.submitChoice('continue')
  flow.submitChoice('continue')
  const result = flow.submitChoice('save')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit' || result.commit.mode !== 'preset') return
  assert.equal(result.commit.setup.baseUrl, 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1')
})

test('draft: dashscope key-step draft without a billing mode resumes at the billing step', () => {
  const flow = new ConnectFlow([], draft({
    phase: 'preset-apikey',
    collected: { presetKey: 'dashscope', keyRef: 'dashscope' },
  }), 'sk-saved')
  flow.submitChoice('resume')
  assert.match(flow.view().title, /计费模式/)
  assert.equal(flow.view().stepLabel, '步骤 2 / 7')
})

test('draft: dashscope billing + edited URL round-trips and keeps the override on commit', () => {
  const flow = new ConnectFlow()
  flow.submitChoice('dashscope')
  flow.submitChoice('payg')
  flow.submitInput('sk-bailian')
  flow.submitInput(PAYG_URL)
  const saved = flow.toDraft()
  assert.equal(saved?.collected.billingMode, 'payg')
  assert.equal(saved?.collected.baseUrl, PAYG_URL)

  const restored = new ConnectFlow([], draft({
    phase: 'preset-endpoint',
    collected: { presetKey: 'dashscope', billingMode: 'payg', keyRef: 'dashscope', baseUrl: PAYG_URL },
  }), 'sk-saved')
  restored.submitChoice('resume')
  assert.match(restored.view().title, /服务地址/)
  const probe = restored.submitInput(PAYG_URL)
  assert.equal(probe.kind, 'probe')
  restored.applyProbe(report({ models: ['qwen3-max'] }))
  restored.confirm()
  restored.submitChoice('continue')
  restored.submitChoice('continue')
  const result = restored.submitChoice('save')
  assert.equal(result.kind, 'commit')
  if (result.kind !== 'commit' || result.commit.mode !== 'preset') return
  assert.equal(result.commit.setup.baseUrl, PAYG_URL)
})

test('billing step is skipped for presets without billingModes (deepseek stays 6 steps)', () => {
  const flow = new ConnectFlow()
  flow.submitChoice('deepseek')
  assert.match(flow.view().title, /API 密钥/)
  assert.equal(flow.view().stepLabel, '步骤 2 / 6')
})

test('quota-exhausted probe errors get account-level guidance, not key advice', () => {
  const flow = new ConnectFlow()
  flow.submitChoice('dashscope')
  flow.submitChoice('token-plan')
  flow.submitInput('sk-x')
  flow.submitInput('')
  flow.applyProbe(report({
    models: [],
    modelsOk: false,
    completionOk: false,
    errors: ['Quota/billing problem (HTTP 403). — server said: {"code":"AllocationQuota.FreeTierOnly","message":"Free quota exhausted."}'],
  }))
  const texts = (flow.view().report ?? []).map(l => l.text)
  assert.ok(texts.some(t => /免费额度已用完/.test(t)), 'quota cause present')
  assert.ok(!texts.some(t => /重新输入 API Key/.test(t)), 'misleading key advice dropped')
})
