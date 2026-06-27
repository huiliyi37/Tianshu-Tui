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
