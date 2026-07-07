import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createGitClearAfterFailHook } from '../git-clear-after-fail-hook.js'
import type { AdvisoryEntry } from '../../advisory-bus.js'
import type { RuntimeHookContext, RuntimeToolEvent } from '../../runtime-hooks.js'

function makeCtx(turn: number, history?: Array<{ tool: string; target?: string }>): RuntimeHookContext {
  return {
    snapshot: {
      cwd: '/fake', turn,
      recentToolHistory: history ?? [],
      sensorium: null,
    },
    effects: {},
  } as unknown as RuntimeHookContext
}

function makeTestFail(): RuntimeToolEvent {
  return {
    name: 'run_tests', isError: true, success: false,
  } as unknown as RuntimeToolEvent
}

function makeBashFail(cmd: string): RuntimeToolEvent {
  return {
    name: 'bash', isError: true, success: false,
    input: { command: cmd },
    target: cmd,
  } as unknown as RuntimeToolEvent
}

function makeBashOk(cmd: string): RuntimeToolEvent {
  return {
    name: 'bash', success: true,
    input: { command: cmd },
    target: cmd,
  } as unknown as RuntimeToolEvent
}

function collectAdvisories(): { submitted: AdvisoryEntry[]; hook: ReturnType<typeof createGitClearAfterFailHook> } {
  const submitted: AdvisoryEntry[] = []
  const hook = createGitClearAfterFailHook({
    advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
  })
  return { submitted, hook }
}

describe('git-clear-after-fail-hook', () => {
  it('fires constitutional advisory on test fail → git stash without diagnosis', () => {
    const { submitted, hook } = collectAdvisories()
    hook.run(makeCtx(1), makeTestFail())
    hook.run(makeCtx(1), makeBashOk('git stash'))
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0]!.tier, 'constitutional')
    assert.match(submitted[0]!.content, /git.*清场|stash/i)
  })

  it('fires on test fail → git reset --hard', () => {
    const { submitted, hook } = collectAdvisories()
    hook.run(makeCtx(1), makeTestFail())
    hook.run(makeCtx(1), makeBashOk('git reset --hard HEAD~1'))
    assert.equal(submitted.length, 1)
  })

  it('fires on test fail → git checkout --', () => {
    const { submitted, hook } = collectAdvisories()
    hook.run(makeCtx(1), makeTestFail())
    hook.run(makeCtx(1), makeBashOk('git checkout -- src/foo.ts'))
    assert.equal(submitted.length, 1)
  })

  it('fires on test fail → git restore', () => {
    const { submitted, hook } = collectAdvisories()
    hook.run(makeCtx(1), makeTestFail())
    hook.run(makeCtx(1), makeBashOk('git restore .'))
    assert.equal(submitted.length, 1)
  })

  it('fires on test fail → git clean -fd', () => {
    const { submitted, hook } = collectAdvisories()
    hook.run(makeCtx(1), makeTestFail())
    hook.run(makeCtx(1), makeBashOk('git clean -fd'))
    assert.equal(submitted.length, 1)
  })

  it('does NOT fire on bash test fail (npm test) → git stash', () => {
    const { submitted, hook } = collectAdvisories()
    hook.run(makeCtx(1), makeBashFail('npm test'))
    hook.run(makeCtx(1), makeBashOk('git stash'))
    assert.equal(submitted.length, 1)
  })

  it('does NOT fire when git stash pop is used (recovery, not clear)', () => {
    const { submitted, hook } = collectAdvisories()
    hook.run(makeCtx(1), makeTestFail())
    hook.run(makeCtx(1), makeBashOk('git stash pop'))
    assert.equal(submitted.length, 0)
  })

  it('does NOT fire when git stash list is used (read-only)', () => {
    const { submitted, hook } = collectAdvisories()
    hook.run(makeCtx(1), makeTestFail())
    hook.run(makeCtx(1), makeBashOk('git stash list'))
    assert.equal(submitted.length, 0)
  })

  it('does NOT fire when git diff/status is used (read-only)', () => {
    const { submitted, hook } = collectAdvisories()
    hook.run(makeCtx(1), makeTestFail())
    hook.run(makeCtx(1), makeBashOk('git diff'))
    assert.equal(submitted.length, 0)
  })

  it('does NOT fire when diagnosis (grep) happened between fail and git clear', () => {
    const { submitted, hook } = collectAdvisories()
    hook.run(makeCtx(1), makeTestFail())
    hook.run(
      makeCtx(1, [{ tool: 'grep', target: 'src/foo.test.ts' }]),
      makeBashOk('git stash'),
    )
    assert.equal(submitted.length, 0)
  })

  it('does NOT fire when read_file happened between fail and git clear', () => {
    const { submitted, hook } = collectAdvisories()
    hook.run(makeCtx(1), makeTestFail())
    hook.run(
      makeCtx(1, [{ tool: 'read_file', target: 'src/foo.test.ts' }]),
      makeBashOk('git reset --hard'),
    )
    assert.equal(submitted.length, 0)
  })

  it('does NOT fire when no prior test failure', () => {
    const { submitted, hook } = collectAdvisories()
    hook.run(makeCtx(1), makeBashOk('git stash'))
    assert.equal(submitted.length, 0)
  })

  it('does NOT fire when git clear happens outside window (>3 tools after fail)', () => {
    const { submitted, hook } = collectAdvisories()
    hook.run(makeCtx(1), makeTestFail())
    hook.run(makeCtx(1), { name: 'todo', success: true } as unknown as RuntimeToolEvent)
    hook.run(makeCtx(1), { name: 'todo', success: true } as unknown as RuntimeToolEvent)
    hook.run(makeCtx(1), { name: 'todo', success: true } as unknown as RuntimeToolEvent)
    hook.run(makeCtx(1), makeBashOk('git stash')) // 4th tool after fail — window expired
    assert.equal(submitted.length, 0)
  })

  it('does NOT fire on successful tests', () => {
    const { submitted, hook } = collectAdvisories()
    hook.run(makeCtx(1), { name: 'run_tests', success: true } as unknown as RuntimeToolEvent)
    hook.run(makeCtx(1), makeBashOk('git stash'))
    assert.equal(submitted.length, 0)
  })

  it('does NOT fire on non-test bash failures', () => {
    const { submitted, hook } = collectAdvisories()
    hook.run(makeCtx(1), makeBashFail('ls -la'))
    hook.run(makeCtx(1), makeBashOk('git stash'))
    assert.equal(submitted.length, 0)
  })

  it('closes window after firing (no repeat advisory)', () => {
    const { submitted, hook } = collectAdvisories()
    hook.run(makeCtx(1), makeTestFail())
    hook.run(makeCtx(1), makeBashOk('git stash'))
    hook.run(makeCtx(1), makeBashOk('git stash'))
    assert.equal(submitted.length, 1)
  })

  it('resetFailWindow clears state', () => {
    const { submitted, hook } = collectAdvisories()
    hook.run(makeCtx(1), makeTestFail())
    assert.ok(hook.getFailWindow())
    hook.resetFailWindow()
    assert.equal(hook.getFailWindow(), null)
  })

  it('fires on test fail → git restore <file> (single file, not just restore .)', () => {
    const { submitted, hook } = collectAdvisories()
    hook.run(makeCtx(1), makeTestFail())
    hook.run(makeCtx(1), makeBashOk('git restore src/foo.ts'))
    assert.equal(submitted.length, 1)
  })

  it('FIRES when grep between fail and git clear has no file-path target', () => {
    const { submitted, hook } = collectAdvisories()
    hook.run(makeCtx(1), makeTestFail())
    // grep with a bare keyword, no file path → not a real diagnosis
    hook.run(
      makeCtx(1, [{ tool: 'grep', target: 'TODO' }]),
      makeBashOk('git stash'),
    )
    assert.equal(submitted.length, 1)
  })

  it('does NOT fire when grep targets a real file path between fail and git clear', () => {
    const { submitted, hook } = collectAdvisories()
    hook.run(makeCtx(1), makeTestFail())
    hook.run(
      makeCtx(1, [{ tool: 'grep', target: 'src/foo.test.ts' }]),
      makeBashOk('git stash'),
    )
    assert.equal(submitted.length, 0)
  })
})
