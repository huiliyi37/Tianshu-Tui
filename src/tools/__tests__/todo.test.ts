import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { TODO_TOOL, getTodos, setTodos } from '../todo.js'

describe('TODO_TOOL', () => {
  beforeEach(() => {
    setTodos([])
  })

  it('has correct definition name', () => {
    assert.equal(TODO_TOOL.definition.name, 'todo')
  })

  it('writes todos and returns formatted output', async () => {
    const result = await TODO_TOOL.execute({
      input: {
        action: 'write',
        todos: [
          { id: '1', content: 'Read main.tsx', status: 'completed' },
          { id: '2', content: 'Fix bug in loop', status: 'in_progress' },
          { id: '3', content: 'Add tests', status: 'pending' },
        ],
      },
      toolUseId: 'tu_1',
      cwd: '/repo',
    })
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('Read main.tsx'))
    assert.ok(result.content.includes('Fix bug in loop'))
  })

  it('reads current todos', async () => {
    await TODO_TOOL.execute({
      input: {
        action: 'write',
        todos: [{ id: '1', content: 'Task A', status: 'pending' }],
      },
      toolUseId: 'tu_1',
      cwd: '/repo',
    })

    const result = await TODO_TOOL.execute({
      input: { action: 'read' },
      toolUseId: 'tu_2',
      cwd: '/repo',
    })
    assert.ok(result.content.includes('Task A'))
  })

  it('returns message when no todos', async () => {
    const result = await TODO_TOOL.execute({
      input: { action: 'read' },
      toolUseId: 'tu_1',
      cwd: '/repo',
    })
    assert.ok(result.content.includes('No todos'))
  })

  it('rejects unknown action', async () => {
    const result = await TODO_TOOL.execute({
      input: { action: 'delete' },
      toolUseId: 'tu_4',
      cwd: '/repo',
    })
    assert.equal(result.isError, true)
  })

  it('does not require approval', () => {
    assert.equal(TODO_TOOL.requiresApproval({ input: { action: 'write' }, toolUseId: 't', cwd: '/' }), false)
  })

  it('is concurrency safe', () => {
    assert.equal(TODO_TOOL.isConcurrencySafe(), true)
  })
})
