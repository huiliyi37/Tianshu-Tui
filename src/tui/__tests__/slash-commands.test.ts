import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveAppPromptInput, handleSlashCommand, type SlashHandlerContext } from '../slash-commands.js'
import type { LogEntry } from '../log-state.js'

function makeCtx(overrides?: Partial<SlashHandlerContext>): SlashHandlerContext {
  return {
    parts: ['/help'],
    agent: {
      getDebugInfo: () => ({
        fingerprint: { systemSha256: 'a'.repeat(64), toolsSha256: 'b'.repeat(64), combinedSha256: 'c'.repeat(64) },
        drift: null,
        systemPromptLength: 10,
        systemPromptPreview: 'system',
        toolCount: 0,
        toolNames: [],
        volatilePayloadReport: {
          totalChars: 50,
          estimatedTokens: 13,
          sections: [{ id: 'environment', chars: 40, estimatedTokens: 10, lines: 1, present: true }],
          wasteCandidates: [],
        },
      }),
      setApprovalMode: () => {},
      addAnchor: () => {},
    } as any,
    session: null as any,
    persist: null as any,
    model: 'test-model',
    maxTokens: 128000,
    availableModels: [],
    onModelSwitch: () => ({ ok: true }),
    allProviders: {},
    currentProvider: 'test',
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
    claimStoreRef: { current: null },
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

  it('resolves /plan into a writing-plans workflow prompt', () => {
    const resolved = resolveAppPromptInput('/plan add workflow aliases', '/cwd')

    assert.ok(resolved.includes('我正在使用 writing-plans 技能创建实现计划。'))
    assert.ok(resolved.includes('Create a comprehensive implementation plan for: add workflow aliases'))
    assert.ok(resolved.includes('Do not write implementation code yet.'))
    assert.ok(resolved.includes('docs/superpowers/plans/'))
    assert.ok(resolved.includes('Forbidden placeholders'))
  })

  it('resolves /write-plan into a writing-plans workflow prompt', () => {
    const resolved = resolveAppPromptInput('/write-plan add Context7 MCP preset', '/cwd')

    assert.ok(resolved.includes('writing-plans'))
    assert.ok(resolved.includes('add Context7 MCP preset'))
    assert.ok(resolved.includes('Execution handoff'))
  })

  it('does not resolve empty /plan before slash handler can show usage', () => {
    assert.equal(resolveAppPromptInput('/plan', '/cwd'), '/plan')
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

  it('/plan without feature shows usage and returns true', () => {
    const entries: string[] = []
    const streaming: boolean[] = []
    const ctx = makeCtx({
      parts: ['/plan'],
      pushStatic: (entry) => entries.push(entry.content),
      setIsStreaming: (v) => streaming.push(v),
    })

    assert.equal(handleSlashCommand(ctx), true)
    assert.ok(entries[0]!.includes('Usage: /plan <feature>'))
    assert.deepEqual(streaming, [false])
  })

  it('/plan with feature falls through to agent prompt resolution', () => {
    const ctx = makeCtx({ parts: ['/plan', 'add', 'workflow', 'aliases'] })
    assert.equal(handleSlashCommand(ctx), false)
  })

  it('/write-plan with feature falls through to agent prompt resolution', () => {
    const ctx = makeCtx({ parts: ['/write-plan', 'add', 'workflow', 'aliases'] })
    assert.equal(handleSlashCommand(ctx), false)
  })

  it('unknown command returns false', () => {
    const ctx = makeCtx({ parts: ['/unknown-cmd'] })
    assert.equal(handleSlashCommand(ctx), false)
  })

  it('/debug context-payload renders volatile payload report', () => {
    const entries: string[] = []
    const ctx = makeCtx({
      parts: ['/debug', 'context-payload'],
      pushStatic: (entry) => entries.push(entry.content),
    })

    assert.equal(handleSlashCommand(ctx), true)
    assert.ok(entries[0]!.includes('Context Payload'))
    assert.ok(entries[0]!.includes('environment'))
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
