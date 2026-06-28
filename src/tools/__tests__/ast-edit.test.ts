import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Tool, ToolCallParams } from '../types.js'

let astEdit: Tool

const testDir = join(process.cwd(), '.test-tmp', `ast-edit-${randomBytes(4).toString('hex')}`)

const tsFixture = `
var count = 0
var total = 100
var name = "test"

function inc() {
  count = count + 1
}
`.trim()

async function setupFixtures(): Promise<void> {
  await rm(testDir, { recursive: true, force: true })
  await mkdir(testDir, { recursive: true })
  await writeFile(join(testDir, 'sample.ts'), tsFixture)
  await writeFile(join(testDir, 'write-test.ts'), tsFixture)
  await writeFile(join(testDir, 'broken.ts'), 'var x = {')
  await writeFile(join(testDir, 'other.ts'), 'var a = 1\nvar b = 2')
}

before(async () => {
  await setupFixtures()
  const mod = await import('../ast-edit.js')
  astEdit = mod.AST_EDIT_TOOL
})

async function call(params: Record<string, unknown>): Promise<string> {
  const result = await astEdit.execute({
    input: params,
    cwd: testDir,
    toolUseId: 'test-edit',
    abortSignal: new AbortController().signal,
    onOutput: undefined,
  } as unknown as ToolCallParams)
  if (result.isError) throw new Error(result.content)
  return result.content
}

// ── dryRun (default true) ─────────────────────────────────────────

describe('ast-edit dryRun mode', () => {
  it('reports changes without writing to file by default', async () => {
    const out = await call({
      ops: [{ find: 'var $NAME = $VAL', replace: 'const $NAME = $VAL' }],
      paths: ['sample.ts'],
      lang: 'TypeScript',
    })
    // Should show preview of changes
    assert.ok(out.includes('var') || out.includes('const'), `expected change preview, got: ${out}`)

    // File should NOT be modified
    const content = await readFile(join(testDir, 'sample.ts'), 'utf-8')
    assert.ok(content.includes('var count'), 'file should still contain var declarations')
  })

  it('writes changes when dryRun is false', async () => {
    const out = await call({
      ops: [{ find: 'var $NAME = $VAL', replace: 'const $NAME = $VAL' }],
      paths: ['write-test.ts'],
      lang: 'TypeScript',
      dryRun: false,
    })
    assert.ok(out.includes('const'), `expected applied changes, got: ${out}`)

    const content = await readFile(join(testDir, 'write-test.ts'), 'utf-8')
    assert.ok(!content.includes('var count'), 'file should have const declarations')
    assert.ok(content.includes('const count'), 'file should have const declarations')
  })
})

// ── basic replace ─────────────────────────────────────────────────

describe('ast-edit pattern replace', () => {
  it('replaces matched nodes with template', async () => {
    const out = await call({
      ops: [{ find: 'var $NAME = $VAL', replace: 'let $NAME = $VAL' }],
      paths: ['sample.ts'],
      lang: 'TypeScript',
      dryRun: true,
    })
    assert.ok(out.includes('let'), `expected let replacement, got: ${out}`)
  })

  it('returns empty when pattern has no matches', async () => {
    const out = await call({
      ops: [{ find: 'class $NAME { $$$ }', replace: 'interface $NAME { $$$ }' }],
      paths: ['sample.ts'],
      lang: 'TypeScript',
      dryRun: true,
    })
    assert.ok(out.includes('0 change') || out.includes('0 file') || out.includes('no change'),
      `expected no-change message, got: ${out}`)
  })

  it('applies multiple ops sequentially on same file', async () => {
    const out = await call({
      ops: [
        { find: 'var $NAME = $VAL', replace: 'const $NAME = $VAL' },
        { find: 'function inc() { $$$BODY }', replace: 'function increment() { $$$BODY }' },
      ],
      paths: ['sample.ts'],
      lang: 'TypeScript',
      dryRun: true,
    })
    assert.ok(out.includes('increment'), `expected function rename, got: ${out}`)
  })
})

// ── error handling ────────────────────────────────────────────────

describe('ast-edit error handling', () => {
  it('rejects empty ops array', async () => {
    try {
      await call({ ops: [], paths: ['sample.ts'] })
      assert.fail('should have thrown')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      assert.ok(msg.includes('find/replace') || msg.includes('op'),
        `expected ops error, got: ${msg}`)
    }
  })

  it('skips files with parse errors and warns', async () => {
    const out = await call({
      ops: [{ find: 'var $X = $Y', replace: 'const $X = $Y' }],
      paths: ['broken.ts'],
      lang: 'TypeScript',
      dryRun: true,
    })
    assert.ok(out.includes('error') || out.includes('parse'), `expected parse warning, got: ${out}`)
  })
})

// ── multi-file ────────────────────────────────────────────────────

describe('ast-edit multi-file', () => {
  it('processes multiple files', async () => {
    const out = await call({
      ops: [{ find: 'var $NAME = $VAL', replace: 'const $NAME = $VAL' }],
      paths: ['sample.ts', 'other.ts'],
      lang: 'TypeScript',
      dryRun: true,
    })
    // Should mention both files or have multiple changes
    assert.ok(
      out.includes('sample.ts') || out.includes('other.ts') || out.includes('2 file'),
      `expected multi-file output, got: ${out}`,
    )
  })
})

// ── onFileWrite callback ──────────────────────────────────────────

describe('ast-edit onFileWrite', () => {
  it('calls onFileWrite with file path when dryRun is false', async () => {
    // fresh file to avoid pollution from prior dryRun:false test
    const fixtureFile = join(testDir, 'onfilewrite-test.ts')
    await writeFile(fixtureFile, 'var x = 1\nvar y = 2')

    const written: string[] = []
    const result = await astEdit.execute({
      input: {
        ops: [{ find: 'var $NAME = $VAL', replace: 'const $NAME = $VAL' }],
        paths: ['onfilewrite-test.ts'],
        lang: 'TypeScript',
        dryRun: false,
      },
      cwd: testDir,
      toolUseId: 'test-onfilewrite',
      abortSignal: new AbortController().signal,
      onOutput: undefined,
      onFileWrite: (path: string) => written.push(path),
    } as unknown as ToolCallParams)
    assert.ok(!result.isError, `unexpected error: ${result.content}`)
    assert.ok(written.length >= 1, `expected at least 1 onFileWrite call, got ${written.length}`)
    assert.ok(written.some(p => p.includes('onfilewrite-test.ts')), `expected onfilewrite-test.ts in ${written.join(', ')}`)
  })

  it('does NOT call onFileWrite when dryRun is true', async () => {
    const written: string[] = []
    await astEdit.execute({
      input: {
        ops: [{ find: 'var $NAME = $VAL', replace: 'const $NAME = $VAL' }],
        paths: ['sample.ts'],
        lang: 'TypeScript',
        dryRun: true,
      },
      cwd: testDir,
      toolUseId: 'test-onfilewrite-dry',
      abortSignal: new AbortController().signal,
      onOutput: undefined,
      onFileWrite: (path: string) => written.push(path),
    } as unknown as ToolCallParams)
    assert.equal(written.length, 0, `expected 0 onFileWrite calls in dryRun mode, got ${written.length}`)
  })

  // ── post-edit syntax gate (#2) ────────────────────────────────────
  // A replacement whose template itself introduces invalid syntax (unbalanced
  // braces) must be caught by the post-edit ERROR-node check and the file must
  // NOT be written. Without the gate, a broken file would persist silently.

  it('does NOT write a file when the replace introduces a syntax error', async () => {
    const target = join(testDir, 'syntax-gate-test.ts')
    await writeFile(target, 'var x = 1\nvar y = 2\n')
    const before = await readFile(target, 'utf-8')
    const result = await astEdit.execute({
      input: {
        // replace with an unbalanced brace — valid ast-grep template, invalid TS
        ops: [{ find: 'var $NAME = $VAL', replace: 'var $NAME = {{{' }],
        paths: ['syntax-gate-test.ts'],
        lang: 'TypeScript',
        dryRun: false,
      },
      cwd: testDir,
      toolUseId: 'test-syntax-gate',
      abortSignal: new AbortController().signal,
      onOutput: undefined,
    } as unknown as ToolCallParams)
    const after = await readFile(target, 'utf-8')
    assert.equal(after, before, 'file must be unchanged when post-edit syntax check fails')
    assert.ok(result.content.includes('NOT written') || result.content.includes('syntax error'),
      `expected post-edit syntax gate error in output, got: ${result.content}`)
  })

  // ── multi-line dryRun diff (#6) ───────────────────────────────────

  it('dryRun preview shows multi-line before/after as separate blocks, not collapsed \\n', async () => {
    // A function-body match spans multiple lines. The preview must show the
    // actual line shape (not collapse to \n) so the model can judge the change.
    const target = join(testDir, 'multiline-preview.ts')
    await writeFile(target, 'function inc() {\n  count = count + 1\n}\n')
    const out = await call({
      ops: [{ find: 'function $NAME($$$A) { $$$B }', replace: 'async function $NAME($$$A) { $$$B }' }],
      paths: ['multiline-preview.ts'],
      lang: 'TypeScript',
      dryRun: true,
    })
    // Multi-line aware: before/after on separate lines with - / + markers,
    // not a single line with literal \n.
    assert.ok(out.includes('async function'), `expected the replacement in preview, got: ${out}`)
    assert.ok(!out.includes('\\n'), `multi-line change should not be collapsed to literal \\n: ${out}`)
  })
})
