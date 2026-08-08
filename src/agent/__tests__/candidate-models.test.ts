import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { deriveCandidateModels, providerHasCredentials } from '../candidate-models.js'
import type { ProviderConfig } from '../../config/schema.js'

const provider = (over: Partial<ProviderConfig> & { name: string }): ProviderConfig => ({
  baseUrl: 'https://api.example.com/v1',
  protocol: 'openai',
  capabilities: { cacheControl: false, stripParams: [], toolJsonBug: false, prefixCache: 'none', prefixCompletion: false },
  models: [{ id: `${over.name}-default` }],
  thinking: 'enabled',
  maxTokens: 64000,
  unsupported: [],
  ...over,
} as ProviderConfig)

describe('candidate-models', () => {
  it('只收录凭据就绪的 provider，各取首个模型', () => {
    const providers = {
      deepseek: provider({ name: 'deepseek', apiKey: 'sk-1' }),
      glm: provider({ name: 'glm' }),
      minimax: provider({ name: 'minimax', apiKey: 'sk-2' }),
    }
    const candidates = deriveCandidateModels(providers, p => Boolean(p.apiKey))
    assert.deepEqual(candidates, [
      { provider: 'deepseek', model: 'deepseek-default' },
      { provider: 'minimax', model: 'minimax-default' },
    ])
  })

  it('全都无凭据时返回空池——退化为副本不轮换的旧行为', () => {
    const providers = { glm: provider({ name: 'glm' }), codex: provider({ name: 'codex' }) }
    assert.deepEqual(deriveCandidateModels(providers, () => false), [])
  })

  it('providers 缺省时返回空池', () => {
    assert.deepEqual(deriveCandidateModels(undefined), [])
  })

  it('跳过没有模型列表的 provider', () => {
    const providers = { empty: provider({ name: 'empty', models: [] as never }) }
    assert.deepEqual(deriveCandidateModels(providers, () => true), [])
  })

  it('providerHasCredentials：inline key 就绪、无 key 且无环境变量则否', () => {
    assert.equal(providerHasCredentials(provider({ name: 'deepseek', apiKey: 'sk-inline' })), true)

    const previous = process.env.NOSUCHPROVIDER_API_KEY
    delete process.env.NOSUCHPROVIDER_API_KEY
    try {
      assert.equal(providerHasCredentials(provider({ name: 'nosuchprovider' })), false)
    } finally {
      if (previous !== undefined) process.env.NOSUCHPROVIDER_API_KEY = previous
    }
  })

  it('providerHasCredentials：apiKeyEnv 指向的环境变量生效', () => {
    const previous = process.env.RIVET_TEST_CANDIDATE_KEY
    process.env.RIVET_TEST_CANDIDATE_KEY = 'sk-from-env'
    try {
      const p = provider({ name: 'custom', apiKeyEnv: 'RIVET_TEST_CANDIDATE_KEY' })
      assert.equal(providerHasCredentials(p), true)
    } finally {
      if (previous === undefined) delete process.env.RIVET_TEST_CANDIDATE_KEY
      else process.env.RIVET_TEST_CANDIDATE_KEY = previous
    }
  })
})
