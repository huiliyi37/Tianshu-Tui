import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createEditFailureRecoveryHook } from '../edit-failure-recovery-hook.js'
import type { AdvisoryEntry } from '../../advisory-bus.js'
import type { RuntimeHookContext, RuntimeToolEvent } from '../../runtime-hooks.js'

function makeCtx(turn: number): RuntimeHookContext {
  return {
    snapshot: {
      cwd: '/fake',
      turn,
      recentToolHistory: [],
      sensorium: null,
    },
    effects: {},
  } as unknown as RuntimeHookContext
}

function makeTool(name: string, success: boolean, filePath?: string): RuntimeToolEvent {
  return {
    name,
    success,
    isError: !success,
    input: filePath ? { file_path: filePath } : undefined,
  } as unknown as RuntimeToolEvent
}

describe('createEditFailureRecoveryHook', () => {
  it('does not fire on first edit failure', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createEditFailureRecoveryHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeTool('edit_file', false, 'src/foo.ts'))
    assert.equal(submitted.length, 0)
  })

  it('fires on second consecutive failure on same file', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createEditFailureRecoveryHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeTool('edit_file', false, 'src/foo.ts'))
    hook.run(makeCtx(1), makeTool('edit_file', false, 'src/foo.ts'))
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0]!.key, 'edit-failure-recovery:src/foo.ts')
    assert.equal(submitted[0]!.category, 'repair')
    assert.match(submitted[0]!.content, /undo/)
    assert.match(submitted[0]!.content, /read_file/)
    assert.match(submitted[0]!.content, /apply_patch/)
  })

  it('fires for mixed edit tools on the same file', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createEditFailureRecoveryHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeTool('edit_file', false, 'src/foo.ts'))
    hook.run(makeCtx(1), makeTool('hash_edit', false, 'src/foo.ts'))
    assert.equal(submitted.length, 1)
  })

  it('does not fire for failures on different files', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createEditFailureRecoveryHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeTool('edit_file', false, 'src/a.ts'))
    hook.run(makeCtx(1), makeTool('edit_file', false, 'src/b.ts'))
    assert.equal(submitted.length, 0)
  })

  it('resets count on success', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createEditFailureRecoveryHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeTool('edit_file', false, 'src/foo.ts'))
    hook.run(makeCtx(1), makeTool('edit_file', true, 'src/foo.ts'))
    hook.run(makeCtx(1), makeTool('edit_file', false, 'src/foo.ts'))
    assert.equal(submitted.length, 0)
  })

  it('ignores non-edit tools', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createEditFailureRecoveryHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeTool('read_file', false, 'src/foo.ts'))
    hook.run(makeCtx(1), makeTool('read_file', false, 'src/foo.ts'))
    assert.equal(submitted.length, 0)
  })

  it('escalates count and keeps firing on further failures', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createEditFailureRecoveryHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeTool('edit_file', false, 'src/foo.ts'))
    hook.run(makeCtx(1), makeTool('edit_file', false, 'src/foo.ts'))
    hook.run(makeCtx(1), makeTool('edit_file', false, 'src/foo.ts'))
    assert.equal(submitted.length, 2)
    assert.ok(submitted[1]!.content.includes('3'))
  })
})
