import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HookRegistry } from '../registry.js'
import type { PreToolUseInput, PostToolUseInput } from '../types.js'

describe('HookRegistry', () => {
  it('registers and fires a PreToolUse hook that can modify input', () => {
    const registry = new HookRegistry()
    const modified: PreToolUseInput[] = []

    registry.register('PreToolUse', (input) => {
      modified.push(input)
      return { input: { ...input.input, injected: true } }
    })

    const result = registry.firePreToolUse({ toolName: 'bash', input: { command: 'ls' } })
    assert.equal(modified.length, 1)
    assert.equal(modified[0]!.toolName, 'bash')
    assert.deepEqual(result.input, { command: 'ls', injected: true })
  })

  it('supports multiple hooks and chains modified input', () => {
    const registry = new HookRegistry()
    registry.register('PreToolUse', (input) => ({
      input: { ...input.input, step1: true },
    }))
    registry.register('PreToolUse', (input) => ({
      input: { ...input.input, step2: true },
    }))

    const result = registry.firePreToolUse({ toolName: 'edit_file', input: { path: 'a.ts' } })
    assert.equal(result.input!.step1, true)
    assert.equal(result.input!.step2, true)
  })

  it('hook returning block stops execution', () => {
    const registry = new HookRegistry()
    registry.register('PreToolUse', () => ({
      block: true,
      reason: 'Blocked by security policy',
    }))

    const result = registry.firePreToolUse({ toolName: 'bash', input: { command: 'rm -rf /' } })
    assert.equal(result.block, true)
    assert.equal(result.reason, 'Blocked by security policy')
  })

  it('fires PostToolUse hooks with result', () => {
    const registry = new HookRegistry()
    const seen: PostToolUseInput[] = []
    registry.register('PostToolUse', (input) => {
      seen.push(input)
      return {}
    })

    registry.firePostToolUse({ toolName: 'edit_file', input: { path: 'a.ts' }, result: 'ok', isError: false })
    assert.equal(seen.length, 1)
    assert.equal(seen[0]!.isError, false)
  })

  it('returns empty result when no hooks registered', () => {
    const registry = new HookRegistry()
    const result = registry.firePreToolUse({ toolName: 'bash', input: {} })
    assert.equal(result.block, undefined)
    assert.deepEqual(result.input, {})
  })

  it('removes hooks by reference', () => {
    const registry = new HookRegistry()
    const handler = () => ({}) as any
    registry.register('PreToolUse', handler)
    registry.unregister('PreToolUse', handler)
    const result = registry.firePreToolUse({ toolName: 'bash', input: {} })
    assert.deepEqual(result.input, {})
  })
})
