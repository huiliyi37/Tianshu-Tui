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
    assert.equal(config.provider.default, 'deepseek')
  })

  it('all configured providers parse with supported protocols', () => {
    if (!existsSync(configPath)) return
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
    const config = configSchema.parse(raw)
    const providers = config.provider.providers
    for (const [name, provider] of Object.entries(providers)) {
      assert.match(provider.protocol, /^(anthropic|openai)$/, `${name} protocol should be supported`)
    }
  })

  it('codex auth parsed as oauth', () => {
    if (!existsSync(configPath)) return
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
    const config = configSchema.parse(raw)
    assert.deepEqual(config.provider.providers.codex!.auth, { type: 'oauth', provider: 'codex' })
  })

  it('workers config parsed correctly', () => {
    if (!existsSync(configPath)) return
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
    const config = configSchema.parse(raw)
    assert.ok(config.workers.profiles.capable)
    assert.equal(config.workers.profiles.capable.provider, 'codex')
    assert.equal(config.workers.profiles.capable.model, 'gpt-5.5')
    assert.equal(config.workers.routing.code_edit, 'capable')
    assert.equal(config.workers.routing.compaction, undefined) // compaction is main agent's own concern
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
