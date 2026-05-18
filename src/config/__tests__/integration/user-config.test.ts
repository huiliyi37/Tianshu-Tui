import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

describe('User config validation', () => {
  const configPath = join(homedir(), '.rivet', 'config.json')

  it('config file exists', () => {
    assert.ok(existsSync(configPath), `Config not found at ${configPath}`)
  })

  it('config has required providers', () => {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    const providers = Object.keys(config.provider.providers)
    assert.ok(providers.length >= 6, `expected >= 6 providers, got ${providers.length}: ${providers.join(', ')}`)
    for (const p of ['codex', 'deepseek', 'glm', 'minimax', 'mimo', 'opencode-go']) {
      assert.ok(providers.includes(p), `missing required provider: ${p}`)
    }
  })

  it('codex has oauth auth', () => {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    assert.deepEqual(config.provider.providers.codex.auth, { type: 'oauth', provider: 'codex' })
    assert.equal(config.provider.providers.codex.protocol, 'openai')
  })

  it('minimax uses openai protocol with api-key', () => {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    assert.equal(config.provider.providers.minimax.protocol, 'openai')
    assert.equal(config.provider.providers.minimax.apiKeyEnv, 'MINIMAX_API_KEY')
  })

  it('mimo uses openai protocol with api-key', () => {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    assert.equal(config.provider.providers.mimo.protocol, 'openai')
    assert.equal(config.provider.providers.mimo.apiKeyEnv, 'MIMO_API_KEY')
  })

  it('worker routing maps tasks to profiles', () => {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    assert.equal(config.workers.routing.code_edit, 'capable')
    assert.equal(config.workers.routing.repo_summarization, 'cheap')
    assert.equal(config.workers.routing.compaction, undefined) // compaction is main agent's own concern
    assert.equal(config.workers.profiles.capable.provider, 'cliproxy')
    assert.equal(config.workers.profiles.cheap.provider, 'minimax')
  })
})
