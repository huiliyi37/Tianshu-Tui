import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AgentJIT } from '../agent-jit.js'
import type { PlanTemplate } from '../plan-cache.js'

describe('AgentJIT', () => {
  const mockExecute = async (tool: string, args: Record<string, unknown>) => ({
    result: `${tool}:${args.path}`,
    isError: false,
  })

  function makeTemplate(hitCount: number): PlanTemplate {
    return {
      id: 'test-plan',
      keywords: ['add', 'pagination'],
      steps: [
        { tool: 'read_file', target: 'src/api.ts' },
        { tool: 'edit_file', target: 'src/api.ts', args: { content: 'new code' } },
      ],
      createdAt: Date.now(),
      hitCount,
      lastHitAt: Date.now(),
    }
  }

  it('compiles a plan template', () => {
    const jit = new AgentJIT({ executeTool: mockExecute })
    const template = makeTemplate(5)
    const compiled = jit.compile(template)
    assert.ok(compiled.code.includes('read_file'))
    assert.ok(compiled.code.includes('edit_file'))
    assert.equal(jit.size(), 1)
  })

  it('shouldCompile returns false below threshold', () => {
    const jit = new AgentJIT({ executeTool: mockExecute, compileThreshold: 3 })
    assert.equal(jit.shouldCompile(makeTemplate(2)), false)
    assert.equal(jit.shouldCompile(makeTemplate(3)), true)
  })

  it('executes a compiled plan sequentially', async () => {
    const calls: string[] = []
    const jit = new AgentJIT({
      executeTool: async (tool, args) => {
        calls.push(`${tool}:${(args as { path?: string }).path}`)
        return { result: 'ok', isError: false }
      },
    })
    const template = makeTemplate(5)
    jit.compile(template)
    const result = await jit.execute(template.id, template.steps)
    assert.equal(result.success, true)
    assert.equal(calls.length, 2)
    assert.equal(calls[0], 'read_file:src/api.ts')
    assert.equal(calls[1], 'edit_file:src/api.ts')
  })

  it('aborts on error and records failure', async () => {
    let callCount = 0
    const jit = new AgentJIT({
      executeTool: async () => {
        callCount++
        if (callCount === 2) return { result: 'fail', isError: true }
        return { result: 'ok', isError: false }
      },
    })
    const template = makeTemplate(5)
    jit.compile(template)
    const result = await jit.execute(template.id, template.steps)
    assert.equal(result.success, false)
    assert.equal(result.abortedAt, 1)
    assert.equal(jit.getCompiled(template.id)?.lastSuccess, false)
  })

  it('tryJIT returns null below threshold', async () => {
    const jit = new AgentJIT({ executeTool: mockExecute })
    const result = await jit.tryJIT(makeTemplate(1))
    assert.equal(result, null)
  })

  it('tryJIT auto-compiles and executes at threshold', async () => {
    const jit = new AgentJIT({ executeTool: mockExecute })
    const result = await jit.tryJIT(makeTemplate(3))
    assert.ok(result)
    assert.equal(result.success, true)
    assert.equal(jit.size(), 1)
  })

  it('invalidates by file path', () => {
    const jit = new AgentJIT({ executeTool: mockExecute })
    jit.compile(makeTemplate(5))
    assert.equal(jit.size(), 1)
    const removed = jit.invalidateByPath('src/api.ts')
    assert.equal(removed, 1)
    assert.equal(jit.size(), 0)
  })
})
