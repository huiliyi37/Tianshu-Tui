import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectDependencies, computeMaxDepth, findExecutable, buildDepAnnotation } from '../todo-deps.js'
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

describe('buildDepAnnotation', () => {
  it('returns null when no dependencies and no focus', () => {
    const todos = [makeTodo('T1', 'A')]
    const deps = detectDependencies(todos)
    assert.strictEqual(buildDepAnnotation(todos, deps, null), null)
  })

  it('shows blocked items', () => {
    const todos = [
      makeTodo('T1', '基础模块'),
      makeTodo('T2', '基于 T1 的扩展'),
    ]
    const deps = [
      { id: 'T1', dependsOn: [] },
      { id: 'T2', dependsOn: ['T1'] },
    ]
    const annotation = buildDepAnnotation(todos, deps, null)
    assert.ok(annotation)
    assert.ok(annotation!.includes('⛔'))
    assert.ok(annotation!.includes('T2'))
    assert.ok(annotation!.includes('blocked by T1'))
  })

  it('shows focus when provided', () => {
    const todos = [
      makeTodo('T1', '基础模块'),
      makeTodo('T2', '扩展功能'),
    ]
    const deps = detectDependencies(todos)
    const annotation = buildDepAnnotation(todos, deps, 'T1')
    assert.ok(annotation)
    assert.ok(annotation!.includes('📌'))
    assert.ok(annotation!.includes('当前焦点'))
    assert.ok(annotation!.includes('T1'))
  })
})
