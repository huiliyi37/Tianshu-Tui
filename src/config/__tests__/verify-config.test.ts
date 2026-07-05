import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadDeclaredVerify, classifyDeclaredCommand, invalidateVerifyConfig } from '../verify-config.js'

describe('verify-config (A1/A2)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verify-config-'))
    invalidateVerifyConfig()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    invalidateVerifyConfig()
  })

  it('loads declared verify commands from .rivet-config.json', () => {
    writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({
      verify: { test: 'cargo test', build: 'cargo build', typecheck: 'cargo check' },
    }))
    const v = loadDeclaredVerify(dir)
    assert.equal(v.test, 'cargo test')
    assert.equal(v.build, 'cargo build')
    assert.equal(v.typecheck, 'cargo check')
    assert.equal(v.lint, undefined)
  })

  it('walks up to find the project config (nested cwd)', () => {
    writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({ verify: { test: 'go test ./...' } }))
    const nested = join(dir, 'src', 'internal')
    mkdirSync(nested, { recursive: true })
    assert.equal(loadDeclaredVerify(nested).test, 'go test ./...')
  })

  it('returns empty for missing config / missing verify block / malformed json', () => {
    assert.deepEqual(loadDeclaredVerify(dir), {})

    writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({ agent: {} }))
    invalidateVerifyConfig()
    assert.deepEqual(loadDeclaredVerify(dir), {})

    writeFileSync(join(dir, '.rivet-config.json'), '{not json')
    invalidateVerifyConfig()
    assert.deepEqual(loadDeclaredVerify(dir), {})
  })

  it('rejects non-string verify values instead of throwing', () => {
    writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({ verify: { test: 42 } }))
    assert.deepEqual(loadDeclaredVerify(dir), {})
  })

  it('classifyDeclaredCommand matches exact and prefixed commands', () => {
    const verify = { test: 'cargo test', build: 'cargo build', typecheck: 'cargo check', lint: 'cargo clippy' }
    assert.equal(classifyDeclaredCommand('cargo test', verify), 'test')
    assert.equal(classifyDeclaredCommand('cargo test --workspace', verify), 'test')
    assert.equal(classifyDeclaredCommand('  cargo check  ', verify), 'typecheck')
    assert.equal(classifyDeclaredCommand('cargo clippy -- -D warnings', verify), 'lint')
    // "cargo testx" must not match "cargo test" (word boundary via space)
    assert.equal(classifyDeclaredCommand('cargo testx', verify), undefined)
    assert.equal(classifyDeclaredCommand('npm test', verify), undefined)
    assert.equal(classifyDeclaredCommand('anything', {}), undefined)
  })
})
