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
})
