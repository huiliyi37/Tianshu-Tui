import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDelegateTaskTool } from '../tools/delegate-task.js'

describe('delegate_task tool', () => {
  it('passes kind and profile from input to coordinator', async () => {
    let captured: { kind?: string; profile?: string } | null = null
    const tool = createDelegateTaskTool({
      delegate: async (req) => {
        captured = req
        return { status: 'completed' as const, results: [], packet: '<worker_results></worker_results>' }
      },
    })

    await tool.execute({
      toolUseId: 'tu-1',
      cwd: '/tmp',
      input: { objective: 'review the auth module for security issues', kind: 'review', profile: 'reviewer' },
    })

    assert.equal(captured!.kind, 'review')
    assert.equal(captured!.profile, 'reviewer')
  })

  it('defaults to code_search/code_scout when kind/profile omitted', async () => {
    let captured: { kind?: string; profile?: string } | null = null
    const tool = createDelegateTaskTool({
      delegate: async (req) => {
        captured = req
        return { status: 'completed' as const, results: [], packet: '<worker_results></worker_results>' }
      },
    })

    await tool.execute({
      toolUseId: 'tu-2',
      cwd: '/tmp',
      input: { objective: 'find all usages of parseCliArgs in the codebase' },
    })

    assert.equal(captured!.kind, 'code_search')
    assert.equal(captured!.profile, 'code_scout')
  })

  it('marks tool as concurrency-safe', () => {
    const tool = createDelegateTaskTool({
      delegate: async () => ({ status: 'completed' as const, results: [], packet: '' }),
    })
    assert.equal(tool.isConcurrencySafe(), true)
  })
})
