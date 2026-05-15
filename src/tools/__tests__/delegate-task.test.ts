import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDelegateTaskTool, type DelegateTaskCoordinator } from '../delegate-task.js'
import type { CoordinatorRun, DelegationRequest } from '../../agent/coordinator.js'

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
    assert.equal(result.isError, false)
    assert.ok(result.content.includes('<worker_results>'))
    assert.ok(result.uiContent!.includes('delegate_task completed'))
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

  it('does not require approval and is not concurrency safe', () => {
    const tool = createDelegateTaskTool({ delegate: async () => makeRun() })

    assert.equal(tool.requiresApproval({ toolUseId: 'x', cwd: '/repo', input: {} }), false)
    assert.equal(tool.isConcurrencySafe(), false)
    assert.equal(tool.isEnabled(), true)
  })
})
