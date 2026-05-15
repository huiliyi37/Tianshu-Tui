import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { filterToolRegistry, ToolRegistry } from '../registry.js'
import type { Tool, ToolCallParams } from '../types.js'

function fakeTool(name: string): Tool {
  return {
    definition: {
      name,
      description: `${name} test tool`,
      input_schema: { type: 'object', properties: {} },
    },
    execute: async () => ({ content: `${name} executed` }),
    requiresApproval: (_params: ToolCallParams) => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
}

describe('filterToolRegistry', () => {
  it('copies only explicitly allowed tools into a new registry', () => {
    const source = new ToolRegistry()
    source.register(fakeTool('read_file'))
    source.register(fakeTool('write_file'))
    source.register(fakeTool('grep'))

    const filtered = filterToolRegistry(source, ['read_file', 'grep'])

    assert.equal(filtered.has('read_file'), true)
    assert.equal(filtered.has('grep'), true)
    assert.equal(filtered.has('write_file'), false)
    assert.deepEqual(filtered.getDefinitions().map(t => t.name), ['grep', 'read_file'])
  })

  it('throws when an allowlisted tool is not registered', () => {
    const source = new ToolRegistry()
    source.register(fakeTool('read_file'))

    assert.throws(() => filterToolRegistry(source, ['read_file', 'grep']), /Cannot allowlist unknown tool: grep/)
  })

  it('keeps the filtered registry independent from later source registrations', () => {
    const source = new ToolRegistry()
    source.register(fakeTool('read_file'))

    const filtered = filterToolRegistry(source, ['read_file'])
    source.register(fakeTool('write_file'))

    assert.equal(source.has('write_file'), true)
    assert.equal(filtered.has('write_file'), false)
  })
})
