import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultToolRegistry } from '../default-registry.js'
import { TodoStore } from '../todo-store.js'
import { defaultStore } from '../todo.js'
import type { Tool, ToolCallParams } from '../types.js'

function extraTool(): Tool {
  return {
    definition: {
      name: 'delegate_task',
      description: 'Delegate a task',
      input_schema: { type: 'object', properties: {} },
    },
    execute: async () => ({ content: 'delegated' }),
    requiresApproval: (_params: ToolCallParams) => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  }
}

describe('createDefaultToolRegistry', () => {
  it('registers the existing core tools', () => {
    const registry = createDefaultToolRegistry()
    const names = registry.getDefinitions().map(t => t.name)

    assert.ok(names.includes('read_file'))
    assert.ok(names.includes('write_file'))
    // plan_submit + plan_close 已合并为单个 'plan' 工具（commit 3a3ab07a）
    assert.ok(names.includes('plan'))
    assert.ok(names.includes('bash'))
    assert.ok(names.includes('edit_file'))
    assert.ok(names.includes('grep'))
    assert.ok(names.includes('glob'))
    assert.ok(names.includes('diff'))
    assert.ok(names.includes('run_tests'))
  })

  it('keeps desktop tools out of the default registry (kernel budget ≤26)', () => {
    const registry = createDefaultToolRegistry()
    const names = registry.getDefinitions().map(t => t.name)
    const desktop = ['export_file', 'open_path', 'create_document', 'create_spreadsheet', 'create_image', 'create_presentation', 'create_pdf']

    for (const name of desktop) {
      assert.equal(names.includes(name), false, `${name} should be gated behind desktopTools`)
    }
    // kernel budget 25→26：为后台任务控制工具 `job` 让出一格（见 kernel-budget.test.ts 说明）。
    assert.ok(registry.getAll().length <= 26, `registry has ${registry.getAll().length} tools (kernel budget: 26)`)
  })

  it('registers desktop tools when desktopTools option is enabled', () => {
    const registry = createDefaultToolRegistry([], { desktopTools: true })
    const names = registry.getDefinitions().map(t => t.name)

    assert.ok(names.includes('export_file'))
    assert.ok(names.includes('open_path'))
    assert.ok(names.includes('create_document'))
    assert.ok(names.includes('create_spreadsheet'))
    assert.ok(names.includes('create_image'))
    assert.ok(names.includes('create_presentation'))
    assert.ok(names.includes('create_pdf'))
  })

  it('keeps delegate_task out of the base worker registry', () => {
    const base = createDefaultToolRegistry()

    assert.equal(base.has('delegate_task'), false)
  })

  it('allows the primary registry to include delegate_task explicitly', () => {
    const primary = createDefaultToolRegistry([extraTool()])

    assert.equal(primary.has('delegate_task'), true)
  })

  it('injects a per-session todo store when todoStore option is set (multi-session isolation)', async () => {
    const s1 = new TodoStore()
    const s2 = new TodoStore()
    const reg1 = createDefaultToolRegistry([], { todoStore: s1 })
    const reg2 = createDefaultToolRegistry([], { todoStore: s2 })

    const todo1 = reg1.getAll().find(t => t.definition.name === 'todo')!
    const todo2 = reg2.getAll().find(t => t.definition.name === 'todo')!

    await todo1.execute({ input: { action: 'write', todos: [{ id: 'a', content: 'session-A task', status: 'pending' }] }, toolUseId: 't1', cwd: '/fake' })
    await todo2.execute({ input: { action: 'write', todos: [{ id: 'b', content: 'session-B task', status: 'pending' }] }, toolUseId: 't2', cwd: '/fake' })

    assert.deepEqual(s1.read().map(t => t.id), ['a'])
    assert.deepEqual(s2.read().map(t => t.id), ['b'])
    // 隔离：互不污染，也不落到全局 defaultStore。
    assert.equal(defaultStore.read().some(t => t.id === 'a' || t.id === 'b'), false)
  })

  it('falls back to the global TODO_TOOL (defaultStore) when no todoStore is injected', async () => {
    defaultStore.write([])
    const reg = createDefaultToolRegistry()
    const todo = reg.getAll().find(t => t.definition.name === 'todo')!
    await todo.execute({ input: { action: 'write', todos: [{ id: 'g', content: 'global', status: 'pending' }] }, toolUseId: 't3', cwd: '/fake' })
    assert.deepEqual(defaultStore.read().map(t => t.id), ['g'])
    defaultStore.write([])
  })

  it('plan tool does not require approval for close action', () => {
    const registry = createDefaultToolRegistry()
    const plan = registry.getAll().find(t => t.definition.name === 'plan')
    assert.ok(plan)
    assert.equal(
      plan!.requiresApproval({ input: { action: 'close', apply: true }, toolUseId: 't1', cwd: '/fake' }),
      false,
    )
  })
})
