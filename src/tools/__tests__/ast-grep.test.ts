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

function multiStmt(d: number) {
  const x = d * 2
  const y = x + 1
  if (y > 10) {
    return y
  }
  return x
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

  it('rejects regex tokens in bare pattern string', async () => {
    const result = await astGrep.execute({
      input: { pattern: 'function \\d+', paths: ['sample.ts'], lang: 'TypeScript' },
      cwd: testDir,
      toolUseId: 'test-regex',
      abortSignal: new AbortController().signal,
      onOutput: undefined,
    } as unknown as ToolCallParams)
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('regex tokens'), `expected regex misuse error, got: ${result.content}`)
  })

  it('allows regex-like strings inside JSON rule objects', async () => {
    const result = await astGrep.execute({
      input: {
        pattern: JSON.stringify({ rule: { kind: 'function_declaration', regex: '^foo' } }),
        paths: ['sample.ts'],
        lang: 'TypeScript',
      },
      cwd: testDir,
      toolUseId: 'test-rule-object',
      abortSignal: new AbortController().signal,
      onOutput: undefined,
    } as unknown as ToolCallParams)
    assert.equal(result.isError, undefined)
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

  it('multi-node meta-var shows shape summary (nodes/lines/first-line), not raw blob', async () => {
    // multiStmt has a 5-line body across multiple statements — $$$BODY captures
    // all of them. The summary must report the shape, not dump joined text.
    const out = await call({
      pattern: 'function $NAME($$$ARGS) { $$$BODY }',
      paths: ['sample.ts'],
      lang: 'TypeScript',
      includeMeta: true,
    })
    // Find the multiStmt match line
    const multiLine = out.split('\n').find(l => l.includes('multiStmt'))
    assert.ok(multiLine, `expected multiStmt in output: ${out}`)
    // Shape summary format: BODY=<nodeCount>n/<lineCount>L: <first line preview>
    // Must NOT be a raw joined code blob (no commas joining statements).
    const bodyMatch = multiLine!.match(/BODY=(\d+)n\/(\d+)L:\s*(.*)/)
    assert.ok(bodyMatch, `BODY should be a shape summary like "3n/5L: ...", got: ${multiLine}`)
    const [, nodeStr, lineStr, preview] = bodyMatch!
    assert.ok(parseInt(nodeStr!) >= 1, `node count should be >= 1, got ${nodeStr}`)
    assert.ok(parseInt(lineStr!) >= 4, `multiStmt body should span 4+ lines, got ${lineStr}`)
    assert.ok(preview!.length > 0 && preview!.length <= 50, `preview should be a short first-line, got "${preview}"`)
    // The preview should be the first statement, not a comma-joined blob
    assert.ok(!preview!.includes(', '), `preview should not be comma-joined statements, got "${preview}"`)
  })

  it('single-node meta-var stays as raw text (no shape summary)', async () => {
    // $NAME is a single-node capture — it should stay as the identifier text,
    // not get a "1n/1L:" prefix. Only $$$ multi-node vars get shape summaries.
    const out = await call({
      pattern: 'function $NAME($$$ARGS) { $$$BODY }',
      paths: ['sample.ts'],
      lang: 'TypeScript',
      includeMeta: true,
    })
    // NAME=foo (raw identifier), NOT NAME=1n/1L: foo
    // Match NAME= followed by its value up to the next comma/space — must NOT
    // start with the "<digits>n/" shape-summary prefix.
    const nameMatch = out.match(/NAME=([^,\]]+)/)
    assert.ok(nameMatch, `expected NAME= in output: ${out}`)
    const nameVal = nameMatch![1]!
    assert.ok(!/^\d+n\//.test(nameVal), `single-node NAME should not have shape summary, got "NAME=${nameVal}"`)
    assert.equal(nameVal, 'foo', `NAME should be raw identifier "foo", got "${nameVal}"`)
  })
})
