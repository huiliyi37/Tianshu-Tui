import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { INSPECT_PROJECT_TOOL } from '../inspect-project.js'

function makeParams(cwd: string) {
  return {
    input: {},
    toolUseId: 'test',
    cwd,
  }
}

describe('INSPECT_PROJECT_TOOL', () => {
  let testDir: string

  before(() => {
    testDir = mkdtempSync(join(tmpdir(), 'inspect-project-test-'))
    mkdirSync(join(testDir, 'src'), { recursive: true })
    mkdirSync(join(testDir, 'src', '__tests__'), { recursive: true })
    mkdirSync(join(testDir, '.rivet', 'tasks', '__tests__'), { recursive: true })
    mkdirSync(join(testDir, '.codex', '__tests__'), { recursive: true })

    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      name: 'test-project',
      scripts: {
        build: 'tsup',
        test: 'tsx --test src/**/__tests__/*.test.ts',
        dev: 'tsup --watch',
      },
      dependencies: { react: '^19.0.0' },
      devDependencies: { typescript: '^5.7.0', tsup: '^8.4.0' },
    }))

    writeFileSync(join(testDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'es2022' } }))
    writeFileSync(join(testDir, 'src', 'main.ts'), '')
    writeFileSync(join(testDir, 'src', '__tests__', 'main.test.ts'), '')
    writeFileSync(join(testDir, '.rivet', 'tasks', '__tests__', 'runtime.test.ts'), '')
    writeFileSync(join(testDir, '.codex', '__tests__', 'foreign.test.ts'), '')
    writeFileSync(join(testDir, 'package-lock.json'), '')
  })

  after(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('detects TypeScript project correctly', async () => {
    const result = await INSPECT_PROJECT_TOOL.execute(makeParams(testDir))
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('Language: TypeScript'))
  })

  it('detects npm as package manager', async () => {
    const result = await INSPECT_PROJECT_TOOL.execute(makeParams(testDir))
    assert.ok(result.content.includes('Package manager: npm'))
  })

  it('detects React framework from dependencies', async () => {
    const result = await INSPECT_PROJECT_TOOL.execute(makeParams(testDir))
    assert.ok(result.content.includes('Framework: React'))
  })

  it('lists scripts from package.json', async () => {
    const result = await INSPECT_PROJECT_TOOL.execute(makeParams(testDir))
    assert.ok(result.content.includes('build: tsup'))
    assert.ok(result.content.includes('test: tsx --test'))
    assert.ok(result.content.includes('dev: tsup --watch'))
  })

  it('finds entry files', async () => {
    const result = await INSPECT_PROJECT_TOOL.execute(makeParams(testDir))
    assert.ok(result.content.includes('src/main.ts'))
  })

  it('finds test files from content paths and skips runtime/foreign attention noise during broad discovery', async () => {
    const result = await INSPECT_PROJECT_TOOL.execute(makeParams(testDir))
    assert.ok(result.content.includes('main.test.ts'))
    assert.ok(!result.content.includes('runtime.test.ts'))
    assert.ok(!result.content.includes('foreign.test.ts'))
  })

  it('finds config files', async () => {
    const result = await INSPECT_PROJECT_TOOL.execute(makeParams(testDir))
    assert.ok(result.content.includes('tsconfig.json'))
  })

  it('reports error when no package.json', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'inspect-empty-'))
    try {
      const result = await INSPECT_PROJECT_TOOL.execute(makeParams(emptyDir))
      assert.equal(result.isError, true)
      assert.ok(result.content.includes('No package.json'))
    } finally {
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })

  it('requiresApproval is false and isConcurrencySafe is true', () => {
    assert.equal(INSPECT_PROJECT_TOOL.requiresApproval(makeParams(testDir)), false)
    assert.equal(INSPECT_PROJECT_TOOL.isConcurrencySafe(), true)
    assert.equal(INSPECT_PROJECT_TOOL.isEnabled(), true)
  })
})
