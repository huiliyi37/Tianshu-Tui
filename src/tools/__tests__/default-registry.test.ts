import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultToolRegistry } from '../default-registry.js'
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
    assert.ok(names.includes('plan_close'))
    assert.ok(names.includes('bash'))
    assert.ok(names.includes('edit_file'))
    assert.ok(names.includes('grep'))
    assert.ok(names.includes('glob'))
    assert.ok(names.includes('diff'))
    assert.ok(names.includes('run_tests'))
  })

  it('keeps desktop tools out of the default registry (kernel budget ≤25)', () => {
    const registry = createDefaultToolRegistry()
    const names = registry.getDefinitions().map(t => t.name)
    const desktop = ['export_file', 'open_path', 'create_document', 'create_spreadsheet', 'create_image', 'create_presentation', 'create_pdf']

    for (const name of desktop) {
      assert.equal(names.includes(name), false, `${name} should be gated behind desktopTools`)
    }
    assert.ok(registry.getAll().length <= 25, `registry has ${registry.getAll().length} tools (kernel budget: 25)`)
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
})
