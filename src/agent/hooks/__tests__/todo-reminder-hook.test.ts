import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createTodoReminderHook } from '../todo-reminder-hook.js'
import type { AdvisoryEntry } from '../../advisory-bus.js'
import type { RuntimeHookContext } from '../../runtime-hooks.js'
import type { TodoItem } from '../../../tools/todo-store.js'

function makeCtx(turn: number, historyLen = 2): RuntimeHookContext {
  const recentToolHistory = Array.from({ length: historyLen }, (_, i) => ({
    tool: 'read_file',
    status: 'success' as const,
    target: `src/f${i}.ts`,
    argsHash: `h${i}`,
  }))
  return {
    snapshot: { cwd: '/fake', turn, recentToolHistory, sensorium: null },
    effects: {},
  } as unknown as RuntimeHookContext
}

const mk = (id: string, content: string, status: TodoItem['status']): TodoItem => ({ id, content, status })

function setup(todos: () => TodoItem[]) {
  const submitted: AdvisoryEntry[] = []
  const hook = createTodoReminderHook({
    advisoryBus: { submit: (e: AdvisoryEntry) => { submitted.push(e) } },
    getTodos: todos,
  })
  return { hook, submitted }
}

describe('createTodoReminderHook', () => {
  it('does not nudge before the soft threshold even with activity', () => {
    const { hook, submitted } = setup(() => [])
    hook.run(makeCtx(2))
    assert.equal(submitted.length, 0)
  })

  it('does not nudge on chat-only turns (no tool activity)', () => {
    const { hook, submitted } = setup(() => [])
    hook.run(makeCtx(8, 0))
    assert.equal(submitted.length, 0)
  })

  it('soft-nudges a multi-step task that has no todo', () => {
    const { hook, submitted } = setup(() => [])
    hook.run(makeCtx(3))
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0]!.key, 'todo-missing')
    assert.equal(submitted[0]!.category, 'todo')
    assert.equal(submitted[0]!.priority, 0.5)
    assert.deepEqual(submitted[0]!.expect, { kind: 'tool_appears', tools: ['todo'] }, 'adoption predicate attached')
  })

  it('escalates wording/priority when a long task still has no todo', () => {
    const { hook, submitted } = setup(() => [])
    hook.run(makeCtx(6))
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0]!.key, 'todo-missing')
    assert.equal(submitted[0]!.priority, 0.7)
  })

  it('respects cooldown between reminders', () => {
    const { hook, submitted } = setup(() => [])
    hook.run(makeCtx(3))
    hook.run(makeCtx(4))
    assert.equal(submitted.length, 1, 'no second nudge within cooldown')
    hook.run(makeCtx(8))
    assert.equal(submitted.length, 2, 'fires again after cooldown')
  })

  it('does not nudge when a fresh non-empty todo list exists', () => {
    const todos = [mk('1', 'task a', 'in_progress'), mk('2', 'task b', 'pending')]
    const { hook, submitted } = setup(() => todos)
    hook.run(makeCtx(3))
    hook.run(makeCtx(4))
    assert.equal(submitted.length, 0)
  })

  it('nudges with a snapshot when a todo list goes stale', () => {
    const todos = [
      mk('1', 'done thing', 'completed'),
      mk('2', 'current thing', 'in_progress'),
      mk('3', 'later thing', 'pending'),
    ]
    const { hook, submitted } = setup(() => todos)
    hook.run(makeCtx(1)) // baseline: list first seen, lastWrite = turn 1
    hook.run(makeCtx(11)) // 10 turns later, unchanged → stale
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0]!.key, 'todo-stale')
    assert.match(submitted[0]!.content, /current thing/)
    assert.match(submitted[0]!.content, /完成 1\/3/)
    assert.deepEqual(submitted[0]!.expect, { kind: 'tool_appears', tools: ['todo'] }, 'adoption predicate attached')
  })

  it('treats a list change as fresh (resets staleness)', () => {
    let todos = [mk('1', 'a', 'in_progress')]
    const { hook, submitted } = setup(() => todos)
    hook.run(makeCtx(1))
    todos = [mk('1', 'a', 'completed'), mk('2', 'b', 'in_progress')] // changed at turn 9
    hook.run(makeCtx(9))
    hook.run(makeCtx(10)) // only 1 turn since change → not stale
    assert.equal(submitted.length, 0)
  })
})
