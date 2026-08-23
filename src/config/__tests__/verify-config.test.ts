import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadDeclaredVerify, classifyDeclaredCommand, matchVerifyRoutes, invalidateVerifyConfig } from '../verify-config.js'

describe('verify-config (A1/A2)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verify-config-'))
    invalidateVerifyConfig()
    // 信任门（project-trust.ts）：未授信项目的声明命令不加载。本套件按
    // 「已授信」语义测试加载行为——env 覆盖，不写真实信任库。
    process.env.RIVET_TRUST_PROJECT = '1'
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    invalidateVerifyConfig()
    delete process.env.RIVET_TRUST_PROJECT
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


describe('matchVerifyRoutes (A3)', () => {
  const routes = [
    { match: 'desktop/src/**', run: 'tsc -p desktop', kind: 'typecheck' as const },
    { match: '**/*.css', run: 'check-css', kind: 'lint' as const },
    { match: 'desktop/src/**', run: 'tsc -p desktop', kind: 'typecheck' as const }, // dup
  ]

  it('matches ** across segments and * within one segment', () => {
    const hit = matchVerifyRoutes(['desktop/src/app.tsx'], routes)
    assert.deepEqual(hit.map(r => r.run), ['tsc -p desktop'])
    // **/*.css matches nested and root-level css
    assert.deepEqual(matchVerifyRoutes(['a/b/c.css'], routes).map(r => r.run), ['check-css'])
    assert.deepEqual(matchVerifyRoutes(['c.css'], routes).map(r => r.run), ['check-css'])
    // desktop/srcx is not desktop/src/**
    assert.equal(matchVerifyRoutes(['desktop/srcx/a.ts'], routes).length, 0)
  })

  it('dedupes identical routes and returns empty on no match / no files', () => {
    const hit = matchVerifyRoutes(['desktop/src/a.ts', 'desktop/src/b.ts'], routes)
    assert.equal(hit.length, 1)
    assert.deepEqual(matchVerifyRoutes(['README.md'], routes), [])
    assert.deepEqual(matchVerifyRoutes([], routes), [])
    assert.deepEqual(matchVerifyRoutes(['desktop/src/a.ts'], undefined), [])
    // absolute paths are skipped
    assert.deepEqual(matchVerifyRoutes(['/abs/desktop/src/a.ts'], routes), [])
  })

  it('loads routes from .rivet-config.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-routes-cfg-'))
    process.env.RIVET_TRUST_PROJECT = '1'
    try {
      writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({
        verify: { routes: [{ match: 'desktop/src/**', run: 'tsc -p desktop', kind: 'typecheck' }] },
      }))
      invalidateVerifyConfig()
      const v = loadDeclaredVerify(dir)
      assert.equal(v.routes?.length, 1)
      assert.equal(v.routes?.[0]?.kind, 'typecheck')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      invalidateVerifyConfig()
      delete process.env.RIVET_TRUST_PROJECT
    }
  })
})
