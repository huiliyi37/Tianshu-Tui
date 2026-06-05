import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { TODO_TOOL, getTodos, setTodos } from '../todo.js'
import { TodoStore } from '../todo-store.js'

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

  it('warns when a write resets a previously-completed item', async () => {
    setTodos([
      { id: '1', content: 'Ship feature', status: 'completed' },
      { id: '2', content: 'Add tests', status: 'in_progress' },
    ])
    const result = await TODO_TOOL.execute({
      input: { action: 'write', todos: [
        { id: '1', content: 'Ship feature', status: 'pending' },
        { id: '2', content: 'Add tests', status: 'in_progress' },
      ] },
      toolUseId: 't', cwd: '/',
    })
    assert.equal(result.isError ?? false, false)
    assert.ok(result.content.includes('⚠️'), 'should warn on regression')
    assert.ok(result.content.includes('Ship feature'))
    assert.ok(result.content.toLowerCase().includes('do not redo'))
  })
})

describe('TodoStore', () => {
  it('isolates state between stores', () => {
    const store1 = new TodoStore()
    const store2 = new TodoStore()

    store1.write([{ id: '1', content: 'Task A', status: 'pending' }])
    store2.write([{ id: '2', content: 'Task B', status: 'in_progress' }])

    assert.equal(store1.read().length, 1)
    assert.equal(store1.read()[0]!.content, 'Task A')
    assert.equal(store2.read().length, 1)
    assert.equal(store2.read()[0]!.content, 'Task B')
  })

  it('returns empty array for new store', () => {
    const store = new TodoStore()
    assert.deepEqual(store.read(), [])
  })

  it('write replaces entire list', () => {
    const store = new TodoStore()
    store.write([{ id: '1', content: 'Old', status: 'completed' }])
    store.write([{ id: '2', content: 'New', status: 'pending' }])
    assert.equal(store.read().length, 1)
    assert.equal(store.read()[0]!.content, 'New')
  })

  it('detectRegressions flags completed→non-completed and dropped items', () => {
    const store = new TodoStore()
    store.write([
      { id: '1', content: 'Build parser', status: 'completed' },
      { id: '2', content: 'Wire CLI', status: 'completed' },
      { id: '3', content: 'Write docs', status: 'in_progress' },
    ])
    // Model rebuilds from lossy memory: id 1 reset to pending, id 2 dropped.
    const regressions = store.detectRegressions([
      { id: '1', content: 'Build parser', status: 'pending' },
      { id: '3', content: 'Write docs', status: 'in_progress' },
    ])
    assert.equal(regressions.length, 2)
    assert.ok(regressions.some(r => r.includes('Build parser') && r.includes('pending')))
    assert.ok(regressions.some(r => r.includes('Wire CLI') && r.includes('dropped')))
  })

  it('detectRegressions returns empty when completed items stay completed', () => {
    const store = new TodoStore()
    store.write([{ id: '1', content: 'Done thing', status: 'completed' }])
    const regressions = store.detectRegressions([
      { id: '1', content: 'Done thing', status: 'completed' },
      { id: '2', content: 'New thing', status: 'pending' },
    ])
    assert.deepEqual(regressions, [])
  })
})

