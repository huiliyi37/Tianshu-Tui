import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createProbeTrackingHook } from '../probe-tracking-hook.js'
import type { AdvisoryEntry } from '../../advisory-bus.js'
import type { RuntimeHookContext, RuntimeToolEvent } from '../../runtime-hooks.js'

function makeCtx(turn: number): RuntimeHookContext {
  return {
    snapshot: { cwd: '/fake', turn, recentToolHistory: [], sensorium: null },
    effects: {},
  } as unknown as RuntimeHookContext
}

function makeWriteTool(
  name: string,
  filePath: string,
  content: string,
): RuntimeToolEvent {
  if (name === 'write_file') {
    return {
      name, success: true,
      input: { file_path: filePath, content },
    } as unknown as RuntimeToolEvent
  }
  // edit_file / hash_edit use new_string
  return {
    name, success: true,
    input: { file_path: filePath, old_string: 'x', new_string: content },
  } as unknown as RuntimeToolEvent
}

describe('createProbeTrackingHook', () => {
  it('records probes from write_file', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createProbeTrackingHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeWriteTool('write_file', 'src/foo.ts', 'console.log("dbg")\n'))
    const tracker = hook.getProbeTracker()
    assert.equal(tracker.probesByFile.size, 1)
    assert.ok(tracker.probesByFile.has('src/foo.ts'))
    assert.ok(tracker.probesByFile.get('src/foo.ts')!.length >= 1)
  })

  it('records probes from edit_file new_string', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createProbeTrackingHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeWriteTool('edit_file', 'src/bar.ts', 'debugger\n'))
    const tracker = hook.getProbeTracker()
    assert.ok(tracker.probesByFile.has('src/bar.ts'))
  })

  it('records probes from hash_edit new_string', () => {
    const hook = createProbeTrackingHook({
      advisoryBus: { submit: () => {} },
    })
    hook.run(makeCtx(1), makeWriteTool('hash_edit', 'src/baz.ts', 'console.trace(x)\n'))
    assert.ok(hook.getProbeTracker().probesByFile.has('src/baz.ts'))
  })

  it('does not record for read-only tools', () => {
    const hook = createProbeTrackingHook({
      advisoryBus: { submit: () => {} },
    })
    hook.run(makeCtx(1), { name: 'read_file', success: true, input: { file_path: 'src/foo.ts' } } as unknown as RuntimeToolEvent)
    assert.equal(hook.getProbeTracker().probesByFile.size, 0)
  })

  it('does not record for clean code (no probes)', () => {
    const hook = createProbeTrackingHook({
      advisoryBus: { submit: () => {} },
    })
    hook.run(makeCtx(1), makeWriteTool('write_file', 'src/clean.ts', 'const x = 1\n'))
    assert.equal(hook.getProbeTracker().probesByFile.size, 0)
  })

  it('survives across turns (session-scoped)', () => {
    const hook = createProbeTrackingHook({
      advisoryBus: { submit: () => {} },
    })
    hook.run(makeCtx(1), makeWriteTool('write_file', 'src/foo.ts', 'console.log("a")\n'))
    hook.run(makeCtx(5), makeWriteTool('write_file', 'src/bar.ts', 'debugger\n'))
    const tracker = hook.getProbeTracker()
    assert.equal(tracker.probesByFile.size, 2)
    assert.ok(tracker.probesByFile.has('src/foo.ts'))
    assert.ok(tracker.probesByFile.has('src/bar.ts'))
  })

  it('submits advisory on probe detection', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createProbeTrackingHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeWriteTool('write_file', 'src/foo.ts', 'console.log("x")\n'))
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0]!.key, 'probe-tracking')
    assert.equal(submitted[0]!.category, 'discipline')
    assert.match(submitted[0]!.content, /src\/foo\.ts/)
    assert.match(submitted[0]!.content, /探针/)
  })

  it('does not submit advisory for clean code', () => {
    const submitted: AdvisoryEntry[] = []
    const hook = createProbeTrackingHook({
      advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    })
    hook.run(makeCtx(1), makeWriteTool('write_file', 'src/clean.ts', 'const x = 1\n'))
    assert.equal(submitted.length, 0)
  })

  it('avoids exact-duplicate recording', () => {
    const hook = createProbeTrackingHook({
      advisoryBus: { submit: () => {} },
    })
    // Same content written twice (e.g. retry)
    hook.run(makeCtx(1), makeWriteTool('write_file', 'src/foo.ts', 'console.log("x")\n'))
    hook.run(makeCtx(2), makeWriteTool('write_file', 'src/foo.ts', 'console.log("x")\n'))
    const hits = hook.getProbeTracker().probesByFile.get('src/foo.ts')!
    assert.equal(hits.length, 1)
  })

  it('accumulates different probes in same file', () => {
    const hook = createProbeTrackingHook({
      advisoryBus: { submit: () => {} },
    })
    hook.run(makeCtx(1), makeWriteTool('edit_file', 'src/foo.ts', 'console.log("a")\n'))
    hook.run(makeCtx(2), makeWriteTool('edit_file', 'src/foo.ts', 'debugger\n'))
    const hits = hook.getProbeTracker().probesByFile.get('src/foo.ts')!
    assert.equal(hits.length, 2)
  })

  it('resetProbeTracker clears all tracked probes', () => {
    const hook = createProbeTrackingHook({
      advisoryBus: { submit: () => {} },
    })
    hook.run(makeCtx(1), makeWriteTool('write_file', 'src/foo.ts', 'console.log("x")\n'))
    assert.ok(hook.getProbeTracker().probesByFile.size > 0)
    hook.resetProbeTracker()
    assert.equal(hook.getProbeTracker().probesByFile.size, 0)
  })

  it('ignores whitelisted test files', () => {
    const hook = createProbeTrackingHook({
      advisoryBus: { submit: () => {} },
    })
    hook.run(makeCtx(1), makeWriteTool('write_file', 'src/foo.test.ts', 'console.log("ok in test")\n'))
    assert.equal(hook.getProbeTracker().probesByFile.size, 0)
  })
})
