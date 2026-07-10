import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectRuntimeEnvBlock, __resetRuntimeEnvCache, type VersionProbe } from '../runtime-env.js'

const dirs: string[] = []

function makeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-env-'))
  dirs.push(dir)
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content)
  }
  return dir
}

const noProbe: VersionProbe = () => null

describe('runtime-env (W4)', () => {
  beforeEach(() => __resetRuntimeEnvCache())
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })

  it('returns null for an empty project', () => {
    const dir = makeProject({})
    assert.equal(detectRuntimeEnvBlock(dir, noProbe), null)
  })

  it('detects python via .python-version and probed interpreter', () => {
    const dir = makeProject({ '.python-version': '3.6.9\n', 'setup.py': '' })
    const probe: VersionProbe = cmd => (cmd === 'python3' ? 'Python 3.6.9' : null)
    const block = detectRuntimeEnvBlock(dir, probe)
    assert.ok(block)
    assert.ok(block!.includes('python: 3.6.9'))
    assert.ok(block!.includes('.python-version'))
  })

  it('extracts python_requires from setup.py when no .python-version', () => {
    const dir = makeProject({ 'setup.py': "setup(python_requires='>=3.5')" })
    const block = detectRuntimeEnvBlock(dir, noProbe)
    assert.ok(block)
    assert.ok(block!.includes('declared >=3.5 via setup.py'))
  })

  it('extracts requires-python from pyproject.toml', () => {
    const dir = makeProject({ 'pyproject.toml': 'requires-python = ">=3.11"\n' })
    const block = detectRuntimeEnvBlock(dir, noProbe)
    assert.ok(block)
    assert.ok(block!.includes('declared >=3.11 via pyproject.toml'))
  })

  it('detects node engines from package.json', () => {
    const dir = makeProject({ 'package.json': JSON.stringify({ engines: { node: '>=18' } }) })
    const probe: VersionProbe = cmd => (cmd === 'node' ? 'v20.11.0' : null)
    const block = detectRuntimeEnvBlock(dir, probe)
    assert.ok(block)
    assert.ok(block!.includes('node: 20.11.0'))
    assert.ok(block!.includes('declared >=18 via package.json engines'))
  })

  it('detects rust-toolchain channel', () => {
    const dir = makeProject({ 'rust-toolchain.toml': '[toolchain]\nchannel = "1.75.0"\n' })
    const block = detectRuntimeEnvBlock(dir, noProbe)
    assert.ok(block)
    assert.ok(block!.includes('rust: declared 1.75.0 via rust-toolchain'))
  })

  it('detects go.mod version', () => {
    const dir = makeProject({ 'go.mod': 'module example.com/x\n\ngo 1.21\n' })
    const block = detectRuntimeEnvBlock(dir, noProbe)
    assert.ok(block)
    assert.ok(block!.includes('go: declared 1.21 via go.mod'))
  })

  it('adds version caution for dated runtimes (python < 3.9)', () => {
    const dir = makeProject({ '.python-version': '3.6\n', 'setup.py': '' })
    const block = detectRuntimeEnvBlock(dir, noProbe)
    assert.ok(block)
    assert.ok(block!.includes('低于当前常识版本'))
    assert.ok(block!.includes('enum 类属性'))
  })

  it('no caution for modern runtimes', () => {
    const dir = makeProject({ 'pyproject.toml': 'requires-python = ">=3.12"\n' })
    const block = detectRuntimeEnvBlock(dir, noProbe)
    assert.ok(block)
    assert.ok(!block!.includes('低于当前常识版本'))
  })

  it('memoized: repeated builds are byte-identical and probe only fires once (缓存字节稳定)', () => {
    const dir = makeProject({ 'package.json': JSON.stringify({ engines: { node: '>=18' } }) })
    let probeCalls = 0
    const probe: VersionProbe = () => { probeCalls++; return 'v20.11.0' }
    const first = detectRuntimeEnvBlock(dir, probe)
    const second = detectRuntimeEnvBlock(dir, probe)
    assert.equal(first, second)
    assert.equal(probeCalls, 1)
  })

  it('RIVET_RUNTIME_ENV=0 disables detection (逃生口)', () => {
    const dir = makeProject({ 'package.json': JSON.stringify({ engines: { node: '>=18' } }) })
    process.env['RIVET_RUNTIME_ENV'] = '0'
    try {
      assert.equal(detectRuntimeEnvBlock(dir, noProbe), null)
    } finally {
      delete process.env['RIVET_RUNTIME_ENV']
    }
  })

  it('malformed package.json does not throw', () => {
    const dir = makeProject({ 'package.json': '{ not json' })
    const probe: VersionProbe = cmd => (cmd === 'node' ? 'v20.0.0' : null)
    const block = detectRuntimeEnvBlock(dir, probe)
    assert.ok(block)
    assert.ok(block!.includes('node: 20.0.0'))
  })
})
