import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createPointerRegurgitationHook,
  POINTER_REGURGITATION_ESCALATION_THRESHOLD,
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

describe('pointer-regurgitation hook', () => {
  it('stays silent below the escalation threshold', () => {
    const submitted: SubmittedAdvisory[] = []
    const hook = createPointerRegurgitationHook({ advisoryBus: { submit: (a) => { submitted.push(a as SubmittedAdvisory) } } })

    hook.run(makeCtx(), guardRejection('write_file'))
    assert.equal(submitted.length, 0, 'first offense: inline tool error is enough')
  })

  it('escalates from the 2nd guard rejection, counting across tools and turns', () => {
    const submitted: SubmittedAdvisory[] = []
    const hook = createPointerRegurgitationHook({ advisoryBus: { submit: (a) => { submitted.push(a as SubmittedAdvisory) } } })

    hook.run(makeCtx(1), guardRejection('write_file'))
    hook.run(makeCtx(3), guardRejection('hash_edit')) // different tool, later turn
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0]!.key, 'pointer-regurgitation')
    assert.equal(submitted[0]!.category, 'discipline')
    assert.ok(submitted[0]!.content.includes('占位符'))
    assert.ok(POINTER_REGURGITATION_ESCALATION_THRESHOLD === 2)

    // Keeps firing on further offenses (the loop is the whole point).
    hook.run(makeCtx(4), guardRejection('edit_file'))
    assert.equal(submitted.length, 2)
    assert.ok(submitted[1]!.content.includes('3 次'))
  })

  it('ignores unrelated tool errors and successful calls', () => {
    const submitted: SubmittedAdvisory[] = []
    const hook = createPointerRegurgitationHook({ advisoryBus: { submit: (a) => { submitted.push(a as SubmittedAdvisory) } } })

    hook.run(makeCtx(), { name: 'write_file', success: false, isError: true, resultContent: 'Error: File not found' })
    hook.run(makeCtx(), { name: 'write_file', success: true, resultContent: 'Wrote 10 lines' })
    hook.run(makeCtx(), { name: 'bash', success: false, isError: true, resultContent: 'exit 1' })
    // Even a marker-containing SUCCESS result must not count (e.g. user file
    // containing the phrase) — only isError results are guard rejections.
    hook.run(makeCtx(), { name: 'read_file', success: true, resultContent: POINTER_GUARD_ERROR_MARKER })
    assert.equal(submitted.length, 0)
  })
})
