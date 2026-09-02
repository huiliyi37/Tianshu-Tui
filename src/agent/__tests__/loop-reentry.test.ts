import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AgentLoop } from '../loop.js'

test('run claims the instance synchronously before awaiting idle compaction', async () => {
  let releaseIdle!: () => void
  const idleGate = new Promise<void>(resolve => { releaseIdle = resolve })
  let cancelCalls = 0
  let innerCalls = 0
  let schedules = 0
  const fake = {
    _running: false,
    _pendingAbort: false,
    _watchdogAborted: false,
    abortController: null,
    // 64c692e4：run() 在 drain 前调用 session.resetSrCount()（SR 每轮上限）
    session: { resetSrCount: () => {} },
    // Zen Mode（禅模式）：run() 在 turn 边界调 zenTurnBoundary（triage + 步数预算）——
    // fake 契约跟随 run() 真实表面（2026-08 接入）
    zenTurnBoundary: () => {},
    // run() 同步段（cancelIdleCompaction 之前）补发当前相位镜像给桌面端徽章：
    // emitZenPhaseEvent(zenController.currentPhase, ...)——fake 契约需随附
    // zenController 表面，否则 first run 在 cancel 前同步 throw（2026-09 回归修复）
    zenController: { currentPhase: 'full', lastPromoteReason: null },
    emitZenPhaseEvent: () => {},
    // W3b：视觉副驾寄存本轮图片（纯内存）——run() 主路径调用，fake 需 stub
    imageRegistry: { register: () => [] },
    cancelIdleCompaction: async () => {
      cancelCalls++
      await idleGate
    },
    _runInner: async () => { innerCalls++ },
    scheduleIdleCompaction: () => { schedules++ },
  }

  const first = AgentLoop.prototype.run.call(fake as unknown as AgentLoop, 'first', {} as never)
  assert.equal(fake._running, true, 'the guard must be claimed before run() returns its first promise')

  const duplicate = AgentLoop.prototype.run.call(fake as unknown as AgentLoop, 'second', {} as never)
  await duplicate
  assert.equal(cancelCalls, 1, 'duplicate run must preserve the existing no-op contract')
  assert.equal(innerCalls, 0)

  releaseIdle()
  await first
  assert.equal(innerCalls, 1)
  assert.equal(fake._running, false)
  assert.equal(schedules, 1)
})
