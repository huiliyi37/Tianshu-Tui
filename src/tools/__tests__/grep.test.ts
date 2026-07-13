import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { GREP_TOOL } from '../grep.js'
import { resetResolvedEnvCache } from '../resolved-env.js'

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

  it('returns error when pattern is missing or empty (no TypeError on artifact path)', async () => {
    for (const input of [{ path: 'src' }, { pattern: '' }, { pattern: '   ' }, { pattern: null }]) {
      const result = await GREP_TOOL.execute(makeParams(input))
      assert.equal(result.isError, true, JSON.stringify(input))
      assert.match(result.content, /pattern is required/i)
    }

    const result = await GREP_TOOL.execute(makeParams({ path: 'src', context_lines: 2 }))
    assert.equal(result.isError, true)
    assert.match(result.content, /input keys: context_lines, path/i)
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

  it('suggests bounded read_file ranges for single-file log matches', async () => {
    const logsDir = join(testDir, 'logs')
    mkdirSync(logsDir, { recursive: true })
    const lines = Array.from({ length: 200 }, (_, i) => i === 120 ? `L${i} ERROR failed` : `L${i} ok`)
    writeFileSync(join(logsDir, 'app.log'), lines.join('\n'))

    const result = await GREP_TOOL.execute(makeParams({ pattern: 'ERROR', path: 'logs/app.log', max_results: 10 }))

    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('Suggested next reads:'))
    assert.ok(result.content.includes('read_file(file_path="logs/app.log"'))
    assert.ok(result.content.includes('limit<=80'))
    assert.ok(!result.content.includes('scan the whole project'))
  })

  it('requiresApproval and isConcurrencySafe', () => {
    assert.equal(GREP_TOOL.requiresApproval(makeParams({ pattern: 'test' })), false)
    assert.equal(GREP_TOOL.isConcurrencySafe(), true)
  })

  it('prefixes slow-fallback notice when rg is unavailable (cross-platform)', async () => {
    // Force native path without relying on eperm-skip (Windows-skipped) or on
    // empty PATH alone (getResolvedEnv would restore a login-shell PATH that
    // still has rg). Disable env.resolve via project config, then empty PATH.
    const fbDir = mkdtempSync(join(tmpdir(), 'grep-fallback-'))
    const savedPath = process.env.PATH
    try {
      mkdirSync(join(fbDir, 'src'), { recursive: true })
      writeFileSync(join(fbDir, 'src', 'hit.ts'), 'const FALLBACK_NEEDLE = 1\n')
      writeFileSync(join(fbDir, '.rivet-config.json'), JSON.stringify({
        env: { resolve: false },
      }))
      resetResolvedEnvCache()
      process.env.PATH = join(fbDir, 'no-binaries-here')

      const result = await GREP_TOOL.execute({
        input: { pattern: 'FALLBACK_NEEDLE', path: 'src', literal: true },
        toolUseId: 'test',
        cwd: fbDir,
      })
      assert.ok(!result.isError, `grep must not error, got: ${result.content}`)
      assert.match(
        result.content!,
        /\[grep\] ripgrep \(rg\) not found or failed; using slow fallback/,
      )
      assert.ok(result.content.includes('hit.ts'))
      assert.ok(result.content.includes('FALLBACK_NEEDLE'))
    } finally {
      process.env.PATH = savedPath
      resetResolvedEnvCache()
      rmSync(fbDir, { recursive: true, force: true })
    }
  })

  it('context_lines shows surrounding lines (native fallback)', async () => {
    const ctxDir = mkdtempSync(join(tmpdir(), 'grep-ctx-'))
    try {
      mkdirSync(join(ctxDir, 'src'), { recursive: true })
      writeFileSync(join(ctxDir, 'src', 'target.ts'), [
        'line 1',
        'line 2',
        'MATCH_HERE',
        'line 4',
        'line 5',
        'line 6',
      ].join('\n'))

      // Without context
      const noCtx = await GREP_TOOL.execute({
        input: { pattern: 'MATCH_HERE', path: 'src', literal: true },
        toolUseId: 'test',
        cwd: ctxDir,
      })
      assert.ok(noCtx.content.includes('MATCH_HERE'))
      assert.ok(!noCtx.content.includes('line 2'))

      // With context=1
      const ctx1 = await GREP_TOOL.execute({
        input: { pattern: 'MATCH_HERE', path: 'src', literal: true, context_lines: 1 },
        toolUseId: 'test',
        cwd: ctxDir,
      })
      assert.ok(ctx1.content.includes('MATCH_HERE'))
      assert.ok(ctx1.content.includes('line 2'), 'context_lines=1 should include line before match')
      assert.ok(ctx1.content.includes('line 4'), 'context_lines=1 should include line after match')
      assert.ok(!ctx1.content.includes('line 1'), 'context_lines=1 should NOT include 2 lines before')

      // With context=2
      const ctx2 = await GREP_TOOL.execute({
        input: { pattern: 'MATCH_HERE', path: 'src', literal: true, context_lines: 2 },
        toolUseId: 'test',
        cwd: ctxDir,
      })
      assert.ok(ctx2.content.includes('line 1'), 'context_lines=2 should include 2 lines before match')
      assert.ok(ctx2.content.includes('line 5'), 'context_lines=2 should include 2 lines after match')
    } finally {
      rmSync(ctxDir, { recursive: true, force: true })
    }
  })

  it('truncates large output to ~8000 chars by default', async () => {
    // Generate enough matches to exceed the default 8000-char model cap.
    const bigDir = mkdtempSync(join(tmpdir(), 'grep-bigout-'))
    try {
      mkdirSync(join(bigDir, 'src'), { recursive: true })
      // 500 lines × ~50 chars/line ≈ 25 000 chars — well above the 8 000 default.
      const lines = Array.from({ length: 500 }, (_, i) => `MATCH_TOKEN line ${i} payload-payload-payload`)
      writeFileSync(join(bigDir, 'src', 'big.ts'), lines.join('\n'))

      const result = await GREP_TOOL.execute({
        input: { pattern: 'MATCH_TOKEN', path: 'src', max_results: 1000, literal: true },
        toolUseId: 'test',
        cwd: bigDir,
      })
      assert.equal(result.isError, undefined)
      // Default cap = 8000 chars; allow a bit for the truncation marker.
      assert.ok(result.content.length <= 8200,
        `default cap should keep output ≤ ~8000 chars, got ${result.content.length}`)
    } finally {
      rmSync(bigDir, { recursive: true, force: true })
    }
  })

  it('returns more content when a larger contextWindow is plumbed through', async () => {
    const bigDir = mkdtempSync(join(tmpdir(), 'grep-bigwindow-'))
    try {
      mkdirSync(join(bigDir, 'src'), { recursive: true })
      const lines = Array.from({ length: 500 }, (_, i) => `MATCH_TOKEN line ${i} payload-payload-payload`)
      writeFileSync(join(bigDir, 'src', 'big.ts'), lines.join('\n'))

      const baseline = await GREP_TOOL.execute({
        input: { pattern: 'MATCH_TOKEN', path: 'src', max_results: 1000, literal: true },
        toolUseId: 'test',
        cwd: bigDir,
      })

      // 200k window, balanced strategy → ~40 000 chars cap, well above raw size.
      const wide = await GREP_TOOL.execute({
        input: { pattern: 'MATCH_TOKEN', path: 'src', max_results: 1000, literal: true },
        toolUseId: 'test',
        cwd: bigDir,
        contextWindow: 200_000,
      })

      assert.ok(wide.content.length > baseline.content.length * 2,
        `wider window should give materially more content: baseline=${baseline.content.length}, wide=${wide.content.length}`)
    } finally {
      rmSync(bigDir, { recursive: true, force: true })
    }
  })
})
