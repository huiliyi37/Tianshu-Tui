import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectDependencies, computeMaxDepth, findExecutable, orderPendingByExecutability, assessScopeRisk, buildScopeNotice } from '../todo-deps.js'
import type { TodoItem } from '../todo-store.js'

const makeTodo = (id: string, content: string, status: TodoItem['status'] = 'pending'): TodoItem => ({
  id, content, status,
})

describe('detectDependencies', () => {
  it('detects explicit id references in content', () => {
    const todos = [
      makeTodo('T1', '解析用户输入'),
      makeTodo('T2', '基于 T1 建立 ScopePartition'),
      makeTodo('T3', '依赖 T2 实现 scope gate'),
    ]
    const deps = detectDependencies(todos)
    assert.deepStrictEqual(deps, [
      { id: 'T1', dependsOn: [] },
      { id: 'T2', dependsOn: ['T1'] },
      { id: 'T3', dependsOn: ['T2'] },
    ])
  })

  it('returns empty dependencies for unrelated todos', () => {
    const todos = [
      makeTodo('T1', '修复 bug'),
      makeTodo('T2', '写测试'),
    ]
    const deps = detectDependencies(todos)
    assert.deepStrictEqual(deps, [
      { id: 'T1', dependsOn: [] },
      { id: 'T2', dependsOn: [] },
    ])
  })

  it('does not match id as substring (T1 should not match T10)', () => {
    const todos = [
      makeTodo('T1', '基础工作'),
      makeTodo('T10', '扩展功能'),
      makeTodo('T2', '基于 T1 实现'),
    ]
    const deps = detectDependencies(todos)
    const t10 = deps.find(d => d.id === 'T10')!
    assert.deepStrictEqual(t10.dependsOn, [])
    const t2 = deps.find(d => d.id === 'T2')!
    assert.deepStrictEqual(t2.dependsOn, ['T1'])
  })

  it('handles multiple dependencies', () => {
    const todos = [
      makeTodo('T1', 'A'),
      makeTodo('T2', 'B'),
      makeTodo('T3', '基于 T1 和 T2'),
    ]
    const deps = detectDependencies(todos)
    const t3 = deps.find(d => d.id === 'T3')!
    // Both T1 and T2 should be detected
    assert.strictEqual(t3.dependsOn.length, 2)
    assert.ok(t3.dependsOn.includes('T1'))
    assert.ok(t3.dependsOn.includes('T2'))
  })

  it('does NOT treat a bare number as a dependency without a cue word', () => {
    // "还剩 1 个测试" is a quantity, not a reference to todo id "1"
    const todos = [
      makeTodo('1', '修复登录 bug'),
      makeTodo('2', '还剩 1 个测试要写'),
    ]
    const deps = detectDependencies(todos)
    const t2 = deps.find(d => d.id === '2')!
    assert.deepStrictEqual(t2.dependsOn, [])
  })

  it('DOES treat a bare number as a dependency when a cue word precedes it', () => {
    const todos = [
      makeTodo('1', '建立解析器'),
      makeTodo('2', '依赖 1 完成后实现 gate'),
    ]
    const deps = detectDependencies(todos)
    const t2 = deps.find(d => d.id === '2')!
    assert.deepStrictEqual(t2.dependsOn, ['1'])
  })
})

describe('computeMaxDepth', () => {
  it('returns 0 for no dependencies', () => {
    const deps = [
      { id: 'T1', dependsOn: [] },
      { id: 'T2', dependsOn: [] },
    ]
    assert.strictEqual(computeMaxDepth(deps), 0)
  })

  it('computes linear chain depth', () => {
    const deps = [
      { id: 'T1', dependsOn: [] },
      { id: 'T2', dependsOn: ['T1'] },
      { id: 'T3', dependsOn: ['T2'] },
    ]
    assert.strictEqual(computeMaxDepth(deps), 2)
  })

  it('computes diamond dependency depth', () => {
    const deps = [
      { id: 'T1', dependsOn: [] },
      { id: 'T2', dependsOn: ['T1'] },
      { id: 'T3', dependsOn: ['T1'] },
      { id: 'T4', dependsOn: ['T2', 'T3'] },
    ]
    assert.strictEqual(computeMaxDepth(deps), 2)
  })

  it('returns Infinity for cycles', () => {
    const deps = [
      { id: 'T1', dependsOn: ['T2'] },
      { id: 'T2', dependsOn: ['T1'] },
    ]
    assert.strictEqual(computeMaxDepth(deps), Infinity)
  })
})

describe('findExecutable', () => {
  it('returns all pending when no dependencies', () => {
    const todos = [
      makeTodo('T1', 'A'),
      makeTodo('T2', 'B'),
    ]
    const deps = detectDependencies(todos)
    const exec = findExecutable(todos, deps)
    assert.strictEqual(exec.length, 2)
  })

  it('excludes blocked items', () => {
    const todos = [
      makeTodo('T1', 'A'),
      makeTodo('T2', '基于 T1', 'pending'),
    ]
    const deps = [
      { id: 'T1', dependsOn: [] },
      { id: 'T2', dependsOn: ['T1'] },
    ]
    const exec = findExecutable(todos, deps)
    assert.strictEqual(exec.length, 1)
    assert.strictEqual(exec[0]!.id, 'T1')
  })

  it('unblocks when dependency is completed', () => {
    const todos = [
      makeTodo('T1', 'A', 'completed'),
      makeTodo('T2', '基于 T1', 'pending'),
    ]
    const deps = [
      { id: 'T1', dependsOn: [] },
      { id: 'T2', dependsOn: ['T1'] },
    ]
    const exec = findExecutable(todos, deps)
    assert.strictEqual(exec.length, 1)
    assert.strictEqual(exec[0]!.id, 'T2')
  })

  it('skips non-pending items', () => {
    const todos = [
      makeTodo('T1', 'A', 'completed'),
      makeTodo('T2', 'B', 'in_progress'),
      makeTodo('T3', 'C', 'pending'),
    ]
    const deps = detectDependencies(todos)
    const exec = findExecutable(todos, deps)
    assert.strictEqual(exec.length, 1)
    assert.strictEqual(exec[0]!.id, 'T3')
  })
})

describe('orderPendingByExecutability', () => {
  it('never drops a pending item — only reorders', () => {
    const todos = [
      makeTodo('T1', '基础模块'),
      makeTodo('T2', '基于 T1 的扩展'), // blocked by pending T1
      makeTodo('T3', '独立任务'),
    ]
    const deps = detectDependencies(todos)
    const ordered = orderPendingByExecutability(todos, deps)
    // all 3 pending survive
    assert.strictEqual(ordered.length, 3)
    const ids = ordered.map(t => t.id)
    assert.ok(ids.includes('T1') && ids.includes('T2') && ids.includes('T3'))
  })

  it('puts executable items before blocked items', () => {
    const todos = [
      makeTodo('T2', '基于 T1 的扩展'), // blocked
      makeTodo('T1', '基础模块'),       // executable
    ]
    const deps = detectDependencies(todos)
    const ordered = orderPendingByExecutability(todos, deps)
    assert.strictEqual(ordered[0]!.id, 'T1', 'executable first')
    assert.strictEqual(ordered[1]!.id, 'T2', 'blocked after')
  })

  it('keeps all pending even when everything is blocked (cycle)', () => {
    const todos = [
      makeTodo('T1', '基于 T2'),
      makeTodo('T2', '基于 T1'),
    ]
    const deps = detectDependencies(todos)
    const ordered = orderPendingByExecutability(todos, deps)
    assert.strictEqual(ordered.length, 2, 'no work vanishes on a cycle')
  })
})

describe('assessScopeRisk', () => {
  it('returns none for a small flat list', () => {
    const todos = [makeTodo('T1', 'A'), makeTodo('T2', 'B')]
    const risk = assessScopeRisk(todos, detectDependencies(todos))
    assert.strictEqual(risk.level, 'none')
  })

  it('flags elevated when pending exceeds threshold', () => {
    const todos = Array.from({ length: 6 }, (_, i) => makeTodo(`T${i + 1}`, `task ${i + 1}`))
    const risk = assessScopeRisk(todos, detectDependencies(todos))
    assert.strictEqual(risk.level, 'elevated')
    assert.strictEqual(risk.pendingCount, 6)
  })

  it('flags high on a deep dependency chain', () => {
    const todos = [
      makeTodo('T1', 'A'),
      makeTodo('T2', '基于 T1'),
      makeTodo('T3', '基于 T2'),
      makeTodo('T4', '基于 T3'),
      makeTodo('T5', '基于 T4'),
    ]
    const risk = assessScopeRisk(todos, detectDependencies(todos))
    assert.strictEqual(risk.level, 'high')
    assert.strictEqual(risk.maxDepth, 4)
  })

  it('flags high and reports a cycle', () => {
    const todos = [makeTodo('T1', '基于 T2'), makeTodo('T2', '基于 T1')]
    const risk = assessScopeRisk(todos, detectDependencies(todos))
    assert.strictEqual(risk.level, 'high')
    assert.strictEqual(risk.hasCycle, true)
  })
})

describe('buildScopeNotice', () => {
  it('returns null for low-risk flat list', () => {
    const todos = [makeTodo('T1', 'A')]
    const deps = detectDependencies(todos)
    const risk = assessScopeRisk(todos, deps)
    assert.strictEqual(buildScopeNotice(todos, deps, risk), null)
  })

  it('nudges to pause and confirm scope when risk is high', () => {
    const todos = Array.from({ length: 11 }, (_, i) => makeTodo(`T${i + 1}`, `task ${i + 1}`))
    const deps = detectDependencies(todos)
    const risk = assessScopeRisk(todos, deps)
    const notice = buildScopeNotice(todos, deps, risk)
    assert.ok(notice)
    assert.ok(notice!.includes('⚠️'))
    assert.ok(notice!.includes('确认范围'))
  })

  it('lists blocked items as still-retained, never hidden', () => {
    const todos = [
      makeTodo('T1', '基础模块'),
      makeTodo('T2', '基于 T1 的扩展'),
    ]
    const deps = detectDependencies(todos)
    const risk = assessScopeRisk(todos, deps)
    const notice = buildScopeNotice(todos, deps, risk)
    assert.ok(notice)
    assert.ok(notice!.includes('⛔'))
    assert.ok(notice!.includes('blocked by T1'))
    assert.ok(notice!.includes('仍保留在列表中'))
  })
})
