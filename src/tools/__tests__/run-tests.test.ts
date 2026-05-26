import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RUN_TESTS_TOOL } from '../run-tests.js'

function makeParams(input: Record<string, unknown>, cwd: string) {
  return {
    input,
    toolUseId: 'test-run',
    cwd,
  }
}

function setupProject(testScript: string, testFile: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'run-tests-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'test-project',
    scripts: { test: testScript },
  }))
  writeFileSync(join(dir, 'src', 'example.test.ts'), testFile)
  return dir
}

describe('RUN_TESTS_TOOL', () => {
  let passingDir: string
  let failingDir: string

  before(() => {
    const passingTest = `import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
describe('passing', () => {
  it('adds numbers', () => { assert.equal(1 + 1, 2) })
  it('concatenates strings', () => { assert.equal('a' + 'b', 'ab') })
})`

    const failingTest = `import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
describe('mixed', () => {
  it('passes', () => { assert.equal(1, 1) })
  it('fails', () => { assert.equal(1, 2) })
})`

    passingDir = setupProject('tsx --test src/example.test.ts', passingTest)
    failingDir = setupProject('tsx --test src/example.test.ts', failingTest)
  })

  after(() => {
    rmSync(passingDir, { recursive: true, force: true })
    rmSync(failingDir, { recursive: true, force: true })
  })

  it('detects test command from package.json', async () => {
    const result = await RUN_TESTS_TOOL.execute(makeParams({}, passingDir))
    assert.equal(result.isError, false)
    assert.ok(result.content.includes('passed'))
    assert.ok(result.verification)
    assert.equal(result.verification!.status, 'passed')
    assert.equal(result.verification!.scope, 'full')
  })

  it('runs and reports success for passing tests', async () => {
    const result = await RUN_TESTS_TOOL.execute(makeParams({}, passingDir))
    assert.equal(result.isError, false)
    assert.ok(result.content.includes('passed'))
    assert.ok(!result.content.includes('FAILURES'))
  })

  it('reports failure output for failing tests', async () => {
    const result = await RUN_TESTS_TOOL.execute(makeParams({}, failingDir))
    assert.ok(result.content.length > 0)
    assert.ok(result.verification)
    // verification metadata is always present
    assert.ok(typeof result.verification!.passed === 'number')
    assert.ok(typeof result.verification!.failed === 'number')
  })

  it('filter restricts which tests run with targeted scope', async () => {
    const result = await RUN_TESTS_TOOL.execute(
      makeParams({ filter: 'src/example.test.ts' }, passingDir),
    )
    assert.equal(result.isError, false)
    assert.ok(result.content.includes('passed'))
    assert.ok(result.verification)
    assert.equal(result.verification!.scope, 'targeted')
    assert.equal(result.verification!.command, 'tsx --test src/example.test.ts')
  })

  it('runs targeted tsx tests without npx npm-command ambiguity', async () => {
    const result = await RUN_TESTS_TOOL.execute(
      makeParams({ filter: 'src/example.test.ts' }, passingDir),
    )

    assert.equal(result.isError, false)
    assert.equal(result.verification!.command.startsWith('npx '), false)
    assert.equal(result.verification!.command, 'tsx --test src/example.test.ts')
  })

  it('requiresApproval returns false', () => {
    assert.equal(RUN_TESTS_TOOL.requiresApproval(makeParams({}, '/tmp')), false)
  })

  it('isConcurrencySafe returns false', () => {
    assert.equal(RUN_TESTS_TOOL.isConcurrencySafe(), false)
  })

  it('isEnabled returns true', () => {
    assert.equal(RUN_TESTS_TOOL.isEnabled(), true)
  })
})
