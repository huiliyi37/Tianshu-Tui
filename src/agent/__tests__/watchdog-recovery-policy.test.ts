import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { WatchdogRecoveryPolicy } from '../watchdog-recovery-policy.js'

describe('WatchdogRecoveryPolicy', () => {
  test('consecutive cap：无进度的连续 stall 第 4 次起停止，stopReason=consecutive', () => {
    const p = new WatchdogRecoveryPolicy()
    // 前 3 次续跑（每次都是密集 stall，同时消耗 session 配额）
    for (let i = 0; i < 3; i++) {
      const d = p.onStall()
      assert.equal(d.autoContinue, true, `第 ${i + 1} 次应续跑`)
      assert.equal(d.dense, true, '无进度 → 密集')
    }
    const d4 = p.onStall()
    assert.equal(d4.autoContinue, false)
    assert.equal(d4.stopReason, 'consecutive')
  })

  test('recordTurnComplete 重置 consecutive，恢复续跑预算', () => {
    const p = new WatchdogRecoveryPolicy()
    for (let i = 0; i < 3; i++) p.onStall()
    assert.equal(p.onStall().autoContinue, false)
    p.recordTurnComplete()
    assert.equal(p.onStall().autoContinue, true, 'turn 完成后应恢复预算')
  })

  test('recordUserSubmit 重置 consecutive 但不加进度', () => {
    const p = new WatchdogRecoveryPolicy()
    for (let i = 0; i < 3; i++) p.onStall()
    p.recordUserSubmit()
    const d = p.onStall()
    assert.equal(d.autoContinue, true)
    assert.equal(d.dense, true, 'user submit 不产生进度单元，stall 仍判密集')
  })

  test('session-total cap：tiny-turn 重置循环 12 次后停止，stopReason=session-total', () => {
    const p = new WatchdogRecoveryPolicy()
    let continues = 0
    for (let i = 0; i < 15; i++) {
      p.recordTurnComplete()          // tiny-turn：重置 consecutive，+1 进度（1 < 4 仍密集）
      if (p.onStall().autoContinue) continues++
    }
    assert.equal(continues, 12)
    const d = p.onStall()
    assert.equal(d.autoContinue, false)
    assert.equal(d.stopReason, 'session-total')
  })

  test('稀疏 stall（>= 4 进度单元）不消耗 session 配额', () => {
    const p = new WatchdogRecoveryPolicy()
    let continues = 0
    for (let i = 0; i < 20; i++) {
      // 2 个完整工具批 = 2 completion + 2 tool result = 4 单元
      p.recordToolResult(); p.recordTurnComplete()
      p.recordToolResult(); p.recordTurnComplete()
      const d = p.onStall()
      if (d.autoContinue) { continues++; assert.equal(d.dense, false) }
    }
    assert.equal(continues, 20, '稀疏 stall 永不触顶')
  })

  test('两 cap 同时越界时 stopReason 优先报 session-total（对齐 TUI 消息优先级）', () => {
    const p = new WatchdogRecoveryPolicy({ maxConsecutive: 1, maxSessionTotal: 1 })
    assert.equal(p.onStall().autoContinue, true)   // consecutive=1, sessionTotal=1
    const d = p.onStall()
    assert.equal(d.stopReason, 'session-total')
  })

  test('suppressed stall 不消耗任何状态', () => {
    const p = new WatchdogRecoveryPolicy()
    p.recordToolResult(); p.recordToolResult()
    p.recordToolResult(); p.recordTurnComplete()   // 4 单元
    const d = p.onStall({ suppressed: true })
    assert.equal(d.autoContinue, false)
    assert.equal(d.stopReason, 'suppressed')
    assert.deepEqual(p.snapshot(), { consecutive: 0, sessionTotal: 0, progressUnits: 4 },
      'suppressed 不清进度、不加 consecutive、不计配额')
  })

  test('cap 越界的 stall 不消耗状态（进度保留到下一次判定）', () => {
    const p = new WatchdogRecoveryPolicy({ maxConsecutive: 1 })
    p.onStall()                                    // consecutive=1（顶满）
    p.recordToolResult()                           // 1 单元
    const rejected = p.onStall()                   // consecutive=1 >= 1 → 拒绝
    assert.equal(rejected.autoContinue, false)
    assert.equal(p.snapshot().progressUnits, 1, '被拒的 stall 不得清零进度')
  })

  test('snapshot 暴露遥测三元组', () => {
    const p = new WatchdogRecoveryPolicy()
    p.recordTurnComplete()
    p.onStall()
    assert.deepEqual(p.snapshot(), { consecutive: 1, sessionTotal: 1, progressUnits: 0 })
  })
})
