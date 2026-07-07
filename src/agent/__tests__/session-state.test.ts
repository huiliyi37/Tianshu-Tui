import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SessionStateManager } from '../session-state.js'

describe('SessionStateManager', () => {
  it('initializes with empty state', () => {
    const mgr = new SessionStateManager('test-sid')
    const state = mgr.getSnapshot()
    assert.equal(state.sessionId, 'test-sid')
    assert.equal(state.task.status, 'exploring')
    assert.equal(state.knownFacts.length, 0)
    assert.equal(state.decisions.length, 0)
    assert.equal(Object.keys(state.fileIndex).length, 0)
  })

  it('tracks file reads', () => {
    const mgr = new SessionStateManager('test-sid')
    mgr.trackFileRead('/src/app.ts', 'read:tu-1')
    const state = mgr.getSnapshot()
    assert.ok(state.fileIndex['/src/app.ts'])
    assert.equal(state.fileIndex['/src/app.ts']!.artifactId, 'read:tu-1')
    assert.equal(state.fileIndex['/src/app.ts']!.modifiedByMe, false)
  })

  it('tracks file modifications', () => {
    const mgr = new SessionStateManager('test-sid')
    mgr.trackFileModified('/src/app.ts')
    const state = mgr.getSnapshot()
    assert.equal(state.fileIndex['/src/app.ts']!.modifiedByMe, true)
  })

  it('preserves read tracking after modification', () => {
    const mgr = new SessionStateManager('test-sid')
    mgr.trackFileRead('/src/app.ts', 'read:tu-1')
    mgr.trackFileModified('/src/app.ts')
    const state = mgr.getSnapshot()
    assert.equal(state.fileIndex['/src/app.ts']!.artifactId, 'read:tu-1')
    assert.equal(state.fileIndex['/src/app.ts']!.modifiedByMe, true)
  })

  it('records decisions with cap', () => {
    const mgr = new SessionStateManager('test-sid')
    for (let i = 0; i < 25; i++) {
      mgr.recordDecision(`d${i}`, `r${i}`, i)
    }
    const state = mgr.getSnapshot()
    assert.equal(state.decisions.length, 20)
    // Oldest trimmed
    assert.equal(state.decisions[0]!.decision, 'd5')
  })

  it('records verification and updates existing', () => {
    const mgr = new SessionStateManager('test-sid')
    mgr.recordVerification('tests', 'not-run')
    mgr.recordVerification('tests', 'passed')
    const state = mgr.getSnapshot()
    assert.equal(state.verification.length, 1)
    assert.equal(state.verification[0]!.status, 'passed')
  })

  it('renders volatile block under 500 chars', () => {
    const mgr = new SessionStateManager('test-sid')
    mgr.updateTask('implement feature X', 'executing', ['step1', 'step2', 'step3'], 1)
    mgr.trackFileRead('/src/foo.ts', 'read:tu-1')
    mgr.trackFileModified('/src/foo.ts')
    mgr.trackFileModified('/src/bar.ts')
    mgr.recordDecision('use approach A', 'simpler', 3)

    const rendered = mgr.renderForVolatile()
    assert.ok(rendered.startsWith('<session-state>'))
    assert.ok(rendered.endsWith('</session-state>'))
    assert.ok(rendered.length <= 500, `rendered length ${rendered.length} exceeds 500`)
    assert.ok(rendered.includes('implement feature X'))
    assert.ok(rendered.includes('[executing]'))
    assert.ok(rendered.includes('step 2/3'))
  })

  it('truncates volatile block when decisions overflow budget', () => {
    const mgr = new SessionStateManager('test-sid')
    mgr.updateTask('very long task ' + 'x'.repeat(200), 'executing')
    for (let i = 0; i < 10; i++) {
      mgr.recordDecision(`decision ${i} with a long reason`, `reason ${i}`, i)
    }

    const rendered = mgr.renderForVolatile()
    assert.ok(rendered.length <= 500, `rendered length ${rendered.length} exceeds 500`)
    assert.ok(rendered.includes('</session-state>'))
  })

  it('records facts with cap', () => {
    const mgr = new SessionStateManager('test-sid')
    for (let i = 0; i < 20; i++) {
      mgr.recordFact(`fact ${i}`, `evidence ${i}`)
    }
    assert.equal(mgr.getSnapshot().knownFacts.length, 15)
  })

  it('updateTask sets all fields', () => {
    const mgr = new SessionStateManager('test-sid')
    mgr.updateTask('do thing', 'planning', ['a', 'b'], 0)
    const task = mgr.getSnapshot().task
    assert.equal(task.objective, 'do thing')
    assert.equal(task.status, 'planning')
    assert.deepEqual(task.plan, ['a', 'b'])
    assert.equal(task.currentStep, 0)
  })

  it('getSnapshot returns deep copy — mutations to snapshot do not affect state', () => {
    const mgr = new SessionStateManager('test-sid')
    mgr.trackFileRead('/x.ts', 'r:1')
    const snap = mgr.getSnapshot()
    // Mutating the snapshot should NOT affect internal state
    const fileEntry = snap.fileIndex['/x.ts']
    assert.ok(fileEntry)
    fileEntry.modifiedByMe = true
    // Internal state should remain unchanged
    assert.equal(mgr.getSnapshot().fileIndex['/x.ts']?.modifiedByMe, false)
  })

  it('snapshot reflects mutations made after taking a previous snapshot', () => {
    const mgr = new SessionStateManager('test-sid')
    const snap1 = mgr.getSnapshot()
    mgr.trackFileRead('/x.ts', 'r:1')
    // Old snapshot should NOT see the new file (it's a copy, not a live reference)
    assert.equal(snap1.fileIndex['/x.ts'], undefined)
    // New snapshot should see it
    assert.ok(mgr.getSnapshot().fileIndex['/x.ts'])
  })

  describe('task list', () => {
    const PLAN = [
      '我建议按以下顺序：',
      '- P1: 修复 loop.ts 中的内存泄露',
      '- P2: 重写 buildIntentRouterPrompt 单元测试',
    ].join('\n')

    it('extracts task items from an assistant reply', () => {
      const mgr = new SessionStateManager('sid')
      const items = mgr.extractTaskList(PLAN, 1)
      assert.equal(items.length, 2)
      assert.equal(items[0]?.id, 'P1')
      assert.equal(items[0]?.content, '修复 loop.ts 中的内存泄露')
      assert.equal(items[0]?.status, 'pending')
      assert.equal(items[0]?.turnCreated, 1)
    })

    it('MERGES across turns instead of overwriting (fix for wipe bug)', () => {
      const mgr = new SessionStateManager('sid')
      mgr.extractTaskList(PLAN, 1)
      // A later reply mentions a brand-new id S3 — must NOT wipe P1/P2.
      mgr.extractTaskList('- S3: 检查 S3 bucket 配置', 3)
      const list = mgr.getTaskList()
      assert.deepEqual(list.map(t => t.id).sort(), ['P1', 'P2', 'S3'])
    })

    it('preserves a completed status when a later turn re-lists the item without a marker', () => {
      const mgr = new SessionStateManager('sid')
      mgr.extractTaskList(PLAN, 1)
      mgr.updateTaskListItem('P1', 'completed', 2)
      // Re-listing P1 plainly in turn 4 must not downgrade it back to pending.
      mgr.extractTaskList('- P1: 修复 loop.ts 中的内存泄露', 4)
      assert.equal(mgr.getTaskList().find(t => t.id === 'P1')?.status, 'completed')
    })

    it('detects an explicit status marker on the task line', () => {
      const mgr = new SessionStateManager('sid')
      mgr.extractTaskList('- P1: 修复内存泄露 ✓ 已完成', 1)
      assert.equal(mgr.getTaskList().find(t => t.id === 'P1')?.status, 'completed')
    })

    it('does not mutate items in place — getTaskList result is stable across updates', () => {
      const mgr = new SessionStateManager('sid')
      mgr.extractTaskList(PLAN, 1)
      const before = mgr.getTaskList()
      const beforeP1 = before.find(t => t.id === 'P1')
      mgr.updateTaskListItem('P1', 'in_progress', 2)
      // The previously-returned object reference must be untouched (immutability).
      assert.equal(beforeP1?.status, 'pending')
      assert.equal(mgr.getTaskList().find(t => t.id === 'P1')?.status, 'in_progress')
    })

    it('updateTaskListItem returns false for unknown id', () => {
      const mgr = new SessionStateManager('sid')
      assert.equal(mgr.updateTaskListItem('P9', 'completed', 1), false)
    })
  })
})
