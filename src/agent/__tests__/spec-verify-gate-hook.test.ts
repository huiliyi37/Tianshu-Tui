import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSpecVerifyGateHook } from '../hooks/spec-verify-gate-hook.js'
import type { RuntimeHookContext, RuntimeHookSnapshot } from '../runtime-hooks.js'

type SubmittedEntry = { key: string; tier?: string; priority: number; category: string; content: string }

function makeCtx(history: Array<{ tool: string; target: string }>): RuntimeHookContext {
  return {
    snapshot: {
      recentToolHistory: history.map(h => ({ ...h, status: 'success' as const })),
    } as unknown as RuntimeHookSnapshot,
    effects: {} as any,
  }
}

function makeAdvisoryBus(): { bus: { submit: (e: SubmittedEntry) => void }; submitted: SubmittedEntry[] } {
  const submitted: SubmittedEntry[] = []
  return {
    bus: { submit: (e: SubmittedEntry) => { submitted.push(e) } },
    submitted,
  }
}

describe('createSpecVerifyGateHook', () => {
  it('injects constitutional advisory when spec→implement without verification', () => {
    const { bus, submitted } = makeAdvisoryBus()
    const hook = createSpecVerifyGateHook({ advisoryBus: bus })
    const ctx = makeCtx([
      { tool: 'read_file', target: 'docs/handoff-foo.md' },
      { tool: 'read_file', target: 'src/agent/foo.ts' },
      { tool: 'read_file', target: 'src/agent/bar.ts' },
    ])
    hook.run(ctx)
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0]!.key, 'spec-verify-gate')
    assert.equal(submitted[0]!.tier, 'constitutional')
    assert.ok(submitted[0]!.content.includes('docs/handoff-foo.md'))
  })

  it('does NOT inject advisory when run_tests was called', () => {
    const { bus, submitted } = makeAdvisoryBus()
    const hook = createSpecVerifyGateHook({ advisoryBus: bus })
    const ctx = makeCtx([
      { tool: 'read_file', target: 'docs/handoff-foo.md' },
      { tool: 'read_file', target: 'src/agent/foo.ts' },
      { tool: 'run_tests', target: '' },
    ])
    hook.run(ctx)
    assert.equal(submitted.length, 0)
  })

  it('does NOT inject advisory when session JSONL was read', () => {
    const { bus, submitted } = makeAdvisoryBus()
    const hook = createSpecVerifyGateHook({ advisoryBus: bus })
    const ctx = makeCtx([
      { tool: 'read_file', target: 'docs/handoff-foo.md' },
      { tool: 'read_file', target: '.rivet/sessions/abc.jsonl' },
      { tool: 'read_file', target: 'src/agent/foo.ts' },
    ])
    hook.run(ctx)
    assert.equal(submitted.length, 0)
  })

  it('does NOT inject when no spec document in history', () => {
    const { bus, submitted } = makeAdvisoryBus()
    const hook = createSpecVerifyGateHook({ advisoryBus: bus })
    const ctx = makeCtx([
      { tool: 'read_file', target: 'src/agent/foo.ts' },
      { tool: 'read_file', target: 'src/agent/bar.ts' },
    ])
    hook.run(ctx)
    assert.equal(submitted.length, 0)
  })

  it('does NOT inject when history is empty', () => {
    const { bus, submitted } = makeAdvisoryBus()
    const hook = createSpecVerifyGateHook({ advisoryBus: bus })
    const ctx = makeCtx([])
    hook.run(ctx)
    assert.equal(submitted.length, 0)
  })

  it('does NOT inject when spec doc read but no source files followed', () => {
    const { bus, submitted } = makeAdvisoryBus()
    const hook = createSpecVerifyGateHook({ advisoryBus: bus })
    const ctx = makeCtx([
      { tool: 'read_file', target: 'docs/handoff-foo.md' },
      { tool: 'read_file', target: 'README.md' },
    ])
    hook.run(ctx)
    assert.equal(submitted.length, 0)
  })

  it('does NOT inject when spec in docs/design/ subdirectory', () => {
    const { bus, submitted } = makeAdvisoryBus()
    const hook = createSpecVerifyGateHook({ advisoryBus: bus })
    const ctx = makeCtx([
      { tool: 'read_file', target: 'docs/design/handoff-analysis.md' },
      { tool: 'read_file', target: 'src/agent/foo.ts' },
    ])
    hook.run(ctx)
    assert.equal(submitted.length, 0)
  })
})
