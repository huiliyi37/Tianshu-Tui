import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeBaseUrl, resolveProbeEndpoints, PROVIDER_ENDPOINT_MAP, DEFAULT_ENDPOINT_PATHS } from '../endpoint-map.js'

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes', () => {
    assert.equal(normalizeBaseUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1')
  })

  it('strips a pasted chat-completions tail (with and without /v1)', () => {
    assert.equal(normalizeBaseUrl('https://api.openai.com/v1/chat/completions'), 'https://api.openai.com/v1')
    assert.equal(normalizeBaseUrl('https://host.com/chat/completions'), 'https://host.com')
  })

  it('strips models/messages/embeddings tails', () => {
    assert.equal(normalizeBaseUrl('https://host.com/v1/models'), 'https://host.com/v1')
    assert.equal(normalizeBaseUrl('https://host.com/v1/messages'), 'https://host.com/v1')
    assert.equal(normalizeBaseUrl('https://host.com/embeddings'), 'https://host.com')
  })

  it('leaves clean bases untouched', () => {
    assert.equal(normalizeBaseUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1')
    assert.equal(normalizeBaseUrl('http://localhost:3000/api'), 'http://localhost:3000/api')
  })
})

describe('resolveProbeEndpoints', () => {
  it('version-in-base: appends default paths directly', () => {
    const r = resolveProbeEndpoints('https://api.openai.com/v1')
    assert.equal(r.modelsUrl, 'https://api.openai.com/v1/models')
    assert.equal(r.chatUrl, 'https://api.openai.com/v1/chat/completions')
  })

  it('version-less base (oneapi-style): inserts /v1 before the paths', () => {
    const r = resolveProbeEndpoints('http://localhost:3000/api')
    assert.equal(r.modelsUrl, 'http://localhost:3000/api/v1/models')
    assert.equal(r.chatUrl, 'http://localhost:3000/api/v1/chat/completions')
  })

  it('user pasted the full chat URL: never double-appends', () => {
    const r = resolveProbeEndpoints('https://api.openai.com/v1/chat/completions')
    assert.equal(r.base, 'https://api.openai.com/v1')
    assert.equal(r.modelsUrl, 'https://api.openai.com/v1/models')
    assert.equal(r.chatUrl, 'https://api.openai.com/v1/chat/completions')
  })

  it('user pasted a models URL tail: list probe does not hit …/models/models', () => {
    const r = resolveProbeEndpoints('https://host.com/v1/models')
    assert.equal(r.modelsUrl, 'https://host.com/v1/models')
  })

  it('unknown providers fall back to the OpenAI-compatible default', () => {
    const r = resolveProbeEndpoints('https://my-relay.example.com/v1', 'totally-unknown')
    assert.equal(r.chatUrl, 'https://my-relay.example.com/v1/chat/completions')
  })

  it('per-provider overrides win over defaults', () => {
    PROVIDER_ENDPOINT_MAP['override-fixture'] = { models: '/list' }
    try {
      const r = resolveProbeEndpoints('https://host.com/v1', 'override-fixture')
      assert.equal(r.modelsUrl, 'https://host.com/v1/list')
      assert.equal(r.chatUrl, `https://host.com/v1${DEFAULT_ENDPOINT_PATHS.chat}`)
    } finally {
      delete PROVIDER_ENDPOINT_MAP['override-fixture']
    }
  })
})
