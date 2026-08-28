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

  // 「获取 API Key」直链覆盖：凡要 Key 的预设必须配官方 keyUrl，否则桌面端预设卡的
  // 「获取 API Key ↗」缺失——新用户不知道去哪拿 Key 是真实卡点（ZCode 对标）。
  // 豁免：codex 走 OAuth 无 Key 页；ccswitch/relay 是中转站，无官方控制台页可指。
  it('every key-requiring preset carries an official https keyUrl', () => {
    const exempt = new Set(['codex', 'ccswitch', 'relay'])
    for (const key of providerPresetKeys) {
      const preset = PROVIDER_PRESETS[key]
      if (preset.keyless || exempt.has(key)) continue
      assert.ok(
        typeof preset.keyUrl === 'string' && /^https:\/\//.test(preset.keyUrl),
        `${key} requires a key and must carry an https keyUrl (official console page)`,
      )
    }
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

  it('glm-5.3 / glm-5.3-flash：文本旗舰 + 原生多模态（flash 带 supportsVision）', () => {
    const glm = cloneProviderPreset('glm')
    const text = glm.models.find(m => m.id === 'glm-5.3')
    assert.ok(text, 'glm-5.3 必须在 glm 预设模型列表')
    assert.equal(text.contextWindow, 1_000_000)
    assert.equal(text.maxTokens, 131_072)
    assert.equal(text.supportsVision, undefined, '文本旗舰不声明视觉')
    assert.deepEqual(text.pricing, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, 'Coding Plan 订阅不按 token 计费')
    const flash = glm.models.find(m => m.id === 'glm-5.3-flash')
    assert.ok(flash, 'glm-5.3-flash 必须在 glm 预设模型列表')
    assert.equal(flash.supportsVision, true, '原生多模态声明视觉')
    assert.equal(flash.contextWindow, 1_000_000)
    assert.deepEqual(flash.pricing, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  })
})
