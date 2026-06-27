import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

// We import the tool creator after TypeScript compilation, but for
// node:test with tsx we import directly from the .ts source.
import type { Tool, ToolCallParams } from '../types.js'

// Will be set when ast-grep.ts is created
let astGrep: Tool

// Use a project-relative temp dir (sandbox blocks /tmp outside workspace)
const testDir = join(process.cwd(), '.test-tmp', `ast-grep-${randomBytes(4).toString('hex')}`)

const tsFixture = `
function foo(a: number) {
  return a + 1
}

const bar = (x: string) => x.toUpperCase()

function baz(b: string, c: number) {
  console.log(b, c)
}

class MyClass {
  greet() {
    return "hello"
  }
}
`.trim()

const jsFixture = `
function multiply(a, b) {
  return a * b
}
const result = multiply(3, 4)
`.trim()

async function setupFixtures(): Promise<void> {
  await rm(testDir, { recursive: true, force: true })
  await mkdir(testDir, { recursive: true })
  await writeFile(join(testDir, 'sample.ts'), tsFixture)
  await writeFile(join(testDir, 'sample.js'), jsFixture)
  await writeFile(join(testDir, 'broken.ts'), 'function foo( {')
  await writeFile(join(testDir, 'sample.rs'), 'fn main() { println!("hello"); }')
}

before(async () => {
  await setupFixtures()
  // Dynamic import after test file is written — will fail until ast-grep.ts exists
  const mod = await import('../ast-grep.js')
  astGrep = mod.AST_GREP_TOOL
})

async function call(params: Record<string, unknown>): Promise<string> {
  const result = await astGrep.execute({
    input: params,
    cwd: testDir,
    toolUseId: 'test-1',
    abortSignal: new AbortController().signal,
    onOutput: undefined,
  } as unknown as ToolCallParams)
  if (result.isError) throw new Error(result.content)
  return result.content
}

// ── pattern matching ──────────────────────────────────────────────

describe('ast-grep pattern matching', () => {
  it('finds function declarations by pattern', async () => {
    const out = await call({
      pattern: 'function $NAME($$$ARGS) { $$$BODY }',
      paths: ['sample.ts'],
      lang: 'TypeScript',
    })
    assert.ok(out.includes('foo'), 'should find function foo')
    assert.ok(out.includes('baz'), 'should find function baz')
  })

  it('returns empty when no nodes match', async () => {
    const out = await call({
      pattern: 'class $NAME extends $SUPER { $$$ }',
      paths: ['sample.ts'],
      lang: 'TypeScript',
    })
    assert.ok(out.includes('0 match'), out)
  })

  it('supports rule-based matching', async () => {
    const out = await call({
      pattern: JSON.stringify({ rule: { kind: 'function_declaration' } }),
      paths: ['sample.ts'],
      lang: 'TypeScript',
    })
    assert.ok(out.includes('foo') || out.includes('baz'), 'should find at least one function')
  })
})

// ── language inference ────────────────────────────────────────────

describe('ast-grep language handling', () => {
  it('infers TypeScript from .ts extension', async () => {
    const out = await call({
      pattern: 'const $NAME = $$$',
      paths: ['sample.ts'],
    })
    assert.ok(out.includes('bar'), 'should find const bar')
  })

  it('infers JavaScript from .js extension', async () => {
    const out = await call({
      pattern: 'function $NAME($$$) { $$$ }',
      paths: ['sample.js'],
    })
    assert.ok(out.includes('multiply'), 'should find multiply function')
  })

  it('reports error for unsupported extension', async () => {
    const result = await astGrep.execute({
      input: { pattern: 'fn $NAME()', paths: ['sample.rs'] },
      cwd: testDir,
      toolUseId: 'test-unsupported',
      abortSignal: new AbortController().signal,
      onOutput: undefined,
    } as unknown as ToolCallParams)
    assert.ok(result.content.includes('unsupported') || result.content.includes('error'),
      `expected unsupported language error, got: ${result.content}`)
  })
})

// ── error handling ────────────────────────────────────────────────

describe('ast-grep error handling', () => {
  it('skips files with parse errors and warns', async () => {
    const out = await call({
      pattern: 'function $NAME() { $$$ }',
      paths: ['broken.ts'],
      lang: 'TypeScript',
    })
    assert.ok(out.includes('parse error') || out.includes('error'), `expected parse warning, got: ${out}`)
  })

  it('rejects empty pattern', async () => {
    try {
      await call({
        pattern: '   ',
        paths: ['sample.ts'],
      })
      assert.fail('should have thrown')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      assert.ok(msg.includes('pattern'), `expected pattern error, got: ${msg}`)
    }
  })
})

// ── meta-variables ────────────────────────────────────────────────

describe('ast-grep meta-variables', () => {
  it('captures named meta-variables when includeMeta is true', async () => {
    const out = await call({
      pattern: 'function $NAME($$$ARGS) { $$$BODY }',
      paths: ['sample.ts'],
      lang: 'TypeScript',
      includeMeta: true,
    })
    assert.ok(out.includes('NAME=foo') || out.includes('NAME=baz'),
      `expected meta-variable NAME in output, got: ${out}`)
  })
})
