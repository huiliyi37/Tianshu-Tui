import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { installParentWatchdog, probeParentAlive } from '../serve.js'

const INTERVAL = 1000

describe('parent watchdog grace（连续 miss 才自杀）', () => {
  let savedPpid: string | undefined

  beforeEach(() => {
    savedPpid = process.env.RIVET_PARENT_PID
    process.env.RIVET_PARENT_PID = '4242'
    mock.timers.enable({ apis: ['setInterval'] })
  })

  afterEach(() => {
    mock.timers.reset()
    if (savedPpid === undefined) delete process.env.RIVET_PARENT_PID
    else process.env.RIVET_PARENT_PID = savedPpid
  })

  it('单次瞬时探测失败不触发退出', () => {
    const probes = [false, true, true, true]
    let gone = 0
    installParentWatchdog(() => { gone++ }, {
      intervalMs: INTERVAL,
      maxMisses: 3,
      probe: () => probes.shift() ?? true,
    })

    mock.timers.tick(INTERVAL * 4)
    assert.equal(gone, 0, '一次误报后恢复，不得自杀')
  })

  it('连续 3 次失败触发退出，并带上 ppid 与 miss 数', () => {
    let captured: { ppid: number; misses: number } | null = null
    installParentWatchdog(info => { captured = info }, {
      intervalMs: INTERVAL,
      maxMisses: 3,
      probe: () => false,
    })

    mock.timers.tick(INTERVAL * 2)
    assert.equal(captured, null, '前 2 次 miss 还在宽限期内')
    mock.timers.tick(INTERVAL)
    assert.deepEqual(captured, { ppid: 4242, misses: 3 })
  })

  it('失败后恢复会清零计数——间歇性 miss 永不累积到退出', () => {
    // 模式：失败、失败、成功 循环 —— 永远到不了连续 3 次
    let call = 0
    let gone = 0
    installParentWatchdog(() => { gone++ }, {
      intervalMs: INTERVAL,
      maxMisses: 3,
      probe: () => (call++ % 3) === 2,
    })

    mock.timers.tick(INTERVAL * 30)
    assert.equal(gone, 0)
  })

  it('触发退出后定时器停止——回调只会触发一次', () => {
    let gone = 0
    installParentWatchdog(() => { gone++ }, {
      intervalMs: INTERVAL,
      maxMisses: 3,
      probe: () => false,
    })

    for (let i = 0; i < 10; i++) mock.timers.tick(INTERVAL)
    assert.equal(gone, 1)
  })

  it('RIVET_PARENT_PID 缺失或非法时是 no-op', () => {
    delete process.env.RIVET_PARENT_PID
    let gone = 0
    installParentWatchdog(() => { gone++ }, { intervalMs: INTERVAL, maxMisses: 1, probe: () => false })
    mock.timers.tick(INTERVAL * 5)
    assert.equal(gone, 0)

    process.env.RIVET_PARENT_PID = 'not-a-pid'
    installParentWatchdog(() => { gone++ }, { intervalMs: INTERVAL, maxMisses: 1, probe: () => false })
    mock.timers.tick(INTERVAL * 5)
    assert.equal(gone, 0)
  })
})

describe('probeParentAlive', () => {
  it('自身 PID 存活', () => {
    assert.equal(probeParentAlive(process.pid), true)
  })

  it('不存在的 PID 判死', () => {
    // PID 2^22 以上在常见平台都不会被分配
    assert.equal(probeParentAlive(2 ** 24), false)
  })
})
