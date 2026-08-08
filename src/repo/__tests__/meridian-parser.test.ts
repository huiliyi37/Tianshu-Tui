import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { parseTypeScriptFile, initParser } from '../meridian-parser.js'

describe('meridian parser', () => {
  before(async () => {
    await initParser()
  })

  it('extracts exported function', async () => {
    const result = await parseTypeScriptFile('test.ts', 'export function hello(name: string): void {}')
    const fn = result.symbols.find(s => s.name === 'hello')
    assert.ok(fn)
    assert.equal(fn.kind, 'function')
    assert.equal(fn.exported, true)
    assert.equal(fn.line, 1)
  })

  it('extracts class with methods', async () => {
    const source = `export class Worker {\n  run(): void {}\n  stop(): void {}\n}`
    const result = await parseTypeScriptFile('test.ts', source)
    const cls = result.symbols.find(s => s.name === 'Worker')
    assert.ok(cls)
    assert.equal(cls.kind, 'class')
    const methods = result.symbols.filter(s => s.kind === 'method')
    assert.equal(methods.length, 2)
  })

  it('extracts import edges', async () => {
    const source = `import { foo } from './foo.js'\nimport type { Bar } from '../bar.js'`
    const result = await parseTypeScriptFile('test.ts', source)
    assert.deepEqual(result.imports, ['./foo.js', '../bar.js'])
  })

  it('extracts interfaces and types', async () => {
    const source = `export interface Config { name: string }\ntype Internal = number`
    const result = await parseTypeScriptFile('test.ts', source)
    const iface = result.symbols.find(s => s.name === 'Config')
    assert.ok(iface)
    assert.equal(iface.kind, 'interface')
    assert.equal(iface.exported, true)
    const typ = result.symbols.find(s => s.name === 'Internal')
    assert.ok(typ)
    assert.equal(typ.kind, 'type')
    assert.equal(typ.exported, false)
  })

  it('extracts arrow function as function', async () => {
    const result = await parseTypeScriptFile('test.ts', 'export const run = async () => {}')
    const fn = result.symbols.find(s => s.name === 'run')
    assert.ok(fn)
    assert.equal(fn.kind, 'function')
  })

  it('returns content hash', async () => {
    const result = await parseTypeScriptFile('test.ts', 'const x = 1')
    assert.ok(result.contentHash.length > 0)
  })

  it('extracts same-file calls as extracted confidence', async () => {
    const result = await parseTypeScriptFile('test.ts', 'function a() {}\nfunction b() { a() }')
    const call = result.edges.find(e => e.kind === 'calls')
    assert.ok(call, 'expected a calls edge')
    assert.equal(call.sourceId, 'test.ts:b:2')
    assert.equal(call.targetId, 'test.ts:a:1')
    assert.equal(call.confidence, 'extracted')
  })

  it('leaves same-file-unresolved calls for cross-file matching', async () => {
    const result = await parseTypeScriptFile('test.ts', 'function a() { foo() }')
    const localCall = result.edges.find(e => e.kind === 'calls')
    assert.equal(localCall, undefined, 'no local target, so no extracted calls edge')
    assert.deepEqual(result.calls, [{ sourceId: 'test.ts:a:1', name: 'foo', line: 1 }])
  })

  it('extracts method calls within a class as extracted', async () => {
    const source = 'class C {\n  run(): void {}\n  go(): void { this.run() }\n}'
    const result = await parseTypeScriptFile('test.ts', source)
    const call = result.edges.find(e => e.kind === 'calls')
    assert.ok(call, 'expected a calls edge for this.run()')
    assert.equal(call.sourceId, 'test.ts:go:3')
    assert.equal(call.targetId, 'test.ts:run:2')
    assert.equal(call.confidence, 'extracted')
  })

  it('resolves hoisted calls — callee declared after the caller — as extracted', async () => {
    const result = await parseTypeScriptFile('test.ts', 'function a() { b() }\nfunction b() {}')
    const call = result.edges.find(e => e.kind === 'calls')
    assert.ok(call, 'expected a calls edge despite the callee being declared later')
    assert.equal(call.sourceId, 'test.ts:a:1')
    assert.equal(call.targetId, 'test.ts:b:2')
    assert.equal(call.confidence, 'extracted')
  })

  it('leaves dynamic callees (IIFE) without a calls edge or pending call site', async () => {
    const result = await parseTypeScriptFile('test.ts', 'function a() { (function(){})() }')
    assert.equal(result.edges.filter(e => e.kind === 'calls').length, 0, 'IIFE must not produce a calls edge')
    assert.deepEqual(result.calls, [], 'IIFE must not produce a pending call site')
  })

  it('splits chained calls into member name plus base callee', async () => {
    const result = await parseTypeScriptFile('test.ts', 'function a() { b().c() }')
    const names = result.calls.map(c => c.name).sort()
    assert.deepEqual(names, ['b', 'c'], 'chained b().c() yields both the base call and the member name')
  })
})
