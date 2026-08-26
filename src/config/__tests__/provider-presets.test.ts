import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { providerSchema } from '../schema.js'
import { PROVIDER_PRESETS, cloneProviderPreset, providerPresetKeys } from '../provider-presets.js'

describe('provider presets', () => {
  it('contains required built-in provider modes', () => {
    assert.deepEqual([...providerPresetKeys].sort(), ['ccswitch', 'codex', 'dashscope', 'deepseek', 'glm', 'kimi', 'longcat', 'mimo', 'mimo-api', 'minimax', 'ollama', 'openai', 'openrouter', 'relay', 'siliconflow', 'volc', 'zhipu-vision'].sort())
  })

  it('ollama is the only keyless preset (local, no auth)', () => {
    const keyless = providerPresetKeys.filter(k => PROVIDER_PRESETS[k].keyless)
    assert.deepEqual(keyless, ['ollama'])
    assert.equal(PROVIDER_PRESETS.ollama.provider.baseUrl, 'http://127.0.0.1:11434/v1')
  })

  it('every preset parses as ProviderConfig', () => {
    for (const key of providerPresetKeys) {
      const parsed = providerSchema.safeParse(PROVIDER_PRESETS[key].provider)
      assert.equal(parsed.success, true, `${key} should parse`)
    }
  })

  it('codex preset uses OAuth and gpt-5.6-sol', () => {
    const codex = cloneProviderPreset('codex')
    assert.deepEqual(codex.auth, { type: 'oauth', provider: 'codex' })
    assert.equal(codex.capabilities.cacheControl, true)
    assert.equal(codex.models[0]?.id, 'gpt-5.6-sol')
  })

  it('deepseek cost defaults: pro=high effort, flash=medium effort', () => {
    const deepseek = cloneProviderPreset('deepseek')
    const pro = deepseek.models.find(m => m.id === 'deepseek-v4-pro')
    const flash = deepseek.models.find(m => m.id === 'deepseek-v4-flash')
    assert.equal(pro?.reasoningEffort, 'high')
    assert.equal(flash?.reasoningEffort, 'medium')
  })

  it('deepseek-v4-flash-vision-exp: 1M 上下文 + 视觉 + 定价与 flash 同档', () => {
    const deepseek = cloneProviderPreset('deepseek')
    const vision = deepseek.models.find(m => m.id === 'deepseek-v4-flash-vision-exp')
    assert.ok(vision, 'vision-exp 必须在 deepseek 预设模型列表')
    assert.equal(vision.contextWindow, 1_000_000)
    assert.equal(vision.maxTokens, 384_000)
    assert.equal(vision.supportsVision, true)
    assert.deepEqual(vision.pricing, { input: 1, output: 2, cacheRead: 0.02, cacheWrite: 1 })
    assert.equal(vision.reasoningEffort, 'medium')
    assert.equal(vision.tier, 'cheap')
  })
})
