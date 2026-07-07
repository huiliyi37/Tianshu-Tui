import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir as osTmpdir } from 'node:os'
import { detectProjectFingerprint } from '../project-fingerprint.js'

function tmpdir() {
  return mkdtempSync(join(osTmpdir(), 'fingerprint-'))
}

describe('detectProjectFingerprint', () => {
  it('detects TypeScript project with package.json', () => {
    const dir = tmpdir()
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        scripts: { test: 'vitest run', build: 'tsc', lint: 'eslint .' },
        devDependencies: { eslint: '^9.0.0' },
      }))
      const fp = detectProjectFingerprint(dir)
      assert.equal(fp.language, 'typescript')
      assert.equal(fp.testCommand, 'npx vitest run')
      assert.equal(fp.buildCommand, 'npm run build')
      assert.equal(fp.lintCommand, 'npx eslint .')
      assert.equal(fp.hasTestInfra, true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('detects Python project with pyproject.toml', () => {
    const dir = tmpdir()
    try {
      writeFileSync(join(dir, 'pyproject.toml'), '[tool.pytest.ini_options]\n')
      const fp = detectProjectFingerprint(dir)
      assert.equal(fp.language, 'python')
      assert.equal(fp.testCommand, 'pytest')
      assert.equal(fp.buildCommand, 'uv sync')
      assert.equal(fp.typecheckCommand, 'mypy .')
      assert.equal(fp.lintCommand, 'ruff check .')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('detects Rust project with Cargo.toml', () => {
    const dir = tmpdir()
    try {
      writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "test"\n')
      const fp = detectProjectFingerprint(dir)
      assert.equal(fp.language, 'rust')
      assert.equal(fp.testCommand, 'cargo test')
      assert.equal(fp.buildCommand, 'cargo build')
      assert.equal(fp.typecheckCommand, 'cargo check')
      assert.equal(fp.lintCommand, 'cargo clippy')
      assert.equal(fp.hasTestInfra, true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('detects Go project with go.mod', () => {
    const dir = tmpdir()
    try {
      writeFileSync(join(dir, 'go.mod'), 'module example.com/test\n\ngo 1.21\n')
      const fp = detectProjectFingerprint(dir)
      assert.equal(fp.language, 'go')
      assert.equal(fp.testCommand, 'go test ./...')
      assert.equal(fp.buildCommand, 'go build ./...')
      assert.equal(fp.typecheckCommand, 'go vet ./...')
      assert.equal(fp.hasTestInfra, true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns unknown for empty project', () => {
    const dir = tmpdir()
    try {
      const fp = detectProjectFingerprint(dir)
      assert.equal(fp.language, 'unknown')
      assert.equal(fp.testCommand, undefined)
      assert.equal(fp.hasTestInfra, false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('TypeScript project hasTestInfra=true when test script exists', () => {
    const dir = tmpdir()
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        scripts: { test: 'jest' }
      }))
      const fp = detectProjectFingerprint(dir)
      assert.equal(fp.hasTestInfra, true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('TypeScript project hasTestInfra=false when no test script', () => {
    const dir = tmpdir()
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        scripts: { start: 'node index.js' }
      }))
      const fp = detectProjectFingerprint(dir)
      assert.equal(fp.hasTestInfra, false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
