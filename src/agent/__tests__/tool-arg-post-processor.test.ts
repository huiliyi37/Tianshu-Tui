import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ToolArgPostProcessorRegistry, type ToolArgProcessor } from '../tool-arg-post-processor.js'
import { planSubmitArgProcessor } from '../../tools/plan-submit-arg-processor.js'
import type { OaiToolCall } from '../../api/oai-types.js'

describe('ToolArgPostProcessorRegistry', () => {
  it('passes through calls with no registered processor', () => {
    const reg = new ToolArgPostProcessorRegistry()
    const calls: OaiToolCall[] = [
      { id: 'tc1', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"/foo.ts"}' } },
    ]
    const result = reg.processToolCalls(calls)
    assert.strictEqual(result, calls, 'should return same array reference')
  })

  it('passes through empty calls array', () => {
    const reg = new ToolArgPostProcessorRegistry()
    const calls: OaiToolCall[] = []
    assert.strictEqual(reg.processToolCalls(calls), calls)
  })

  it('replaces arguments when processor returns non-null', () => {
    const reg = new ToolArgPostProcessorRegistry()
    reg.register({
      toolName: 'test_tool',
      process: () => '{"replaced":true}',
    })
    const calls: OaiToolCall[] = [
      { id: 'tc1', type: 'function', function: { name: 'test_tool', arguments: '{"original":true}' } },
    ]
    const result = reg.processToolCalls(calls)
    assert.notStrictEqual(result, calls, 'should return new array')
    assert.equal(result[0]!.function.arguments, '{"replaced":true}')
    // id and name unchanged
    assert.equal(result[0]!.id, 'tc1')
    assert.equal(result[0]!.function.name, 'test_tool')
    // original not mutated
    assert.equal(calls[0]!.function.arguments, '{"original":true}')
  })

  it('keeps original when processor returns null', () => {
    const reg = new ToolArgPostProcessorRegistry()
    reg.register({ toolName: 'test_tool', process: () => null })
    const calls: OaiToolCall[] = [
      { id: 'tc1', type: 'function', function: { name: 'test_tool', arguments: '{"keep":true}' } },
    ]
    assert.strictEqual(reg.processToolCalls(calls), calls)
  })

  it('swallows processor exceptions (fail-open)', () => {
    const reg = new ToolArgPostProcessorRegistry()
    reg.register({ toolName: 'boom', process: () => { throw new Error('kaboom') } })
    const calls: OaiToolCall[] = [
      { id: 'tc1', type: 'function', function: { name: 'boom', arguments: '{}' } },
    ]
    assert.strictEqual(reg.processToolCalls(calls), calls, 'should keep original on exception')
  })

  it('processes mixed calls — some replaced, some not', () => {
    const reg = new ToolArgPostProcessorRegistry()
    reg.register({ toolName: 'big_tool', process: () => '{"tiny":true}' })
    const calls: OaiToolCall[] = [
      { id: 'a', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"/x"}' } },
      { id: 'b', type: 'function', function: { name: 'big_tool', arguments: '{"huge":"data"}' } },
    ]
    const result = reg.processToolCalls(calls)
    assert.equal(result[0]!.function.arguments, '{"file_path":"/x"}')
    assert.equal(result[1]!.function.arguments, '{"tiny":true}')
  })
})

describe('planSubmitArgProcessor', () => {
  it('replaces large plan with file pointer', () => {
    const bigPlan = '# My Plan\n\n'.repeat(100) // ~1200 chars
    const args = JSON.stringify({ title: 'Test Plan', plan: bigPlan })
    const result = planSubmitArgProcessor.process(args)
    assert.ok(result, 'should return replacement')
    const parsed = JSON.parse(result!)
    assert.ok(parsed.plan.startsWith('[plan persisted to'))
    assert.ok(parsed.plan.includes('.rivet/plans/test-plan.md'))
    assert.equal(parsed.title, 'Test Plan')
  })

  it('is idempotent — re-processing returns null', () => {
    const bigPlan = '# Plan\n'.repeat(50)
    const args = JSON.stringify({ title: 'Test', plan: bigPlan })
    const first = planSubmitArgProcessor.process(args)
    assert.ok(first)
    const second = planSubmitArgProcessor.process(first!)
    assert.equal(second, null, 'should not re-process')
  })

  it('returns null for non-plan args', () => {
    assert.equal(planSubmitArgProcessor.process('{"foo":"bar"}'), null)
  })

  it('returns null for invalid JSON', () => {
    assert.equal(planSubmitArgProcessor.process('{not json'), null)
  })

  it('returns null when plan is empty', () => {
    const args = JSON.stringify({ title: 'Test', plan: '' })
    assert.equal(planSubmitArgProcessor.process(args), null)
  })

  it('result is valid JSON', () => {
    const args = JSON.stringify({ title: 'Test', plan: '# Plan\n'.repeat(50) })
    const result = planSubmitArgProcessor.process(args)
    assert.ok(result)
    // Must not throw
    JSON.parse(result!)
  })

  it('returns null when title is missing (no dangling pointer)', () => {
    const args = JSON.stringify({ plan: '# Plan\n'.repeat(50) })
    assert.equal(planSubmitArgProcessor.process(args), null)
  })

  it('returns null when title is empty string', () => {
    const args = JSON.stringify({ title: '  ', plan: '# Plan\n'.repeat(50) })
    assert.equal(planSubmitArgProcessor.process(args), null)
  })
})
