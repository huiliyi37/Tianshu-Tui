import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HookRegistry } from '../registry.js'
import type { HookHandler, PreToolUseInput, PostToolUseInput, UserPromptSubmitInput, PreCompactInput } from '../types.js'

// --- Error isolation tests ---

describe('HookRegistry', () => {
  it('registers and fires a PreToolUse hook that can modify input', () => {
    const registry = new HookRegistry()
    const modified: PreToolUseInput[] = []

    const handler: HookHandler<'PreToolUse'> = (input) => {
      modified.push(input)
      return { input: { ...input.input, injected: true } }
    }
    registry.register('PreToolUse', handler)

    const result = registry.firePreToolUse({ toolName: 'bash', input: { command: 'ls' } })
    assert.equal(modified.length, 1)
    assert.equal(modified[0]!.toolName, 'bash')
    assert.deepEqual(result.input, { command: 'ls', injected: true })
  })

  it('supports multiple hooks and chains modified input', () => {
    const registry = new HookRegistry()
    registry.register('PreToolUse', ((input: PreToolUseInput) => ({
      input: { ...input.input, step1: true },
    })) as HookHandler<'PreToolUse'>)
    registry.register('PreToolUse', ((input: PreToolUseInput) => ({
      input: { ...input.input, step2: true },
    })) as HookHandler<'PreToolUse'>)

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
    registry.register('PostToolUse', ((input: PostToolUseInput) => {
      seen.push(input)
      return {}
    }) as HookHandler<'PostToolUse'>)

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

describe('HookRegistry error isolation', () => {
  it('catches handler throw in firePreToolUse and returns safe default', () => {
    const registry = new HookRegistry()
    registry.register('PreToolUse', () => { throw new Error('handler boom') })
    const result = registry.firePreToolUse({ toolName: 'bash', input: { command: 'ls' } })
    assert.equal(result.block, undefined)
    assert.deepEqual(result.input, { command: 'ls' })
  })

  it('catches handler throw in firePostToolUse', () => {
    const registry = new HookRegistry()
    registry.register('PostToolUse', () => { throw new Error('post boom') })
    const result = registry.firePostToolUse({ toolName: 'bash', input: {}, result: 'ok', isError: false })
    assert.equal(result.result, 'ok')
  })

  it('catches handler throw in fireNotification', () => {
    const registry = new HookRegistry()
    registry.register('Notification', () => { throw new Error('notif boom') })
    assert.doesNotThrow(() => registry.fireNotification({ message: 'hi', level: 'info' }))
  })

  it('catches handler throw in fireSubagentStop', () => {
    const registry = new HookRegistry()
    registry.register('SubagentStop', () => { throw new Error('stop boom') })
    assert.doesNotThrow(() => registry.fireSubagentStop({ workOrderId: 'w1', status: 'done' }))
  })

  it('continues to next handler after one throws', () => {
    const registry = new HookRegistry()
    const seen: string[] = []
    registry.register('PreToolUse', () => { throw new Error('fail') })
    registry.register('PreToolUse', ((_: any) => {
      seen.push('second')
      return { input: { command: 'ok' } }
    }) as HookHandler<'PreToolUse'>)
    const result = registry.firePreToolUse({ toolName: 'bash', input: { command: 'ls' } })
    assert.deepEqual(seen, ['second'])
    assert.deepEqual(result.input, { command: 'ok' })
  })
})

describe('UserPromptSubmit hook', () => {
  it('allows hook to modify prompt', () => {
    const registry = new HookRegistry()
    registry.register('UserPromptSubmit', ((input: UserPromptSubmitInput) => ({
      prompt: input.prompt.replace(/badword/gi, '***'),
    })) as any)
    const result = registry.fireUserPromptSubmit({ prompt: 'fix the badword issue' })
    assert.equal(result.prompt, 'fix the *** issue')
  })

  it('allows hook to block prompt', () => {
    const registry = new HookRegistry()
    registry.register('UserPromptSubmit', () => ({
      block: true,
      reason: 'Prompt contains disallowed content',
    }))
    const result = registry.fireUserPromptSubmit({ prompt: 'rm -rf /' })
    assert.equal(result.block, true)
    assert.equal(result.reason, 'Prompt contains disallowed content')
  })

  it('returns empty when no hooks registered', () => {
    const registry = new HookRegistry()
    const result = registry.fireUserPromptSubmit({ prompt: 'hello' })
    assert.equal(result.block, undefined)
    assert.equal(result.prompt, undefined)
  })
})

describe('PreCompact hook', () => {
  it('fires without error', () => {
    const registry = new HookRegistry()
    const seen: PreCompactInput[] = []
    registry.register('PreCompact', ((input: PreCompactInput) => {
      seen.push(input)
    }) as any)
    registry.firePreCompact({ turnCount: 10, messageCount: 25 })
    assert.equal(seen.length, 1)
    assert.equal(seen[0]!.turnCount, 10)
  })
})
