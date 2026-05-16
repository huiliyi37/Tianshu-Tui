import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveAppPromptInput, handleSlashCommand, type SlashHandlerContext } from '../slash-commands.js'
import type { LogEntry } from '../log-state.js'

function makeCtx(overrides?: Partial<SlashHandlerContext>): SlashHandlerContext {
  return {
    parts: ['/help'],
    agent: null as any,
    session: null as any,
    persist: null as any,
    model: 'test-model',
    maxTokens: 128000,
    availableModels: [],
    onModelSwitch: () => {},
    currentSessionId: 'test',
    cost: 0,
    cacheHitRate: 0,
    autoSafeRef: { current: false },
    verboseRef: { current: false },
    setVerbose: () => {},
    setAutoSafe: () => {},
    rollbackTokenRef: { current: null },
    cockpitPanelRef: { current: null },
    setCockpitPanel: () => {},
    pushStatic: () => {},
    setIsStreaming: () => {},
    setCacheHitRate: () => {},
    setSummaryState: () => {},
    mcpManagerRef: { current: null },
    ...overrides,
  }
}

describe('resolveAppPromptInput', () => {
  it('returns non-slash input unchanged', () => {
    assert.equal(resolveAppPromptInput('hello world', '/cwd'), 'hello world')
  })

  it('passes unknown slash commands through', () => {
    assert.equal(resolveAppPromptInput('/unknown-cmd', '/cwd'), '/unknown-cmd')
  })
})

describe('handleSlashCommand', () => {
  it('/help returns true and shows command list', () => {
    const entries: string[] = []
    const ctx = makeCtx({
      pushStatic: (entry) => entries.push(entry.content),
    })
    const result = handleSlashCommand(ctx)
    assert.equal(result, true)
    assert.ok(entries[0]!.includes('/help'))
    assert.ok(entries[0]!.includes('/exit'))
    assert.ok(entries[0]!.includes('/compact'))
  })

  it('/clear returns true', () => {
    const ctx = makeCtx({ parts: ['/clear'] })
    assert.equal(handleSlashCommand(ctx), true)
  })

  it('unknown command returns false', () => {
    const ctx = makeCtx({ parts: ['/unknown-cmd'] })
    assert.equal(handleSlashCommand(ctx), false)
  })

  it('/verbose toggles and returns true', () => {
    const values: boolean[] = []
    const ctx = makeCtx({
      parts: ['/verbose'],
      setVerbose: (v: boolean) => values.push(v),
    })
    assert.equal(handleSlashCommand(ctx), true)
    assert.deepEqual(values, [true])
  })
})
