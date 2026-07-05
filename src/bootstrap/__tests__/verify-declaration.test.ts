import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureVerifyDeclaration, renderRivetMdStack, upsertStackSection } from '../verify-declaration.js'

describe('verify-declaration (A3/A4)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verify-decl-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes a verify declaration for a Rust project', () => {
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "x"\n')
    const res = ensureVerifyDeclaration(dir)
    assert.equal(res.fingerprint.language, 'rust')
    assert.equal(res.wrote, true)
    assert.ok(res.filledKeys.includes('test'))

    const raw = JSON.parse(readFileSync(join(dir, '.rivet-config.json'), 'utf-8'))
    assert.equal(raw.verify.test, 'cargo test')
    assert.equal(raw.verify.build, 'cargo build')
    assert.equal(raw.verify.typecheck, 'cargo check')
  })

  it('never overwrites existing verify keys (hand-edits win)', () => {
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "x"\n')
    writeFileSync(join(dir, '.rivet-config.json'), JSON.stringify({
      verify: { test: 'cargo test --workspace' },
      agent: { maxTurns: 5 },
    }))
    const res = ensureVerifyDeclaration(dir)
    assert.equal(res.verify.test, 'cargo test --workspace') // preserved
    assert.equal(res.verify.build, 'cargo build') // filled
    assert.ok(!res.filledKeys.includes('test'))

    const raw = JSON.parse(readFileSync(join(dir, '.rivet-config.json'), 'utf-8'))
    assert.equal(raw.verify.test, 'cargo test --workspace')
    assert.equal(raw.agent.maxTurns, 5) // sibling config untouched
  })

  it('does not create a config file for unknown projects', () => {
    const res = ensureVerifyDeclaration(dir)
    assert.equal(res.fingerprint.language, 'unknown')
    assert.equal(res.wrote, false)
    assert.equal(existsSync(join(dir, '.rivet-config.json')), false)
  })

  it('does not clobber a malformed config file', () => {
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\n')
    writeFileSync(join(dir, '.rivet-config.json'), '{broken')
    const res = ensureVerifyDeclaration(dir)
    assert.equal(res.wrote, false)
    assert.equal(readFileSync(join(dir, '.rivet-config.json'), 'utf-8'), '{broken')
  })

  it('renderRivetMdStack renders declared commands with a generated marker', () => {
    writeFileSync(join(dir, 'go.mod'), 'module x\n')
    const res = ensureVerifyDeclaration(dir)
    const stack = renderRivetMdStack(res.fingerprint, res.verify)
    assert.match(stack, /## Stack/)
    assert.match(stack, /- Language: go/)
    assert.match(stack, /- Test: go test \.\/\.\.\./)
    assert.match(stack, /Generated from \.rivet-config\.json/)
  })

  it('upsertStackSection replaces an existing Stack section and preserves the rest', () => {
    const body = '# Project\n\n## Stack\n- Language: \n- Test: \n\n## Conventions\n- keep this\n'
    const next = upsertStackSection(body, '## Stack\n- Language: rust\n- Test: cargo test')
    assert.match(next, /- Language: rust/)
    assert.match(next, /- keep this/)
    assert.doesNotMatch(next, /- Language: \n/)
    // Only one Stack section remains
    assert.equal(next.split('## Stack').length, 2)
  })

  it('upsertStackSection appends when no Stack section exists', () => {
    const next = upsertStackSection('# Project\n', '## Stack\n- Language: go')
    assert.match(next, /# Project[\s\S]*## Stack\n- Language: go/)
  })
})
