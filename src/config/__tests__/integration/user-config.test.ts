import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

function loadConfig() {
  const configPath = join(homedir(), '.rivet', 'config.json')
  if (!existsSync(configPath)) return null
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'))
  } catch {
    return null
  }
}

function hasProvider(config: any, name: string): boolean {
  return config?.provider?.providers?.[name] !== undefined
}

describe('User config validation', () => {
  const config = loadConfig()

  it('config file exists', () => {
    assert.ok(config !== null, `Config not found at ${join(homedir(), '.rivet', 'config.json')}`)
  })

  it('config has required providers', () => {
    if (!config) return
    const providers = Object.keys(config.provider.providers)
    // Minimum viable set: at least one provider configured
    assert.ok(providers.length >= 1, `expected >= 1 providers, got ${providers.length}: ${providers.join(', ')}`)
  })

  it('codex has oauth auth', () => {
    if (!hasProvider(config, 'codex')) return
    const codex = config.provider.providers.codex
    assert.deepEqual(codex.auth, { type: 'oauth', provider: 'codex' })
    assert.equal(codex.protocol, 'openai')
  })

  it('minimax uses openai protocol with api-key', () => {
    if (!hasProvider(config, 'minimax')) return
    const minimax = config.provider.providers.minimax
    assert.equal(minimax.protocol, 'openai')
    assert.equal(minimax.apiKeyEnv, 'MINIMAX_API_KEY')
  })

  it('mimo uses openai protocol with api-key', () => {
    if (!hasProvider(config, 'mimo')) return
    const mimo = config.provider.providers.mimo
    assert.equal(mimo.protocol, 'openai')
    assert.equal(mimo.apiKeyEnv, 'MIMO_API_KEY')
  })

  it('worker routing maps tasks to profiles', () => {
    if (!config?.workers?.routing) return
    const { routing, profiles } = config.workers
    if (routing.code_edit) assert.equal(routing.code_edit, 'capable')
    if (routing.repo_summarization) assert.equal(routing.repo_summarization, 'cheap')
    if (profiles?.capable) assert.equal(profiles.capable.provider, 'cliproxy')
    if (profiles?.cheap) assert.equal(profiles.cheap.provider, 'minimax')
  })
})
