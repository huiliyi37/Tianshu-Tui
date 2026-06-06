import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDelegateTaskTool, type DelegateTaskCoordinator } from '../delegate-task.js'
import type { CoordinatorRun, DelegationRequest } from '../../agent/coordinator.js'
import { profileRegistry } from '../../agent/profile-registry.js'

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

  describe('progressive timeout', () => {
    const base = { input: {}, toolUseId: 'tu', cwd: '/tmp' }

    it('returns 30s for turn 0-1 (cold open)', () => {
      const tool = createDelegateTaskTool({ delegate: async () => makeRun() })
      assert.equal(tool.timeoutMs?.({ ...base, sessionTurnCount: 0 }), 30_000)
      assert.equal(tool.timeoutMs?.({ ...base, sessionTurnCount: 1 }), 30_000)
    })

    it('returns 75s for turn 2-4 (warming)', () => {
      const tool = createDelegateTaskTool({ delegate: async () => makeRun() })
      assert.equal(tool.timeoutMs?.({ ...base, sessionTurnCount: 2 }), 75_000)
      assert.equal(tool.timeoutMs?.({ ...base, sessionTurnCount: 4 }), 75_000)
    })

    it('returns 180s for turn 5+ (mature)', () => {
      const tool = createDelegateTaskTool({ delegate: async () => makeRun() })
      assert.equal(tool.timeoutMs?.({ ...base, sessionTurnCount: 5 }), 180_000)
      assert.equal(tool.timeoutMs?.({ ...base, sessionTurnCount: 30 }), 180_000)
    })

    it('defaults to mature (180s) when sessionTurnCount is undefined', () => {
      const tool = createDelegateTaskTool({ delegate: async () => makeRun() })
      assert.equal(tool.timeoutMs?.(base), 180_000)
      assert.equal(tool.timeoutMs?.(), 180_000)
    })
  })
})
