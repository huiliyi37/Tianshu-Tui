import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ImmuneAdaptiveLayer } from '../immune-adaptive.js'
import type { ImmuneResponse } from '../immune-types.js'

describe('ImmuneMemory structured response', () => {
  it('records and retrieves a quarantine response with targetFile', () => {
    const layer = new ImmuneAdaptiveLayer()
    const response: ImmuneResponse = { type: 'quarantine', targetFile: 'src/foo.ts', duration: 20 }
    layer.recordSuccess('fp_abc', response, 10)

    const mem = layer.lookup('fp_abc')
    assert.ok(mem)
    assert.equal(mem.response.type, 'quarantine')
    assert.equal(mem.response.targetFile, 'src/foo.ts')
    assert.equal(mem.response.duration, 20)
  })

  it('records and retrieves a boost_healthy response with healthyEdges', () => {
    const layer = new ImmuneAdaptiveLayer()
    const response: ImmuneResponse = {
      type: 'boost_healthy',
      healthyEdges: [{ fileA: 'src/a.ts', fileB: 'src/b.ts' }],
    }
    layer.recordSuccess('fp_xyz', response, 11)
    const mem = layer.lookup('fp_xyz')
    assert.ok(mem)
    assert.equal(mem.response.type, 'boost_healthy')
    assert.equal(mem.response.healthyEdges?.[0]?.fileA, 'src/a.ts')
  })

  it('export and import preserve structured response', () => {
    const layer = new ImmuneAdaptiveLayer()
    layer.recordSuccess('fp_1', { type: 'deposit_warning', targetFile: 'f.ts' }, 1)
    const exported = layer.export()
    assert.equal(exported.length, 1)
    assert.equal(exported[0]!.response.type, 'deposit_warning')

    const layer2 = new ImmuneAdaptiveLayer()
    layer2.import(exported)
    const mem = layer2.lookup('fp_1')
    assert.ok(mem)
    assert.equal(mem.response.targetFile, 'f.ts')
  })

  it('fastRepair returns structured response from memory', () => {
    const layer = new ImmuneAdaptiveLayer()
    const response: ImmuneResponse = { type: 'quarantine', targetFile: 'src/foo.ts', duration: 15 }
    layer.recordSuccess('fp_doom', response, 10)

    const mem = layer.lookup('fp_doom')
    assert.ok(mem)
    const repair = layer.fastRepair(mem)
    assert.equal(repair.type, 'quarantine')
    assert.equal(repair.targetFile, 'src/foo.ts')
  })
})
