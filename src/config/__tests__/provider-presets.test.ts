import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { providerSchema } from '../schema.js'
import { PROVIDER_PRESETS, cloneProviderPreset, providerPresetKeys } from '../provider-presets.js'

describe('provider presets', () => {
  it('contains required built-in provider modes', () => {
    assert.deepEqual([...providerPresetKeys].sort(), ['codex', 'deepseek', 'glm', 'mimo', 'minimax'].sort())
  })

  it('every preset parses as ProviderConfig', () => {
    for (const key of providerPresetKeys) {
      const parsed = providerSchema.safeParse(PROVIDER_PRESETS[key].provider)
      assert.equal(parsed.success, true, `${key} should parse`)
    }
  })

  it('codex preset uses OAuth and gpt-5.5', () => {
    const codex = cloneProviderPreset('codex')
    assert.deepEqual(codex.auth, { type: 'oauth', provider: 'codex' })
    assert.equal(codex.capabilities.cacheControl, true)
    assert.equal(codex.models[0]?.id, 'gpt-5.5')
  })
})
