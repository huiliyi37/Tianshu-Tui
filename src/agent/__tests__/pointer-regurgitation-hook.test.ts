import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createPointerRegurgitationHook,
  POINTER_REGURGITATION_ESCALATION_THRESHOLD,
  POINTER_PROPHYLAXIS_WRITE_THRESHOLD,
} from '../hooks/pointer-regurgitation-hook.js'
import { POINTER_GUARD_ERROR_MARKER } from '../../tools/pointer-guard.js'
import type { RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'

interface SubmittedAdvisory {
  key: string
  priority: number
  category: string
  content: string
  ttl?: number
}

function makeCtx(turn = 1): RuntimeHookContext {
  return { snapshot: { turn } } as unknown as RuntimeHookContext
}

function guardRejection(tool: string): RuntimeToolEvent {
  return {
    name: tool,
    success: false,
    isError: true,
    resultContent: `Error: content is a ${POINTER_GUARD_ERROR_MARKER} ("[file written to …"), not real file contents.`,
  }
}

function successfulWrite(tool = 'write_file'): RuntimeToolEvent {
  return { name: tool, success: true, resultContent: 'Wrote 10 lines' }
}

describe('pointer-regurgitation hook', () => {
  it('escalates on the FIRST guard rejection (2026-07-07 首犯即发)', () => {
    const submitted: SubmittedAdvisory[] = []
    const hook = createPointerRegurgitationHook({ advisoryBus: { submit: (a) => { submitted.push(a as SubmittedAdvisory) } } })

    hook.run(makeCtx(1), guardRejection('write_file'))
    assert.equal(submitted.length, 1, 'first offense already gets the mechanism explanation')
    assert.equal(submitted[0]!.key, 'pointer-regurgitation')
    assert.equal(submitted[0]!.category, 'discipline')
    assert.ok(submitted[0]!.content.includes('占位符'))
    assert.equal(POINTER_REGURGITATION_ESCALATION_THRESHOLD, 1)

    // Keeps firing on further offenses (the loop is the whole point),
    // counting across tools and turns.
    hook.run(makeCtx(3), guardRejection('hash_edit'))
    hook.run(makeCtx(4), guardRejection('edit_file'))
    assert.equal(submitted.length, 3)
    assert.ok(submitted[2]!.content.includes('3 次'))
  })

  it('injects a one-time prophylaxis after repeated successful writes, before any offense', () => {
    const submitted: SubmittedAdvisory[] = []
    const hook = createPointerRegurgitationHook({ advisoryBus: { submit: (a) => { submitted.push(a as SubmittedAdvisory) } } })

    hook.run(makeCtx(1), successfulWrite('write_file'))
    hook.run(makeCtx(1), successfulWrite('edit_file'))
    assert.equal(submitted.length, 0, 'below write threshold: silent')

    hook.run(makeCtx(2), successfulWrite('hash_edit'))
    assert.equal(POINTER_PROPHYLAXIS_WRITE_THRESHOLD, 3)
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0]!.key, 'pointer-prophylaxis')
    assert.ok(submitted[0]!.content.includes('[file written to …]'))

    // Fires once per session — further writes stay silent.
    hook.run(makeCtx(3), successfulWrite('write_file'))
    hook.run(makeCtx(3), successfulWrite('write_file'))
    assert.equal(submitted.length, 1)
  })

  it('suppresses prophylaxis once an offense already happened (escalation owns the message)', () => {
    const submitted: SubmittedAdvisory[] = []
    const hook = createPointerRegurgitationHook({ advisoryBus: { submit: (a) => { submitted.push(a as SubmittedAdvisory) } } })

    hook.run(makeCtx(1), guardRejection('write_file')) // offense → escalation advisory
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0]!.key, 'pointer-regurgitation')

    hook.run(makeCtx(2), successfulWrite())
    hook.run(makeCtx(2), successfulWrite())
    hook.run(makeCtx(2), successfulWrite())
    assert.equal(submitted.length, 1, 'prophylaxis is redundant after the full mechanism explanation')
  })

  it('ignores unrelated tool errors and successful non-write calls', () => {
    const submitted: SubmittedAdvisory[] = []
    const hook = createPointerRegurgitationHook({ advisoryBus: { submit: (a) => { submitted.push(a as SubmittedAdvisory) } } })

    hook.run(makeCtx(), { name: 'write_file', success: false, isError: true, resultContent: 'Error: File not found' })
    hook.run(makeCtx(), { name: 'bash', success: false, isError: true, resultContent: 'exit 1' })
    // Even a marker-containing SUCCESS result must not count (e.g. user file
    // containing the phrase) — only isError results are guard rejections.
    hook.run(makeCtx(), { name: 'read_file', success: true, resultContent: POINTER_GUARD_ERROR_MARKER })
    // Non-write successes never advance the prophylaxis counter.
    hook.run(makeCtx(), { name: 'bash', success: true, resultContent: 'ok' })
    hook.run(makeCtx(), { name: 'bash', success: true, resultContent: 'ok' })
    hook.run(makeCtx(), { name: 'bash', success: true, resultContent: 'ok' })
    assert.equal(submitted.length, 0)
  })
})
