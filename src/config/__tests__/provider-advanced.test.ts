import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, saveConfig, registerProvider, setupProvider } from '../manager.js'

describe('provider advanced config pipeline', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-provider-advanced-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('registerProvider persists advanced fields, surviving zero values', () => {
    registerProvider({
      providerName: 'adv-test',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-x',
      models: [{ id: 'm1' }],
      advanced: { requestTimeoutMs: 120_000, maxRetries: 0, temperature: 0, proxy: 'http://127.0.0.1:7890' },
    })
    const provider = loadConfig().provider.providers['adv-test']!
    assert.equal(provider.requestTimeoutMs, 120_000)
    // !== undefined guards: 0 is legal and must survive a truthy check.
    assert.equal(provider.maxRetries, 0)
    assert.equal(provider.temperature, 0)
    assert.equal(provider.proxy, 'http://127.0.0.1:7890')
  })

  it('registerProvider without advanced leaves the fields absent', () => {
    registerProvider({
      providerName: 'plain-test',
      baseUrl: 'https://api.example.com/v1',
      models: [{ id: 'm1' }],
    })
    const provider = loadConfig().provider.providers['plain-test']!
    assert.equal(provider.requestTimeoutMs, undefined)
    assert.equal(provider.maxRetries, undefined)
    assert.equal(provider.temperature, undefined)
    assert.equal(provider.proxy, undefined)
  })

  it('setupProvider merges advanced onto an existing preset provider', () => {
    setupProvider({ providerName: 'deepseek', advanced: { maxRetries: 1, temperature: 0.7 } })
    const provider = loadConfig().provider.providers.deepseek!
    assert.equal(provider.maxRetries, 1)
    assert.equal(provider.temperature, 0.7)
    // Existing preset fields untouched.
    assert.ok(provider.models.length > 0)
  })

  it('advanced fields survive a load → save → load round trip', () => {
    registerProvider({
      providerName: 'rt-test',
      baseUrl: 'https://api.example.com/v1',
      models: [{ id: 'm1' }],
      advanced: { maxRetries: 3 },
    })
    const cfg = loadConfig()
    saveConfig(cfg)
    assert.equal(loadConfig().provider.providers['rt-test']!.maxRetries, 3)
  })

  it('schema still strips unknown provider fields (zod default unchanged)', () => {
    registerProvider({
      providerName: 'strip-test',
      baseUrl: 'https://api.example.com/v1',
      models: [{ id: 'm1' }],
    })
    const cfg = loadConfig()
    ;(cfg.provider.providers['strip-test'] as Record<string, unknown>).totallyUnknownField = 'x'
    saveConfig(cfg)
    const reloaded = loadConfig().provider.providers['strip-test'] as Record<string, unknown>
    assert.equal(reloaded.totallyUnknownField, undefined)
  })
})
