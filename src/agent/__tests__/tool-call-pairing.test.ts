/**
 * collectToolCallPairing 单趟收集器的口径测试（2026-09-05 审查 LOW：loop.ts
 * 三处重复实现收敛后的共享真值）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { collectToolCallPairing, hasOrphanToolCalls, type PairingMessage } from '../tool-call-pairing.js'

const call = (id: string): PairingMessage => ({ role: 'assistant', tool_calls: [{ id }] })
const result = (id: string): PairingMessage => ({ role: 'tool', tool_call_id: id })

describe('collectToolCallPairing', () => {
  it('配对齐全：无双向孤儿', () => {
    const p = collectToolCallPairing([call('a'), result('a'), call('b'), result('b')])
    assert.equal(p.toolCallIds.size, 2)
    assert.equal(p.toolResultIds.size, 2)
    assert.equal(hasOrphanToolCalls(p), false)
  })

  it('孤儿调用（call 无 result）可检出——heal/冻结链的判定对象', () => {
    const p = collectToolCallPairing([call('a'), result('a'), call('b')])
    assert.equal(hasOrphanToolCalls(p), true)
  })

  it('孤儿结果（result 无 call）不算孤儿调用——不触发冻结/愈合', () => {
    const p = collectToolCallPairing([call('a'), result('a'), result('z')])
    assert.equal(hasOrphanToolCalls(p), false)
    assert.equal(p.toolResultIds.has('z'), true)
  })

  it('空消息与无工具消息：零孤儿', () => {
    assert.equal(hasOrphanToolCalls(collectToolCallPairing([])), false)
    assert.equal(hasOrphanToolCalls(collectToolCallPairing([{ role: 'user' }, { role: 'assistant' }])), false)
  })

  it('缺 id 的 tool_calls / 缺 tool_call_id 的 tool 消息被跳过', () => {
    const p = collectToolCallPairing([{ role: 'assistant', tool_calls: [{}] }, { role: 'tool' }])
    assert.equal(p.toolCallIds.size, 0)
    assert.equal(p.toolResultIds.size, 0)
  })
})
