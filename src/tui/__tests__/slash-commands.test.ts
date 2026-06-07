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
  it('returns non-slash input unchanged', async () => {
    assert.equal(resolveAppPromptInput('hello world', '/cwd'), 'hello world')
  })

  it('returns null for unrecognized slash commands (safety guard)', async () => {
    assert.equal(resolveAppPromptInput('/unknown-cmd', '/cwd'), null)
  })

  it('returns null for /mdel-style typo (prevents LLM misinterpretation)', async () => {
    assert.equal(resolveAppPromptInput('/mdel', '/cwd'), null)
  })

  it('resolves /plan into a writing-plans workflow prompt', async () => {
    const resolved = resolveAppPromptInput('/plan add workflow aliases', '/cwd')
    assert.ok(resolved !== null)

    assert.ok(resolved.includes('我正在使用 writing-plans 技能创建实现计划。'))
    assert.ok(resolved.includes('Create a comprehensive implementation plan for: add workflow aliases'))
    assert.ok(resolved.includes('Do not write implementation code yet.'))
    assert.ok(resolved.includes('docs/superpowers/plans/'))
    assert.ok(resolved.includes('Forbidden placeholders'))
  })

  it('resolves /write-plan into a writing-plans workflow prompt', async () => {
    const resolved = resolveAppPromptInput('/write-plan 你说的很好，把这个内容记录到设计文档。如果行数太长就拆分两个，一个背景说明，一个是设计文档。其次，即便我使用 claude code 也是多个会话来并行执行。', '/cwd')
    assert.ok(resolved !== null)

    assert.ok(resolved.includes('writing-plans'))
    assert.ok(resolved.includes('Create a comprehensive implementation plan for: 你说的很好，把这个内容记录到设计文档。'))
    assert.ok(resolved.includes('docs/superpowers/plans/'))
    assert.ok(resolved.includes('多会话并行开发设计文档.md'))
    assert.ok(!resolved.includes('你说的很好-把这个内容记录到设计文档-如果行数太长'))
    assert.ok(resolved.includes('Execution handoff'))
  })

  it('resolves /plan close into a plan_close workflow prompt', async () => {
    const resolved = resolveAppPromptInput('/plan close docs/superpowers/plans/demo.md --tasks 1-7', '/cwd')
    assert.ok(resolved !== null)

    assert.ok(resolved.includes('Use the plan_close tool'))
    assert.ok(resolved.includes('- file_path: docs/superpowers/plans/demo.md'))
    assert.ok(resolved.includes('- tasks: 1-7'))
    assert.ok(resolved.includes('Preview only; do not write the file.'))
  })

  it('resolves /plan-close into a plan_close workflow prompt', async () => {
    const resolved = resolveAppPromptInput('/plan-close docs/superpowers/plans/demo.md --tasks all --apply', '/cwd')
    assert.ok(resolved !== null)

    assert.ok(resolved.includes('Use the plan_close tool'))
    assert.ok(resolved.includes('- tasks: all'))
    assert.ok(resolved.includes('- apply: true'))
  })

  it('returns null for empty /plan (handled by handleSlashCommand before resolver)', async () => {
    assert.equal(resolveAppPromptInput('/plan', '/cwd'), null)
  })

  it('resolves /team into a team workflow prompt', async () => {
    const resolved = resolveAppPromptInput('/team docs/superpowers/plans/loop-split-v3.md', '/cwd')
    assert.ok(resolved !== null)

    assert.ok(resolved.includes('团队模式核心骨架'))
    assert.ok(resolved.includes('team_orchestrate'))
    assert.ok(resolved.includes('delegate_batch'))
    assert.ok(resolved.includes('patcher workers as 天梁 executors'))
    assert.ok(resolved.includes('deliver_task'))
  })

  it('resolves /team max into a planning-first prompt', async () => {
    const resolved = resolveAppPromptInput('/team max refactor loop pipeline', '/cwd')
    assert.ok(resolved !== null)

    assert.ok(resolved.includes('/team max'))
    assert.ok(resolved.includes('multi-perspective planning'))
    assert.ok(resolved.includes('risk audit'))
  })
})

describe('handleSlashCommand', () => {
  it('/help returns true and shows command list', async () => {
    const entries: string[] = []
    const ctx = makeCtx({
      pushStatic: (entry) => entries.push(entry.content),
    })
    const result = await handleSlashCommand(ctx)
    assert.equal(result, true)
    assert.ok(entries[0]!.includes('/help'))
    assert.ok(entries[0]!.includes('/exit'))
    assert.ok(entries[0]!.includes('/compact'))
    assert.ok(entries[0]!.includes('/plan close'))
    assert.ok(entries[0]!.includes('/team <task|plan>'))
    assert.ok(entries[0]!.includes('/team max <task>'))
  })

  it('/clear returns true', async () => {
    const ctx = makeCtx({ parts: ['/clear'] })
    assert.equal(await handleSlashCommand(ctx), true)
  })

  it('/plan without feature shows usage and returns true', async () => {
    const entries: string[] = []
    const streaming: boolean[] = []
    const ctx = makeCtx({
      parts: ['/plan'],
      pushStatic: (entry) => entries.push(entry.content),
      setIsStreaming: (v) => streaming.push(v),
    })

    assert.equal(await handleSlashCommand(ctx), true)
    assert.ok(entries[0]!.includes('Usage: /plan <feature>'))
    assert.deepEqual(streaming, [false])
  })

  it('/team without objective shows usage and returns true', async () => {
    const entries: string[] = []
    const streaming: boolean[] = []
    const ctx = makeCtx({
      parts: ['/team'],
      pushStatic: (entry) => entries.push(entry.content),
      setIsStreaming: (v) => streaming.push(v),
    })

    assert.equal(await handleSlashCommand(ctx), true)
    assert.ok(entries[0]!.includes('Usage: /team <task|docs/superpowers/plans/file.md>'))
    assert.deepEqual(streaming, [false])
  })

  it('/plan with feature falls through to agent prompt resolution', async () => {
    const ctx = makeCtx({ parts: ['/plan', 'add', 'workflow', 'aliases'] })
    assert.equal(await handleSlashCommand(ctx), false)
  })

  it('/write-plan with feature falls through to agent prompt resolution', async () => {
    const ctx = makeCtx({ parts: ['/write-plan', 'add', 'workflow', 'aliases'] })
    assert.equal(await handleSlashCommand(ctx), false)
  })

  it('/team with objective falls through to agent prompt resolution', async () => {
    const ctx = makeCtx({ parts: ['/team', 'docs/superpowers/plans/demo.md'] })
    assert.equal(await handleSlashCommand(ctx), false)
  })

  it('unknown command returns false', async () => {
    const ctx = makeCtx({ parts: ['/unknown-cmd'] })
    assert.equal(await handleSlashCommand(ctx), false)
  })

  it('/debug context-payload renders volatile payload report', async () => {
    const entries: string[] = []
    const ctx = makeCtx({
      parts: ['/debug', 'context-payload'],
      pushStatic: (entry) => entries.push(entry.content),
    })

    assert.equal(await handleSlashCommand(ctx), true)
    assert.ok(entries[0]!.includes('Context Payload'))
    assert.ok(entries[0]!.includes('environment'))
  })

  it('/verbose toggles and returns true', async () => {
    const values: boolean[] = []
    const ctx = makeCtx({
      parts: ['/verbose'],
      setVerbose: (v: boolean) => values.push(v),
    })
    assert.equal(await handleSlashCommand(ctx), true)
    assert.deepEqual(values, [true])
  })

  it('/chat and /task are deprecated no-ops (mode auto-detected) but still handled', async () => {
    const modes: string[] = []
    const chatCtx = makeCtx({ parts: ['/chat'], agent: { ...makeCtx().agent, setPromptMode: (m: string) => modes.push(m) } as any })
    const taskCtx = makeCtx({ parts: ['/task'], agent: { ...makeCtx().agent, setPromptMode: (m: string) => modes.push(m) } as any })

    assert.equal(await handleSlashCommand(chatCtx), true)
    assert.equal(await handleSlashCommand(taskCtx), true)
    assert.deepEqual(modes, [])  // mode is auto-detected — commands no longer switch
  })

  it('formats verification status with per-file levels', async () => {
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

  it('/cockpit opens via SurfaceRouter and records selected panel', async () => {
    let selected = ''
    let pushed = ''
    const entries: LogEntry[] = []
    const handled = await handleSlashCommand(makeCtx({
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

  it('/cockpit toggles off through SurfaceRouter when cockpit overlay is active', async () => {
    let popped = false
    const handled = await handleSlashCommand(makeCtx({
      parts: ['/cockpit'],
      activeOverlay: 'cockpit',
      surfacePop: () => { popped = true },
    }))
    assert.equal(handled, true)
    assert.equal(popped, true)
  })

  it('/scroll opens the pager overlay through SurfaceRouter', async () => {
    let pushed = ''
    const entries: LogEntry[] = []
    const streaming: boolean[] = []
    const handled = await handleSlashCommand(makeCtx({
      parts: ['/scroll'],
      surfacePush: id => { pushed = id },
      pushStatic: entry => { entries.push(entry) },
      setIsStreaming: value => { streaming.push(value) },
    }))

    assert.equal(handled, true)
    assert.equal(pushed, 'pager')
    assert.deepEqual(streaming, [false])
    assert.ok(entries[0]?.content.includes('Scrollback pager opened'))
  })

  it('/mission shows the current task contract from the cognitive snapshot', async () => {
    const entries: LogEntry[] = []
    const handled = await handleSlashCommand(makeCtx({
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

  describe('/domain', () => {
    it('/domain shows "not yet activated" when undefined', async () => {
      const entries: string[] = []
      const handled = await handleSlashCommand(makeCtx({
        parts: ['/domain'],
        agent: {
          ...makeCtx().agent,
          getSessionDomain: () => undefined,
        } as any,
        pushStatic: (entry) => entries.push(entry.content),
      }))
      assert.equal(handled, true)
      assert.ok(entries[0]!.includes('尚未激活'))
      assert.ok(entries[0]!.includes('自动匹配'))
    })

    it('/domain shows current domain when set', async () => {
      const entries: string[] = []
      const handled = await handleSlashCommand(makeCtx({
        parts: ['/domain'],
        agent: {
          ...makeCtx().agent,
          getSessionDomain: () => ({ id: 'pojun', name: '破军', volatileBlock: '破军之道', motto: '好男儿当负三尺剑立不世之功' }),
        } as any,
        pushStatic: (entry) => entries.push(entry.content),
      }))
      assert.equal(handled, true)
      assert.ok(entries[0]!.includes('破军'))
      assert.ok(entries[0]!.includes('pojun'))
      assert.ok(entries[0]!.includes('好男儿'))
    })

    it('/domain shows "no domain" when null', async () => {
      const entries: string[] = []
      const handled = await handleSlashCommand(makeCtx({
        parts: ['/domain'],
        agent: {
          ...makeCtx().agent,
          getSessionDomain: () => null,
        } as any,
        pushStatic: (entry) => entries.push(entry.content),
      }))
      assert.equal(handled, true)
      assert.ok(entries[0]!.includes('无星域'))
    })

    it('/domain list shows all domains including tianshu', async () => {
      const entries: string[] = []
      const handled = await handleSlashCommand(makeCtx({
        parts: ['/domain', 'list'],
        agent: {
          ...makeCtx().agent,
          getSessionDomain: () => undefined,
        } as any,
        pushStatic: (entry) => entries.push(entry.content),
      }))
      assert.equal(handled, true)
      const content = entries[0]!
      assert.ok(content.includes('破军'))
      assert.ok(content.includes('天府'))
      assert.ok(content.includes('天梁'))
      assert.ok(content.includes('天权'))
      assert.ok(content.includes('天机'))
      assert.ok(content.includes('天璇'))
      assert.ok(content.includes('天枢'))
    })

    it('/domain <id> switches to a domain by English id', async () => {
      const entries: string[] = []
      const setCalls: any[] = []
      const handled = await handleSlashCommand(makeCtx({
        parts: ['/domain', 'tianfu'],
        agent: {
          ...makeCtx().agent,
          getSessionDomain: () => undefined,
          setSessionDomain: (d: any) => setCalls.push(d),
        } as any,
        pushStatic: (entry) => entries.push(entry.content),
      }))
      assert.equal(handled, true)
      assert.equal(setCalls.length, 1)
      assert.equal(setCalls[0]!.id, 'tianfu')
      assert.equal(setCalls[0]!.name, '天府')
      assert.ok(entries[0]!.includes('天府'))
    })

    it('/domain <name> switches by Chinese name', async () => {
      const entries: string[] = []
      const setCalls: any[] = []
      const handled = await handleSlashCommand(makeCtx({
        parts: ['/domain', '破军'],
        agent: {
          ...makeCtx().agent,
          getSessionDomain: () => undefined,
          setSessionDomain: (d: any) => setCalls.push(d),
        } as any,
        pushStatic: (entry) => entries.push(entry.content),
      }))
      assert.equal(handled, true)
      assert.equal(setCalls.length, 1)
      assert.equal(setCalls[0]!.id, 'pojun')
      assert.ok(entries[0]!.includes('破军'))
    })

    it('/domain auto resets to auto-detect', async () => {
      const entries: string[] = []
      let resetCalled = false
      const handled = await handleSlashCommand(makeCtx({
        parts: ['/domain', 'auto'],
        agent: {
          ...makeCtx().agent,
          getSessionDomain: () => ({ id: 'pojun', name: '破军', volatileBlock: 'test', motto: 'test' }),
          resetSessionDomain: () => { resetCalled = true },
        } as any,
        pushStatic: (entry) => entries.push(entry.content),
      }))
      assert.equal(handled, true)
      assert.equal(resetCalled, true)
      assert.ok(entries[0]!.includes('自动检测'))
    })

    it('/domain off disables domain', async () => {
      const entries: string[] = []
      const setCalls: any[] = []
      const handled = await handleSlashCommand(makeCtx({
        parts: ['/domain', 'off'],
        agent: {
          ...makeCtx().agent,
          getSessionDomain: () => ({ id: 'pojun', name: '破军', volatileBlock: 'test', motto: 'test' }),
          setSessionDomain: (d: any) => setCalls.push(d),
        } as any,
        pushStatic: (entry) => entries.push(entry.content),
      }))
      assert.equal(handled, true)
      assert.deepEqual(setCalls, [null])
      assert.ok(entries[0]!.includes('关闭'))
    })

    it('/domain <unknown> shows error with valid names', async () => {
      const entries: string[] = []
      const handled = await handleSlashCommand(makeCtx({
        parts: ['/domain', 'xyz'],
        agent: {
          ...makeCtx().agent,
          getSessionDomain: () => undefined,
        } as any,
        pushStatic: (entry) => entries.push(entry.content),
      }))
      assert.equal(handled, true)
      assert.ok(entries[0]!.includes('未知星域'))
      assert.ok(entries[0]!.includes('pojun'))
    })
  })
})
