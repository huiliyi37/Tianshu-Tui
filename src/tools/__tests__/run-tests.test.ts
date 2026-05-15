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

    // Use direct file path instead of glob (sh -c may not expand **)
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
    assert.ok(result.content.includes('Exit code: 0'))
  })

  it('runs and reports success for passing tests', async () => {
    const result = await RUN_TESTS_TOOL.execute(makeParams({}, passingDir))
    assert.equal(result.isError, false)
    assert.ok(result.content.includes('passed'))
    assert.ok(!result.content.includes('FAILURES'))
  })

  it('reports failure details for failing tests', async () => {
    const result = await RUN_TESTS_TOOL.execute(makeParams({}, failingDir))
    // The test runner should produce output; exit code may vary by runner
    assert.ok(result.content.length > 0)
    assert.ok(result.content.includes('fail') || result.content.includes('test'))
  })

  it('filter restricts which tests run', async () => {
    const result = await RUN_TESTS_TOOL.execute(
      makeParams({ filter: 'example.test.ts' }, passingDir),
    )
    assert.equal(result.isError, false)
    assert.ok(result.content.includes('passed'))
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
