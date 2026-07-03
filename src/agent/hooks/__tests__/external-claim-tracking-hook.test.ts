import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createExternalClaimTrackingHook, extractClaimedPaths } from '../external-claim-tracking-hook.js'
import type { AdvisoryEntry } from '../../advisory-bus.js'
import type { RuntimeHookContext, RuntimeToolEvent } from '../../runtime-hooks.js'

function makeCtx(turn: number, history?: Array<{ tool: string; target?: string }>): RuntimeHookContext {
  return {
    snapshot: {
      cwd: '/fake',
      turn,
      recentToolHistory: history ?? [],
      sensorium: null,
    },
    effects: {},
  } as unknown as RuntimeHookContext
}

function makeDelegateResult(content: string): RuntimeToolEvent {
  return {
    name: 'delegate_task',
    success: true,
    resultContent: content,
  } as unknown as RuntimeToolEvent
}

function makeWriteTool(filePath: string): RuntimeToolEvent {
  return {
    name: 'edit_file',
    success: true,
    input: { file_path: filePath, old_string: 'a', new_string: 'b' },
  } as unknown as RuntimeToolEvent
}

describe('external-claim-tracking-hook', () => {
  describe('extractClaimedPaths', () => {
    it('extracts src/ paths with line numbers', () => {
      const paths = extractClaimedPaths('Found issue in src/agent/foo.ts:123 and src/tools/bar.ts:45')
      assert.ok(paths.includes('src/agent/foo.ts'))
      assert.ok(paths.includes('src/tools/bar.ts'))
      assert.equal(paths.length, 2)
    })

    it('extracts paths with various extensions', () => {
      const paths = extractClaimedPaths('docs/spec.md:10 and config/app.json:5 and tests/x.test.ts:20')
      assert.ok(paths.includes('docs/spec.md'))
      assert.ok(paths.includes('config/app.json'))
      assert.ok(paths.includes('tests/x.test.ts'))
    })

    it('deduplicates same file different lines', () => {
      const paths = extractClaimedPaths('src/a.ts:10 src/a.ts:20 src/a.ts:30')
      assert.equal(paths.length, 1)
    })

    it('does not extract paths without line numbers', () => {
      const paths = extractClaimedPaths('see src/agent/foo.ts for details')
      assert.equal(paths.length, 0)
    })

    it('does not extract bare filenames without directory', () => {
      const paths = extractClaimedPaths('foo.ts:123 bar.js:45')
      assert.equal(paths.length, 0)
    })
  })

  describe('createExternalClaimTrackingHook', () => {
    it('records claimed paths from delegate_task result', () => {
      const hook = createExternalClaimTrackingHook({ advisoryBus: { submit: () => {} } })
      hook.run(makeCtx(1), makeDelegateResult('Issue at src/agent/loop.ts:100'))
      assert.equal(hook.getClaimTracker().claims.length, 1)
      assert.equal(hook.getClaimTracker().claims[0]!.filePath, 'src/agent/loop.ts')
    })

    it('records claimed paths from delegate_batch result', () => {
      const hook = createExternalClaimTrackingHook({ advisoryBus: { submit: () => {} } })
      hook.run(makeCtx(1), {
        name: 'delegate_batch', success: true,
        resultContent: 'src/a.ts:1 src/b.ts:2',
      } as unknown as RuntimeToolEvent)
      assert.equal(hook.getClaimTracker().claims.length, 2)
    })

    it('does not record from failed delegate', () => {
      const hook = createExternalClaimTrackingHook({ advisoryBus: { submit: () => {} } })
      hook.run(makeCtx(1), {
        name: 'delegate_task', success: false,
        resultContent: 'src/a.ts:1',
      } as unknown as RuntimeToolEvent)
      assert.equal(hook.getClaimTracker().claims.length, 0)
    })

    it('does not record from non-delegate tools', () => {
      const hook = createExternalClaimTrackingHook({ advisoryBus: { submit: () => {} } })
      hook.run(makeCtx(1), {
        name: 'read_file', success: true,
        resultContent: 'src/a.ts:1',
      } as unknown as RuntimeToolEvent)
      assert.equal(hook.getClaimTracker().claims.length, 0)
    })

    it('fires advisory when writing to claimed path without verification', () => {
      const submitted: AdvisoryEntry[] = []
      const hook = createExternalClaimTrackingHook({
        advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
      })
      // delegate reports path
      hook.run(makeCtx(1), makeDelegateResult('src/agent/loop.ts:100'))
      // next turn, edit without read/grep in between
      hook.run(makeCtx(2), makeWriteTool('src/agent/loop.ts'))
      assert.equal(submitted.length, 1)
      assert.equal(submitted[0]!.key, 'external-claim-unverified')
      assert.match(submitted[0]!.content, /src\/agent\/loop\.ts/)
    })

    it('does NOT fire when read_file verified the path between delegate and write', () => {
      const submitted: AdvisoryEntry[] = []
      const hook = createExternalClaimTrackingHook({
        advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
      })
      hook.run(makeCtx(1), makeDelegateResult('src/agent/loop.ts:100'))
      // turn 2: edit with history showing read_file happened
      hook.run(
        makeCtx(2, [{ tool: 'read_file', target: 'src/agent/loop.ts' }]),
        makeWriteTool('src/agent/loop.ts'),
      )
      assert.equal(submitted.length, 0)
    })

    it('does NOT fire when grep verified the path between delegate and write', () => {
      const submitted: AdvisoryEntry[] = []
      const hook = createExternalClaimTrackingHook({
        advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
      })
      hook.run(makeCtx(1), makeDelegateResult('src/agent/loop.ts:100'))
      // turn 2: edit with history showing grep happened
      hook.run(
        makeCtx(2, [{ tool: 'grep', target: 'src/agent/loop.ts' }]),
        makeWriteTool('src/agent/loop.ts'),
      )
      assert.equal(submitted.length, 0)
    })

    it('does NOT fire for write to unclaimed path', () => {
      const submitted: AdvisoryEntry[] = []
      const hook = createExternalClaimTrackingHook({
        advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
      })
      hook.run(makeCtx(1), makeDelegateResult('src/agent/loop.ts:100'))
      hook.run(makeCtx(2), makeWriteTool('src/other/file.ts'))
      assert.equal(submitted.length, 0)
    })

    it('claims expire after TTL turns', () => {
      const submitted: AdvisoryEntry[] = []
      const hook = createExternalClaimTrackingHook({
        advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
      })
      hook.run(makeCtx(1), makeDelegateResult('src/agent/loop.ts:100'))
      // turn 7 (1 + 5 TTL = expires at 6, so 7 is expired)
      hook.run(makeCtx(7), makeWriteTool('src/agent/loop.ts'))
      assert.equal(submitted.length, 0)
    })

    it('resetClaimTracker clears all claims', () => {
      const hook = createExternalClaimTrackingHook({ advisoryBus: { submit: () => {} } })
      hook.run(makeCtx(1), makeDelegateResult('src/a.ts:1'))
      assert.ok(hook.getClaimTracker().claims.length > 0)
      hook.resetClaimTracker()
      assert.equal(hook.getClaimTracker().claims.length, 0)
    })

    it('handles hash_edit and write_file write tools', () => {
      const submitted: AdvisoryEntry[] = []
      const hook = createExternalClaimTrackingHook({
        advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
      })
      hook.run(makeCtx(1), makeDelegateResult('src/a.ts:1'))
      hook.run(makeCtx(2), {
        name: 'hash_edit', success: true,
        input: { file_path: 'src/a.ts', anchors: [], new_string: 'x' },
      } as unknown as RuntimeToolEvent)
      assert.equal(submitted.length, 1)
    })

    it('bash grep counts as verification', () => {
      const submitted: AdvisoryEntry[] = []
      const hook = createExternalClaimTrackingHook({
        advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
      })
      hook.run(makeCtx(1), makeDelegateResult('src/a.ts:1'))
      hook.run(
        makeCtx(2, [{ tool: 'bash', target: 'grep -rn foo src/a.ts' }]),
        makeWriteTool('src/a.ts'),
      )
      assert.equal(submitted.length, 0)
    })
  })
})
