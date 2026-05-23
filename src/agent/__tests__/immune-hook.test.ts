import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ImmuneHook } from '../immune-hook.js'
import { PhysarumEngine } from '../../repo/physarum-engine.js'

const stubDb = {} as any

describe('ImmuneHook', () => {
  function createHook() {
    const physarum = new PhysarumEngine(stubDb)
    return new ImmuneHook({ physarum })
  }

  it('does not activate on normal tool calls', () => {
    const hook = createHook()
    const result = hook.run({
      toolName: 'read_file', fingerprint: 'fp1', turn: 1,
      doomLevel: 'none', targetFile: 'src/a.ts',
    })
    assert.equal(result.activated, false)
  })

  it('does not activate with doom but no danger signals', () => {
    const hook = createHook()
    // Single doom warning without accumulated danger
    const result = hook.run({
      toolName: 'read_file', fingerprint: 'fp1', turn: 1,
      doomLevel: 'warn', targetFile: 'src/a.ts',
    })
    assert.equal(result.activated, false)
  })

  it('activates with doom + repeated tool (dual signal)', () => {
    const hook = createHook()
    // Build up danger: repeat same fingerprint 4x to get severity 4/5=0.8 per signal
    hook.run({ toolName: 'grep', fingerprint: 'same', turn: 1, doomLevel: 'none', targetFile: 'src/a.ts' })
    hook.run({ toolName: 'grep', fingerprint: 'same', turn: 2, doomLevel: 'none', targetFile: 'src/a.ts' })
    hook.run({ toolName: 'grep', fingerprint: 'same', turn: 3, doomLevel: 'none', targetFile: 'src/a.ts' })
    hook.run({ toolName: 'grep', fingerprint: 'same', turn: 4, doomLevel: 'none', targetFile: 'src/a.ts' })
    // Fifth time with doom level → accumulated signals should exceed threshold
    const result = hook.run({
      toolName: 'grep', fingerprint: 'same', turn: 5,
      doomLevel: 'warn', targetFile: 'src/a.ts',
    })
    assert.equal(result.activated, true)
  })

  it('activates with doom + trajectory escalation + token spike', () => {
    const hook = createHook()
    // Build baseline token usage
    hook.run({ toolName: 'bash', fingerprint: 'fp1', turn: 1, doomLevel: 'none', targetFile: 'src/b.ts', tokenUsage: 100 })
    hook.run({ toolName: 'bash', fingerprint: 'fp2', turn: 2, doomLevel: 'none', targetFile: 'src/b.ts', tokenUsage: 100 })
    hook.run({ toolName: 'bash', fingerprint: 'fp3', turn: 3, doomLevel: 'none', targetFile: 'src/b.ts', tokenUsage: 100 })
    // Now escalation + token spike + doom → multiple signals exceed threshold
    const result = hook.run({
      toolName: 'bash', fingerprint: 'fp-bash', turn: 5,
      doomLevel: 'blocked', targetFile: 'src/b.ts',
      trajectoryHealth: 'escalate', tokenUsage: 500,
    })
    assert.equal(result.activated, true)
    assert.ok(result.signals.some(s => s.kind === 'prediction_error'))
  })

  it('records and uses immune memory for fast secondary response', () => {
    const hook = createHook()
    // Record a successful repair
    hook.recordRepairSuccess('doom:grep:pattern', 'use find_files instead', 10)

    // Build danger + doom
    hook.run({ toolName: 'grep', fingerprint: 'x', turn: 11, doomLevel: 'none', targetFile: 'a.ts', tokenUsage: 100 })
    hook.run({ toolName: 'grep', fingerprint: 'x', turn: 12, doomLevel: 'none', targetFile: 'a.ts', tokenUsage: 100 })
    hook.run({ toolName: 'grep', fingerprint: 'x', turn: 13, doomLevel: 'none', targetFile: 'a.ts', tokenUsage: 100 })

    // Now lookup should find memory
    const memory = hook.adaptive.lookup('doom:grep:pattern')
    assert.ok(memory)
    assert.equal(memory.response, 'use find_files instead')
  })

  it('feeds flow data to Physarum engine', () => {
    const physarum = new PhysarumEngine(stubDb)
    const hook = new ImmuneHook({ physarum })

    hook.run({ toolName: 'read_file', fingerprint: 'fp1', turn: 1, doomLevel: 'none', targetFile: 'src/a.ts' })
    hook.run({ toolName: 'edit_file', fingerprint: 'fp2', turn: 1, doomLevel: 'none', targetFile: 'src/a.ts' })

    // Physarum should have recorded flow for read_file→src/a.ts edge
    const edge = physarum.getEdge('read_file', 'src/a.ts')
    assert.ok(edge)
    assert.ok(edge.weight > 0)
  })

  it('runs batch maintenance periodically', () => {
    const physarum = new PhysarumEngine(stubDb)
    const hook = new ImmuneHook({ physarum })

    // Run 11 turns to trigger batch evolve (interval = 10)
    for (let i = 1; i <= 11; i++) {
      hook.run({ toolName: 'read', fingerprint: `fp${i}`, turn: i, doomLevel: 'none', targetFile: `f${i}.ts` })
    }
    // Should not throw
    assert.ok(true)
  })

  it('getDangerLevel reflects accumulated signals', () => {
    const hook = createHook()
    hook.run({ toolName: 'grep', fingerprint: 'same', turn: 1, doomLevel: 'none', targetFile: 'a.ts' })
    hook.run({ toolName: 'grep', fingerprint: 'same', turn: 2, doomLevel: 'none', targetFile: 'a.ts' })
    hook.run({ toolName: 'grep', fingerprint: 'same', turn: 3, doomLevel: 'none', targetFile: 'a.ts' })
    const level = hook.getDangerLevel(3)
    assert.ok(level > 0)
  })
})
