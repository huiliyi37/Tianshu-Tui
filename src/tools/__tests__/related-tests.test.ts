import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { RELATED_TESTS_TOOL, createRelatedTestsTool } from '../related-tests.js'
import type { MeridianDb } from '../../repo/meridian-db.js'

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

describe('createRelatedTestsTool (meridian factory)', () => {
  function mockDb(tests: Record<string, string[]>): MeridianDb {
    return {
      getTestsFor: (f: string) => tests[f] ?? [],
      getReverseDependents: () => [],
      getCoEditNeighbors: () => [],
    } as unknown as MeridianDb
  }

  it('returns meridian SQL results when indexer is available', async () => {
    const db = mockDb({ 'src/foo.ts': ['src/__tests__/foo.test.ts', 'src/__tests__/foo-extra.test.ts'] })
    const tool = createRelatedTestsTool(() => ({ getDb: () => db }) as never)
    const result = await tool.execute({
      input: { file: 'src/foo.ts' },
      toolUseId: 'test',
      cwd: '/fake',
    })
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('foo.test.ts'))
    assert.ok(result.content.includes('foo-extra.test.ts'))
  })

  it('falls back to hardcoded heuristics when indexer returns no tests', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'rt-fallback-'))
    try {
      mkdirSync(join(testDir, 'src', '__tests__'), { recursive: true })
      writeFileSync(join(testDir, 'src', 'foo.ts'), '')
      writeFileSync(join(testDir, 'src', '__tests__', 'foo.test.ts'), '')

      const db = mockDb({}) // empty → no meridian results
      const tool = createRelatedTestsTool(() => ({ getDb: () => db }) as never)
      const result = await tool.execute({
        input: { file: 'src/foo.ts' },
        toolUseId: 'test',
        cwd: testDir,
      })
      assert.ok(result.content.includes('foo.test.ts'))
    } finally {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  it('falls back to hardcoded heuristics when indexer is null', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'rt-null-'))
    try {
      mkdirSync(join(testDir, 'src', '__tests__'), { recursive: true })
      writeFileSync(join(testDir, 'src', 'bar.ts'), '')
      writeFileSync(join(testDir, 'src', '__tests__', 'bar.test.ts'), '')

      const tool = createRelatedTestsTool(() => null)
      const result = await tool.execute({
        input: { file: 'src/bar.ts' },
        toolUseId: 'test',
        cwd: testDir,
      })
      assert.ok(result.content.includes('bar.test.ts'))
    } finally {
      rmSync(testDir, { recursive: true, force: true })
    }
  })
})
