import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { GLOB_TOOL } from '../glob.js'

describe('GLOB_TOOL', () => {
  let testDir: string

  before(() => {
    testDir = mkdtempSync(join(tmpdir(), 'glob-test-'))
    mkdirSync(join(testDir, 'src', 'components'), { recursive: true })
    mkdirSync(join(testDir, 'src', 'utils'))
    writeFileSync(join(testDir, 'src', 'app.ts'), '')
    writeFileSync(join(testDir, 'src', 'components', 'Button.tsx'), '')
    writeFileSync(join(testDir, 'src', 'components', 'Modal.tsx'), '')
    writeFileSync(join(testDir, 'src', 'utils', 'helpers.ts'), '')
    writeFileSync(join(testDir, 'src', 'style.css'), '')
    writeFileSync(join(testDir, 'README.md'), '')
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

  it('finds files matching a simple pattern', async () => {
    const result = await GLOB_TOOL.execute(makeParams({ pattern: '*.md' }))
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('README.md'))
  })

  it('matches with recursive **', async () => {
    const result = await GLOB_TOOL.execute(makeParams({ pattern: 'src/**/*.ts' }))
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('src/app.ts'))
    assert.ok(result.content.includes('src/utils/helpers.ts'))
  })

  it('matches with single-level * wildcard', async () => {
    const result = await GLOB_TOOL.execute(makeParams({ pattern: 'src/*.ts' }))
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('src/app.ts'))
    assert.ok(!result.content.includes('src/utils/helpers.ts'))
  })

  it('matches with brace expansion {a,b}', async () => {
    const result = await GLOB_TOOL.execute(makeParams({ pattern: 'src/**/*.{ts,tsx}' }))
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('src/app.ts'))
    assert.ok(result.content.includes('src/components/Button.tsx'))
  })

  it('respects path parameter', async () => {
    const result = await GLOB_TOOL.execute(makeParams({ pattern: '*.tsx', path: 'src/components' }))
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('src/components/Button.tsx'))
    assert.ok(result.content.includes('src/components/Modal.tsx'))
    assert.ok(!result.content.includes('src/app.ts'))
  })

  it('returns no files message for empty match', async () => {
    const result = await GLOB_TOOL.execute(makeParams({ pattern: 'nonexistent/**/*.go' }))
    assert.ok(result.content.includes('No files found.'))
  })

  it('requiresApproval and isConcurrencySafe', () => {
    assert.equal(GLOB_TOOL.requiresApproval(makeParams({ pattern: 'test' })), false)
    assert.equal(GLOB_TOOL.isConcurrencySafe(), true)
  })
})
