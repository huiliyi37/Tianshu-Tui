import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { secretsPath, readSecret, writeSecret, deleteSecret, secretFingerprint, fingerprintForKeyRef } from '../secrets-store.js'
import { loadConfig, saveConfig, runConfigCLI } from '../manager.js'
import { resolveApiKey } from '../../api/factory.js'
import type { ProviderConfig } from '../schema.js'

describe('secrets store', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-secrets-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips a secret and writes the file with 0600 permissions', () => {
    writeSecret('deepseek', 'sk-round-trip')
    assert.equal(readSecret('deepseek'), 'sk-round-trip')
    const path = secretsPath()
    assert.equal(path, join(dir, 'secrets.json'))
    assert.equal(statSync(path).mode & 0o777, 0o600)
  })

  it('keeps 0600 after rewriting an existing file', () => {
    writeSecret('a', 'v1')
    writeSecret('b', 'v2')
    writeSecret('a', 'v3')
    assert.equal(statSync(secretsPath()).mode & 0o777, 0o600)
    assert.equal(readSecret('a'), 'v3')
    assert.equal(readSecret('b'), 'v2')
  })

  it('read is fail-open on missing or corrupt files', () => {
    assert.equal(readSecret('nope'), undefined)
    writeSecret('x', 'v')
    const path = secretsPath()
    rmSync(path)
    assert.equal(readSecret('x'), undefined)
  })

  it('delete removes the entry and the file when it becomes empty', () => {
    writeSecret('solo', 'v')
    deleteSecret('solo')
    assert.equal(readSecret('solo'), undefined)
    assert.equal(existsSync(secretsPath()), false)
    deleteSecret('solo') // idempotent
  })
})

describe('inline apiKey migration', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-secrets-migrate-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * Seed config.json with a legacy inline key (no keyRef). saveConfig now
   * strips plaintext apiKey before writing, so a legacy file can only be
   * constructed by writing the raw JSON directly.
   */
  function seedInlineKey(): void {
    const cfg = loadConfig()
    const raw = JSON.parse(JSON.stringify(cfg)) as {
      provider: { providers: Record<string, { apiKey?: string; keyRef?: string } | undefined> }
    }
    const deepseek = raw.provider.providers.deepseek
    if (!deepseek) throw new Error('deepseek provider missing from default config')
    deepseek.apiKey = 'sk-legacy-plaintext'
    delete deepseek.keyRef
    writeFileSync(join(dir, 'config.json'), JSON.stringify(raw, null, 2))
    assert.ok(readFileSync(join(dir, 'config.json'), 'utf8').includes('sk-legacy-plaintext'))
  }

  it('moves the inline key into secrets.json and leaves only keyRef in config.json', () => {
    seedInlineKey()
    const cfg = loadConfig()
    const raw = readFileSync(join(dir, 'config.json'), 'utf8')
    assert.ok(!raw.includes('sk-legacy-plaintext'), 'config.json must not keep the plaintext key')
    assert.equal(cfg.provider.providers.deepseek!.keyRef, 'deepseek')
    assert.equal(readSecret('deepseek'), 'sk-legacy-plaintext')
    // Materialized in memory so every existing consumer keeps working.
    assert.equal(cfg.provider.providers.deepseek!.apiKey, 'sk-legacy-plaintext')
    assert.equal(resolveApiKey(cfg.provider.providers.deepseek!), 'sk-legacy-plaintext')
  })

  it('is idempotent — a second load does not rewrite or duplicate', () => {
    seedInlineKey()
    loadConfig()
    const after1 = readFileSync(join(dir, 'config.json'), 'utf8')
    loadConfig()
    const after2 = readFileSync(join(dir, 'config.json'), 'utf8')
    assert.equal(after1, after2)
    assert.equal(readSecret('deepseek'), 'sk-legacy-plaintext')
  })

  it('saveConfig never writes the materialized key back to disk', () => {
    seedInlineKey()
    const cfg = loadConfig()
    cfg.provider.default = 'deepseek' // any unrelated mutation
    saveConfig(cfg)
    const raw = readFileSync(join(dir, 'config.json'), 'utf8')
    assert.ok(!raw.includes('sk-legacy-plaintext'))
    assert.ok(raw.includes('"keyRef": "deepseek"'))
  })
})

describe('resolveApiKey with keyRef', () => {
  const base = {
    name: 'custom',
    baseUrl: 'https://api.example.com/v1',
  } as unknown as ProviderConfig

  it('prefers keyRef over apiKeyEnv and standard env vars', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-secrets-resolve-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
    try {
      writeSecret('custom', 'sk-from-store')
      process.env.CUSTOM_API_KEY = 'sk-from-env'
      const provider = { ...base, keyRef: 'custom', apiKeyEnv: 'CUSTOM_API_KEY' } as ProviderConfig
      assert.equal(resolveApiKey(provider), 'sk-from-store')
    } finally {
      delete process.env.CUSTOM_API_KEY
      delete process.env.RIVET_CONFIG_PATH
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to env when the referenced secret is missing', () => {
    process.env.CUSTOM_API_KEY = 'sk-from-env'
    try {
      const provider = { ...base, keyRef: 'ghost' } as ProviderConfig
      assert.equal(resolveApiKey(provider), 'sk-from-env')
    } finally {
      delete process.env.CUSTOM_API_KEY
    }
  })
})

describe('config show masks secrets', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-secrets-show-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('never prints a plaintext provider key', async () => {
    writeSecret('deepseek', 'sk-super-secret-1234')
    const cfg = loadConfig()
    cfg.provider.providers.deepseek!.keyRef = 'deepseek'
    saveConfig(cfg)
    const lines: string[] = []
    await runConfigCLI(['show'], { stdout: line => lines.push(line), isTTY: false })
    const out = lines.join('\n')
    assert.ok(!out.includes('sk-super-secret-1234'), 'show output must not contain the key')
    assert.ok(out.includes('***1234'), 'masked tail is shown')
  })
})

describe('secret fingerprint', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-secrets-fp-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('is deterministic, short, hex, and never leaks key material', () => {
    const fp = secretFingerprint('sk-abc-123')
    assert.equal(fp, secretFingerprint('sk-abc-123'))
    assert.equal(fp.length, 8)
    assert.match(fp, /^[0-9a-f]{8}$/)
    assert.ok(!fp.includes('sk-abc'), 'fingerprint must not contain key material')
    assert.notEqual(fp, secretFingerprint('sk-abc-124'))
  })

  it('fingerprintForKeyRef reads through the store and returns undefined for missing refs', () => {
    writeSecret('relay-x', 'sk-shared-value')
    assert.equal(fingerprintForKeyRef('relay-x'), secretFingerprint('sk-shared-value'))
    assert.equal(fingerprintForKeyRef('ghost'), undefined)
  })
})
