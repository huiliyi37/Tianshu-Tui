import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { GREP_TOOL } from '../grep.js'

describe('GREP_TOOL', () => {
  let testDir: string

  before(() => {
    testDir = mkdtempSync(join(tmpdir(), 'grep-test-'))
    mkdirSync(join(testDir, 'src'))
    writeFileSync(join(testDir, 'src', 'app.ts'), [
      'function handleSubmit() {',
      '  const API_KEY = "secret"',
      '  return API_KEY',
      '}',
      'function render() {',
      '  console.log("hello")',
      '}',
    ].join('\n'))
    writeFileSync(join(testDir, 'src', 'utils.ts'), [
      'export function helper() {',
      '  const API_KEY = "other"',
      '  return API_KEY',
      '}',
    ].join('\n'))
    writeFileSync(join(testDir, 'src', 'style.css'), 'body { margin: 0; }')
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

  it('finds matching lines in files', async () => {
    const result = await GREP_TOOL.execute(makeParams({ pattern: 'API_KEY', path: 'src' }))
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('API_KEY'))
    assert.ok(result.content.includes('app.ts'))
    assert.ok(result.content.includes('utils.ts'))
  })

  it('respects max_results limit', async () => {
    const result = await GREP_TOOL.execute(makeParams({ pattern: 'API_KEY', path: 'src', max_results: 1 }))
    assert.equal(result.isError, undefined)
    const lines = result.content.split('\n').filter(l => l.includes('API_KEY'))
    assert.ok(lines.length <= 1)
  })

  it('literal mode does not interpret regex special chars', async () => {
    writeFileSync(join(testDir, 'src', 'regex-test.ts'), [
      'const str = "a.b"',
      'const dot = /a.b/',
    ].join('\n'))

    const result = await GREP_TOOL.execute(makeParams({
      pattern: 'a.b',
      path: 'src',
      literal: true,
    }))
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('a.b'))
  })

  it('glob filter restricts to matching files', async () => {
    const result = await GREP_TOOL.execute(makeParams({
      pattern: 'API_KEY',
      path: 'src',
      glob: '*.ts',
    }))
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('app.ts'))
    assert.ok(result.content.includes('utils.ts'))
    assert.ok(!result.content.includes('style.css'))
  })

  it('returns no matches message when nothing found', async () => {
    const result = await GREP_TOOL.execute(makeParams({ pattern: 'ZZZ_NOT_EXIST', path: 'src' }))
    assert.ok(result.content.includes('No matches found'))
  })

  it('rejects parent directory traversal in search path', async () => {
    const result = await GREP_TOOL.execute(makeParams({ pattern: 'secret', path: '..' }))
    assert.equal(result.isError, true)
    assert.match(result.content, /outside project directory/i)
  })

  it('rejects absolute paths outside cwd', async () => {
    const result = await GREP_TOOL.execute(makeParams({ pattern: 'secret', path: tmpdir() }))
    assert.equal(result.isError, true)
    assert.match(result.content, /outside project directory/i)
  })

  it('enforces max_results globally', async () => {
    const manyDir = mkdtempSync(join(tmpdir(), 'grep-many-'))
    try {
      mkdirSync(join(manyDir, 'src'), { recursive: true })
      for (let i = 0; i < 5; i++) {
        writeFileSync(join(manyDir, 'src', `f${i}.ts`), 'MATCH\nMATCH\nMATCH\n')
      }

      const result = await GREP_TOOL.execute({
        input: { pattern: 'MATCH', path: 'src', max_results: 3, literal: true },
        toolUseId: 'test',
        cwd: manyDir,
      })

      const matches = result.content.split('\n').filter(line => line.includes('MATCH'))
      assert.ok(matches.length <= 3, `expected <= 3 matches, got ${matches.length}`)
    } finally {
      rmSync(manyDir, { recursive: true, force: true })
    }
  })

  it('requiresApproval and isConcurrencySafe', () => {
    assert.equal(GREP_TOOL.requiresApproval(makeParams({ pattern: 'test' })), false)
    assert.equal(GREP_TOOL.isConcurrencySafe(), true)
  })
})
