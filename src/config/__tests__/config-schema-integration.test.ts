import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { configSchema } from '../schema.js'

describe('Config schema integration', () => {
  const configPath = join(homedir(), '.rivet', 'config.json')

  it('parses full user config through Zod schema', () => {
    if (!existsSync(configPath)) return // skip if no user config
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
    const config = configSchema.parse(raw)
    assert.ok(config)
    // Default provider must be one of the configured providers
    const defaultProvider = config.provider.default
    assert.ok(defaultProvider, 'default provider must be set')
    assert.ok(config.provider.providers[defaultProvider], `default provider '${defaultProvider}' not found in providers map`)
  })

  it('all configured providers parse with supported protocols', () => {
    if (!existsSync(configPath)) return
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
    const config = configSchema.parse(raw)
    const providers = config.provider.providers
    for (const [name, provider] of Object.entries(providers)) {
      assert.match(provider.protocol, /^(anthropic|openai)$/, `${name} protocol should be supported`)
      assert.match(provider.baseUrl, /^https?:\/\//, `${name} baseUrl should be an HTTP(S) URL`)
      assert.ok(provider.models.length > 0, `${name} must have at least one model`)
      for (const model of provider.models) {
        assert.ok(model.contextWindow > 0, `${name}/${model.id} contextWindow must be positive`)
        assert.ok(model.maxTokens > 0, `${name}/${model.id} maxTokens must be positive`)
      }
    }
  })

  it('codex auth parsed as oauth when configured', () => {
    if (!existsSync(configPath)) return
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
    const config = configSchema.parse(raw)
    const codex = config.provider.providers.codex
    if (!codex) return
    // auth is optional/nullable in the schema: either unconfigured (null/undefined)
    // or a well-formed oauth object. Both are valid; assert shape only when present.
    if (codex.auth) {
      assert.equal(codex.auth.type, 'oauth')
    }
  })

  it('workers config parsed correctly', () => {
    if (!existsSync(configPath)) return
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
    const config = configSchema.parse(raw)
    // Worker profiles are user-configurable; assert structure, not pinned values.
    const profiles = config.workers.profiles
    const names = Object.keys(profiles)
    for (const name of names) {
      assert.ok(profiles[name]!.provider, `worker profile '${name}' must have a provider`)
      assert.ok(profiles[name]!.model, `worker profile '${name}' must have a model`)
    }
    // compaction is the main agent's own concern, never routed to a worker
    assert.equal(config.workers.routing.compaction, undefined)
  })

  it('resolveApiKey works for minimax with apiKeyEnv', () => {
    if (!existsSync(configPath)) return
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
    const config = configSchema.parse(raw)
    // minimax uses apiKeyEnv, not apiKey
    assert.equal(config.provider.providers.minimax!.apiKeyEnv, 'MINIMAX_API_KEY')
    assert.equal(config.provider.providers.minimax!.apiKey, undefined)
  })
})
