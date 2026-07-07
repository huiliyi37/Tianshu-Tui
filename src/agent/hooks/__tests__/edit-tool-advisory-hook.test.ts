import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createEditToolAdvisoryHook } from '../edit-tool-advisory-hook.js'
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

function makeTool(name: string, filePath?: string): RuntimeToolEvent {
  return {
    name,
    success: true,
    input: filePath ? { file_path: filePath } : undefined,
  } as unknown as RuntimeToolEvent
}

describe('createEditToolAdvisoryHook', () => {
  it('does not fire on first hash_edit', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createEditToolAdvisoryHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeTool('hash_edit', 'src/foo.ts'))
    assert.equal(submitted.length, 0)
  })

  it('fires on second hash_edit to same file in same turn', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createEditToolAdvisoryHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeTool('hash_edit', 'src/foo.ts'))
    hook.run(makeCtx(1), makeTool('hash_edit', 'src/foo.ts'))
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0]!.key, 'edit-tool-advisory')
    assert.equal(submitted[0]!.category, 'discipline')
    assert.match(submitted[0]!.content, /hash_edit.*2.*次/)
  })

  it('does not fire for different files in same turn', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createEditToolAdvisoryHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeTool('hash_edit', 'src/a.ts'))
    hook.run(makeCtx(1), makeTool('hash_edit', 'src/b.ts'))
    assert.equal(submitted.length, 0)
  })

  it('resets count on new turn', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createEditToolAdvisoryHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeTool('hash_edit', 'src/foo.ts'))
    hook.run(makeCtx(2), makeTool('hash_edit', 'src/foo.ts'))
    assert.equal(submitted.length, 0)
  })

  it('ignores non-hash_edit tools', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createEditToolAdvisoryHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeTool('edit_file', 'src/foo.ts'))
    hook.run(makeCtx(1), makeTool('edit_file', 'src/foo.ts'))
    assert.equal(submitted.length, 0)
  })

  it('counts across intervening non-hash_edit tools', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createEditToolAdvisoryHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeTool('hash_edit', 'src/foo.ts'))
    hook.run(makeCtx(1), makeTool('read_file', 'src/bar.ts'))
    hook.run(makeCtx(1), makeTool('grep', 'src/'))
    hook.run(makeCtx(1), makeTool('hash_edit', 'src/foo.ts'))
    assert.equal(submitted.length, 1)
  })
})
