import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDelegateTaskTool, type DelegateTaskCoordinator } from '../delegate-task.js'
import type { CoordinatorRun, DelegationRequest } from '../../agent/coordinator.js'
import { profileRegistry } from '../../agent/profile-registry.js'
import { starDomainRegistry } from '../../agent/star-domain-registry.js'

function makeRun(): CoordinatorRun {
  return {
    status: 'completed',
    selectedModel: 'deepseek-v4-pro',
    results: [{
      workOrderId: 'wo_1',
      status: 'passed',
      summary: 'Worker found the seam.',
      findings: [],
      artifacts: [],
      changedFiles: [],
      risks: [],
      nextActions: [],
      evidenceStatus: 'verified',
    }],
    packet: '<worker_results>packet</worker_results>',
  }
}

describe('DELEGATE_TASK_TOOL', () => {
  it('validates input and calls the coordinator', async () => {
    const calls: DelegationRequest[] = []
    const coordinator: DelegateTaskCoordinator = {
      delegate: async request => {
        calls.push(request)
        return makeRun()
      },
    }
    const tool = createDelegateTaskTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_delegate',
      cwd: '/repo',
      reviewDepth: 2,
      input: {
        objective: 'Find routing seams across the runtime modules.',
        files: ['src/main.tsx', 'src/agent/loop.ts'],
      },
    })

    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.parentTurnId, 'tu_delegate')
    assert.equal(calls[0]!.kind, 'code_search')
    assert.equal(calls[0]!.profile, 'code_scout')
    assert.deepEqual(calls[0]!.scope.files, ['src/main.tsx', 'src/agent/loop.ts'])
    assert.equal(calls[0]!.reviewDepth, 2)
    assert.equal(result.isError, false)
    assert.ok(result.content.includes('<worker_results>'))
    assert.ok(result.uiContent!.includes('delegate_task completed'))
  })

  it('passes authority through to the coordinator', async () => {
    const calls: DelegationRequest[] = []
    const coordinator: DelegateTaskCoordinator = {
      delegate: async request => {
        calls.push(request)
        return makeRun()
      },
    }
    const tool = createDelegateTaskTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_delegate',
      cwd: '/repo',
      input: {
        objective: 'Review the architecture of the routing layer.',
        authority: 'tianquan',
      },
    })

    assert.equal(result.isError, false)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.authority, 'tianquan')
  })

  it('rejects an unknown authority value', async () => {
    const tool = createDelegateTaskTool({ delegate: async () => makeRun() })
    const result = await tool.execute({
      toolUseId: 'tu_delegate',
      cwd: '/repo',
      input: { objective: 'do a thing', authority: 'not_a_domain' },
    })
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('Invalid delegate_task input'))
  })

  it('accepts authority values from the star-domain registry (schema slimmed to plain string)', () => {
    // P0 schema slimming (commit 2b04fddd) dropped the inline `enum` on authority to
    // save prefix-cache tokens; validation is now a dynamic refine against the
    // star-domain registry (so user-loaded domains are accepted too). Assert the
    // registry exposes the built-in domain ids and the schema stays a bare string.
    const tool = createDelegateTaskTool({ delegate: async () => makeRun() })
    const authoritySchema = tool.definition.input_schema!.properties.authority as { type: string; enum?: string[] }
    assert.equal(authoritySchema.type, 'string')
    assert.equal(authoritySchema.enum, undefined, 'authority schema should be slimmed (no inline enum)')
    const domainIds = starDomainRegistry.getDomainIds()
    assert.ok(domainIds.includes('tianquan'))
    assert.ok(domainIds.includes('tianji'))
  })

  it('exposes profile schema from the profile registry', () => {
    const tool = createDelegateTaskTool({ delegate: async () => makeRun() })
    const profileSchema = tool.definition.input_schema!.properties.profile as { enum: string[] }

    assert.deepEqual(profileSchema.enum, profileRegistry.getProfileNames())
    assert.ok(profileSchema.enum.includes('adversarial_verifier'))
    assert.ok(profileSchema.enum.includes('architect'))
    assert.ok(profileSchema.enum.includes('troubleshooter'))
  })

  it('reports invalid input as a tool error', async () => {
    const coordinator: DelegateTaskCoordinator = {
      delegate: async () => makeRun(),
    }
    const tool = createDelegateTaskTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_delegate',
      cwd: '/repo',
      input: { objective: '' },
    })

    assert.equal(result.isError, true)
    assert.ok(result.content.includes('Invalid delegate_task input'))
  })

  it('does not require approval and is concurrency safe', () => {
    const tool = createDelegateTaskTool({ delegate: async () => makeRun() })

    assert.equal(tool.requiresApproval({ toolUseId: 'x', cwd: '/repo', input: {} }), false)
    assert.equal(tool.isConcurrencySafe(), true)
    assert.equal(tool.isEnabled(), true)
  })

  it('passes resume param through to the coordinator', async () => {
    const calls: DelegationRequest[] = []
    const coordinator: DelegateTaskCoordinator = {
      delegate: async request => {
        calls.push(request)
        return makeRun()
      },
    }
    const tool = createDelegateTaskTool(coordinator)

    await tool.execute({
      toolUseId: 'tu_delegate',
      cwd: '/repo',
      input: {
        objective: 'Continue the previous search with a different angle.',
        resume: 'wo_abc123',
      },
    })

    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.resumeWorkOrderId, 'wo_abc123')
  })

  it('resume is optional — not passing it yields undefined resumeWorkOrderId', async () => {
    const calls: DelegationRequest[] = []
    const coordinator: DelegateTaskCoordinator = {
      delegate: async request => {
        calls.push(request)
        return makeRun()
      },
    }
    const tool = createDelegateTaskTool(coordinator)

    await tool.execute({
      toolUseId: 'tu_delegate',
      cwd: '/repo',
      input: {
        objective: 'Find routing seams across the runtime modules.',
      },
    })

    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.resumeWorkOrderId, undefined)
  })

  describe('progressive timeout', () => {
    const base = { input: {}, toolUseId: 'tu', cwd: '/tmp' }
    // P0: tool-level timeout = ladder/profile budget + 30s exit grace, so the
    // worker's internal budget timer always fires first (preserving partial output).
    const GRACE = 30_000

    it('returns 120s ladder + grace for turn 0-1 (cold open)', () => {
      const tool = createDelegateTaskTool({ delegate: async () => makeRun() })
      assert.equal(tool.timeoutMs?.({ ...base, sessionTurnCount: 0 }), 120_000 + GRACE)
      assert.equal(tool.timeoutMs?.({ ...base, sessionTurnCount: 1 }), 120_000 + GRACE)
    })

    it('returns 240s ladder + grace for turn 2-4 (warming)', () => {
      const tool = createDelegateTaskTool({ delegate: async () => makeRun() })
      assert.equal(tool.timeoutMs?.({ ...base, sessionTurnCount: 2 }), 240_000 + GRACE)
      assert.equal(tool.timeoutMs?.({ ...base, sessionTurnCount: 4 }), 240_000 + GRACE)
    })

    it('returns 480s ladder + grace for turn 5+ (mature)', () => {
      const tool = createDelegateTaskTool({ delegate: async () => makeRun() })
      assert.equal(tool.timeoutMs?.({ ...base, sessionTurnCount: 5 }), 480_000 + GRACE)
      assert.equal(tool.timeoutMs?.({ ...base, sessionTurnCount: 30 }), 480_000 + GRACE)
    })

    it('defaults to mature (480s + grace) when sessionTurnCount is undefined', () => {
      const tool = createDelegateTaskTool({ delegate: async () => makeRun() })
      assert.equal(tool.timeoutMs?.(base), 480_000 + GRACE)
      assert.equal(tool.timeoutMs?.(), 480_000 + GRACE)
    })

    it('profile defaultTimeoutMs dominates the ladder (reviewer = 600s + grace)', () => {
      const tool = createDelegateTaskTool({ delegate: async () => makeRun() })
      assert.equal(
        tool.timeoutMs?.({ ...base, input: { profile: 'reviewer' }, sessionTurnCount: 0 }),
        600_000 + GRACE,
      )
      // Profiles without defaultTimeoutMs keep the ladder
      assert.equal(
        tool.timeoutMs?.({ ...base, input: { profile: 'code_scout' }, sessionTurnCount: 0 }),
        120_000 + GRACE,
      )
    })
  })
})
