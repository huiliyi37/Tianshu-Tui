import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ImmuneHook } from '../immune-hook.js'
import { PhysarumEngine } from '../../repo/physarum-engine.js'

describe('Immune learning wire — recordRepairSuccess via tool-pipeline', () => {
  it('adaptive memory grows when recordRepairSuccess is called with structured response', () => {
    const hook = new ImmuneHook({ physarum: new PhysarumEngine(null as any) })
    const fingerprint = 'bash:ls /tmp'

    assert.equal(hook.adaptive.lookup(fingerprint), null, 'memory empty initially')

    hook.recordRepairSuccess(fingerprint, {
      type: 'quarantine',
      targetFile: '/tmp/foo.ts',
      duration: 30,
    }, 5)

    const memory = hook.adaptive.lookup(fingerprint)
    assert.ok(memory, 'memory should be created')
    assert.equal(memory.response.type, 'quarantine')
    assert.equal(memory.response.targetFile, '/tmp/foo.ts')
  })

  it('hitCount accumulates across multiple successes', () => {
    const hook = new ImmuneHook({ physarum: new PhysarumEngine(null as any) })
    const fingerprint = 'edit:file.ts'

    hook.recordRepairSuccess(fingerprint, { type: 'boost_healthy' }, 1)
    hook.recordRepairSuccess(fingerprint, { type: 'boost_healthy' }, 2)
    hook.recordRepairSuccess(fingerprint, { type: 'boost_healthy' }, 3)

    const memory = hook.adaptive.lookup(fingerprint)
    assert.ok(memory)
    assert.equal(memory.hitCount, 3)
  })
})
