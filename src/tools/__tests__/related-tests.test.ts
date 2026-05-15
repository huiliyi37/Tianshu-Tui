import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { RELATED_TESTS_TOOL } from '../related-tests.js'

describe('RELATED_TESTS_TOOL', () => {
  let testDir: string

  before(() => {
    testDir = mkdtempSync(join(tmpdir(), 'related-tests-'))
    // src/foo.ts -> src/__tests__/foo.test.ts
    mkdirSync(join(testDir, 'src', '__tests__'), { recursive: true })
    writeFileSync(join(testDir, 'src', 'foo.ts'), '')
    writeFileSync(join(testDir, 'src', '__tests__', 'foo.test.ts'), '')

    // src/tools/bash.ts -> src/tools/bash.test.ts (co-located)
    mkdirSync(join(testDir, 'src', 'tools'), { recursive: true })
    writeFileSync(join(testDir, 'src', 'tools', 'bash.ts'), '')
    writeFileSync(join(testDir, 'src', 'tools', 'bash.test.ts'), '')

    // src/api/client.ts -> no tests
    mkdirSync(join(testDir, 'src', 'api'), { recursive: true })
    writeFileSync(join(testDir, 'src', 'api', 'client.ts'), '')

    // Non-src path: lib/utils.ts -> lib/__tests__/utils.test.ts
    mkdirSync(join(testDir, 'lib', '__tests__'), { recursive: true })
    writeFileSync(join(testDir, 'lib', 'utils.ts'), '')
    writeFileSync(join(testDir, 'lib', '__tests__', 'utils.test.ts'), '')
  })

  after(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  function makeParams(input: Record<string, unknown>) {
    return {
      input,
      toolUseId: 'test',
      cwd: testDir,
    }
  }

  it('finds __tests__/foo.test.ts for src/foo.ts', async () => {
    const result = await RELATED_TESTS_TOOL.execute(makeParams({ file: 'src/foo.ts' }))
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('src/__tests__/foo.test.ts'))
  })

  it('finds co-located bash.test.ts for src/tools/bash.ts', async () => {
    const result = await RELATED_TESTS_TOOL.execute(makeParams({ file: 'src/tools/bash.ts' }))
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('src/tools/bash.test.ts'))
  })

  it('returns empty message when no tests exist', async () => {
    const result = await RELATED_TESTS_TOOL.execute(makeParams({ file: 'src/api/client.ts' }))
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('No related tests found'))
  })

  it('supports non-src paths', async () => {
    const result = await RELATED_TESTS_TOOL.execute(makeParams({ file: 'lib/utils.ts' }))
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('lib/__tests__/utils.test.ts'))
  })

  it('requiresApproval and isConcurrencySafe', () => {
    assert.equal(RELATED_TESTS_TOOL.requiresApproval(makeParams({ file: 'test' })), false)
    assert.equal(RELATED_TESTS_TOOL.isConcurrencySafe(), true)
  })

  it('finds source file for a test file (reverse lookup)', async () => {
    const result = await RELATED_TESTS_TOOL.execute(
      makeParams({ file: 'src/__tests__/foo.test.ts' }),
    )
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('src/foo.ts'))
  })
})
