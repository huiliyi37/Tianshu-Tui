import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LEAVE_MARK_TOOL } from '../leave-mark.js'
import type { ToolCallParams, LeaveMarkInput } from '../types.js'

function params(input: Record<string, unknown>, onLeaveMark?: (m: LeaveMarkInput) => void): ToolCallParams {
  return { input, toolUseId: 't', cwd: '/tmp', onLeaveMark }
}

test('leave_mark captures the agent-chosen symbol + summary via the callback', async () => {
  const calls: LeaveMarkInput[] = []
  const res = await LEAVE_MARK_TOOL.execute(
    params({ symbol: '⚘', summary: 'wired the starmap', type: 'feature', tags: ['ui'] }, m => { calls.push(m) }),
  )
  assert.equal(res.isError, undefined)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.symbol, '⚘')
  assert.equal(calls[0]!.summary, 'wired the starmap')
  assert.equal(calls[0]!.type, 'feature')
  assert.deepEqual(calls[0]!.tags, ['ui'])
})

test('leave_mark drops an unknown type rather than passing it through', async () => {
  const calls: LeaveMarkInput[] = []
  await LEAVE_MARK_TOOL.execute(params({ symbol: '✦', summary: 'x', type: 'bogus' }, m => { calls.push(m) }))
  assert.equal(calls[0]!.type, undefined)
})

test('leave_mark requires symbol and summary', async () => {
  const a = await LEAVE_MARK_TOOL.execute(params({ summary: 'x' }))
  assert.equal(a.isError, true)
  const b = await LEAVE_MARK_TOOL.execute(params({ symbol: '✦' }))
  assert.equal(b.isError, true)
})

test('leave_mark is inert (no throw) without a runtime callback', async () => {
  const res = await LEAVE_MARK_TOOL.execute(params({ symbol: '✦', summary: 'x' }))
  assert.equal(res.isError, undefined)
  assert.match(res.content, /no starmap/i)
})

test('leave_mark is concurrency-safe, enabled, and needs no approval', () => {
  assert.equal(LEAVE_MARK_TOOL.isConcurrencySafe(), true)
  assert.equal(LEAVE_MARK_TOOL.isEnabled(), true)
  assert.equal(LEAVE_MARK_TOOL.requiresApproval(params({})), false)
})
