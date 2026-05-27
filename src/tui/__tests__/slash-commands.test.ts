import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveAppPromptInput, handleSlashCommand, formatVerificationStatus, type SlashHandlerContext } from '../slash-commands.js'
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
      setPromptMode: () => {},
      getPromptMode: () => 'task',
      getVerificationSummary: () => ({ total: 0, verified: 0, pending: 0, files: [] }),
      getEvidenceState: () => ({ filesRead: new Set(), filesModified: new Set(), verifications: [], deliveryStatus: 'unverified', impactedFiles: new Set(), impactedTests: new Set(), fileVerificationLevels: new Map() }),
      getLatestPheromones: () => [],
      getCognitiveSnapshot: () => undefined,
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

  it('returns null for unrecognized slash commands (safety guard)', () => {
    assert.equal(resolveAppPromptInput('/unknown-cmd', '/cwd'), null)
  })

  it('returns null for /mdel-style typo (prevents LLM misinterpretation)', () => {
    assert.equal(resolveAppPromptInput('/mdel', '/cwd'), null)
  })

  it('resolves /plan into a writing-plans workflow prompt', () => {
    const resolved = resolveAppPromptInput('/plan add workflow aliases', '/cwd')
    assert.ok(resolved !== null)

    assert.ok(resolved.includes('我正在使用 writing-plans 技能创建实现计划。'))
    assert.ok(resolved.includes('Create a comprehensive implementation plan for: add workflow aliases'))
    assert.ok(resolved.includes('Do not write implementation code yet.'))
    assert.ok(resolved.includes('docs/superpowers/plans/'))
    assert.ok(resolved.includes('Forbidden placeholders'))
  })

  it('resolves /write-plan into a writing-plans workflow prompt', () => {
    const resolved = resolveAppPromptInput('/write-plan 你说的很好，把这个内容记录到设计文档。如果行数太长就拆分两个，一个背景说明，一个是设计文档。其次，即便我使用 claude code 也是多个会话来并行执行。', '/cwd')
    assert.ok(resolved !== null)

    assert.ok(resolved.includes('writing-plans'))
    assert.ok(resolved.includes('Create a comprehensive implementation plan for: 你说的很好，把这个内容记录到设计文档。'))
    assert.ok(resolved.includes('docs/superpowers/plans/'))
    assert.ok(resolved.includes('多会话并行开发设计文档.md'))
    assert.ok(!resolved.includes('你说的很好-把这个内容记录到设计文档-如果行数太长'))
    assert.ok(resolved.includes('Execution handoff'))
  })

  it('returns null for empty /plan (handled by handleSlashCommand before resolver)', () => {
    assert.equal(resolveAppPromptInput('/plan', '/cwd'), null)
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

  it('/chat and /task switch prompt mode', () => {
    const modes: string[] = []
    const chatCtx = makeCtx({ parts: ['/chat'], agent: { ...makeCtx().agent, setPromptMode: (m: string) => modes.push(m) } as any })
    const taskCtx = makeCtx({ parts: ['/task'], agent: { ...makeCtx().agent, setPromptMode: (m: string) => modes.push(m) } as any })

    assert.equal(handleSlashCommand(chatCtx), true)
    assert.equal(handleSlashCommand(taskCtx), true)
    assert.deepEqual(modes, ['chat', 'task'])
  })

  it('formats verification status with per-file levels', () => {
    const agent = {
      getVerificationSummary: () => ({
        total: 2,
        verified: 1,
        pending: 1,
        files: [
          { path: 'src/prompt/mode.ts', level: 'tested' },
          { path: 'src/tui/app.tsx', level: 'pending' },
        ],
      }),
      getEvidenceState: () => ({
        verifications: [{ status: 'passed', command: 'npx tsx --test src/prompt/__tests__/mode.test.ts' }],
      }),
    } as any

    const formatted = formatVerificationStatus(agent)
    assert.match(formatted, /src\/prompt\/mode\.ts \(tested\)/)
    assert.match(formatted, /src\/tui\/app\.tsx \(pending\)/)
    assert.match(formatted, /Verification: 1\/2/)
  })

  it('/cockpit opens via SurfaceRouter and records selected panel', () => {
    let selected = ''
    let pushed = ''
    const entries: LogEntry[] = []
    const handled = handleSlashCommand(makeCtx({
      parts: ['/cockpit', 'trace'],
      setCockpitPanel: panel => { selected = String(panel) },
      surfacePush: id => { pushed = id },
      pushStatic: entry => { entries.push(entry) },
    }))
    assert.equal(handled, true)
    assert.equal(selected, 'trace')
    assert.equal(pushed, 'cockpit')
    assert.ok(entries[0]?.content.includes('Trace'))
  })

  it('/cockpit toggles off through SurfaceRouter when cockpit overlay is active', () => {
    let popped = false
    const handled = handleSlashCommand(makeCtx({
      parts: ['/cockpit'],
      activeOverlay: 'cockpit',
      surfacePop: () => { popped = true },
    }))
    assert.equal(handled, true)
    assert.equal(popped, true)
  })

  it('/mission shows the current task contract from the cognitive snapshot', () => {
    const entries: LogEntry[] = []
    const handled = handleSlashCommand(makeCtx({
      parts: ['/mission'],
      agent: {
        ...makeCtx().agent,
        getCognitiveSnapshot: () => ({
          contractStatus: 'executing',
          objective: 'ship glance bar',
          scopeFileCount: 2,
          isActionableTask: true,
          hasVerificationGap: true,
          deliveryStatus: 'unverified',
        }),
      } as any,
      pushStatic: entry => { entries.push(entry) },
    }))
    assert.equal(handled, true)
    assert.ok(entries[0]?.content.includes('天契 行'))
    assert.ok(entries[0]?.content.includes('ship glance bar'))
  })
})
