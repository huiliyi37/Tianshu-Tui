import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ToolRegistry } from '../registry.js'
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

describe('ToolRegistry.execute', () => {
  it('runs a registered tool and returns its result', async () => {
    const registry = new ToolRegistry()
    registry.register(fakeTool('read_file'))

    const result = await registry.execute('read_file', {
      input: {},
      toolUseId: 'tu-1',
      cwd: process.cwd(),
    })
    assert.equal(result.content, 'read_file executed')
  })

  it('throws "Tool disabled" when a registered tool is disabled', async () => {
    const registry = new ToolRegistry()
    const disabled: Tool = { ...fakeTool('read_file'), isEnabled: () => false }
    registry.register(disabled)

    await assert.rejects(
      () => registry.execute('read_file', { input: {}, toolUseId: 'tu-1', cwd: process.cwd() }),
      /Tool read_file is disabled/,
    )
  })
})

describe('ToolRegistry.execute: unknown tool surfaces did-you-mean hint', () => {
  // Session 6176a17f reproduction: model called `task` (Cursor/Claude Code
  // convention) instead of `delegate_task`. The fix is to surface actionable
  // feedback in the error message so the next model turn can self-correct.

  function makeRegistry(): ToolRegistry {
    const registry = new ToolRegistry()
    registry.register(fakeTool('read_file'))
    registry.register(fakeTool('write_file'))
    registry.register(fakeTool('edit_file'))
    registry.register(fakeTool('grep'))
    registry.register(fakeTool('delegate_task'))
    registry.register(fakeTool('delegate_batch'))
    return registry
  }

  it('surfaces "Did you mean: delegate_task" for `task` (substring fallback)', async () => {
    const registry = makeRegistry()

    await assert.rejects(
      () => registry.execute('task', { input: {}, toolUseId: 'tu-1', cwd: process.cwd() }),
      (err: Error) => {
        assert.match(err.message, /Unknown tool: task/)
        assert.match(err.message, /Did you mean: delegate_task/)
        return true
      },
    )
  })

  it('surfaces the typo "delegte_task" → delegate_task (Levenshtein)', async () => {
    const registry = makeRegistry()

    await assert.rejects(
      () => registry.execute('delegte_task', { input: {}, toolUseId: 'tu-1', cwd: process.cwd() }),
      (err: Error) => {
        assert.match(err.message, /Unknown tool: delegte_task/)
        assert.match(err.message, /Did you mean: delegate_task/)
        return true
      },
    )
  })

  it('surfaces sibling-tool typo "reed_file" → read_file', async () => {
    const registry = makeRegistry()

    await assert.rejects(
      () => registry.execute('reed_file', { input: {}, toolUseId: 'tu-1', cwd: process.cwd() }),
      (err: Error) => {
        assert.match(err.message, /Did you mean: read_file/)
        return true
      },
    )
  })

  it('still includes "Available tools" when no near-match exists', async () => {
    const registry = makeRegistry()

    await assert.rejects(
      () => registry.execute('xyzpdq', { input: {}, toolUseId: 'tu-1', cwd: process.cwd() }),
      (err: Error) => {
        assert.match(err.message, /Unknown tool: xyzpdq/)
        assert.match(err.message, /Available tools:/)
        assert.match(err.message, /delegate_task/)
        assert.match(err.message, /read_file/)
        return true
      },
    )
  })

  it('omits "Did you mean" when no near-match exists', async () => {
    const registry = makeRegistry()

    await assert.rejects(
      () => registry.execute('xyzpdq', { input: {}, toolUseId: 'tu-1', cwd: process.cwd() }),
      (err: Error) => {
        assert.doesNotMatch(err.message, /Did you mean/)
        return true
      },
    )
  })

  it('catalog is sorted for stable prefix-cache behavior', async () => {
    // Tools listed in `Available tools:` should be sorted alphabetically so
    // the same unknown name across sessions produces the same error message
    // (DeepSeek exact-prefix cache stability).
    const registry = makeRegistry()

    await assert.rejects(
      () => registry.execute('xyzpdq', { input: {}, toolUseId: 'tu-1', cwd: process.cwd() }),
      (err: Error) => {
        const toolsSection = err.message.split('Available tools: ')[1] ?? ''
        const names = toolsSection.split(', ')
        const sorted = names.slice().sort()
        assert.deepEqual(names, sorted, 'Available tools must be alphabetically sorted')
        return true
      },
    )
  })

  it('error name remains "Error" (catch handlers downstream key on this)', async () => {
    // tool-pipeline.ts:1027 reads err.message — but downstream logging or
    // metrics may also key on err.name. Keep the class default so existing
    // catch sites that do `err instanceof Error` continue to work.
    const registry = new ToolRegistry()

    let caught: unknown
    try {
      await registry.execute('absent', { input: {}, toolUseId: 'tu-1', cwd: process.cwd() })
    } catch (e) {
      caught = e
    }
    assert.ok(caught instanceof Error)
    assert.equal((caught as Error).name, 'Error')
  })
})

describe('ToolRegistry.getAllNames', () => {
  it('returns sorted names for deterministic did-you-mean hints', () => {
    const registry = new ToolRegistry()
    registry.register(fakeTool('write_file'))
    registry.register(fakeTool('read_file'))
    registry.register(fakeTool('grep'))

    assert.deepEqual(registry.getAllNames(), ['grep', 'read_file', 'write_file'])
  })
})