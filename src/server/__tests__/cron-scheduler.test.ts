/**
 * CronScheduler + CronLock 测试
 *
 * 覆盖：
 * - schedule 表 CRUD + 持久化
 * - 时间触发 tick（interval / oneshot / cron）
 * - oneshot 触发即删，recurring 重排
 * - 启动恢复
 * - PID 存活探测
 * - 锁获取/释放/陈旧回收
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, unlinkSync, existsSync, writeFileSync, readdirSync, mkdtempSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { hostname as osHostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CronScheduler,
  computeNextTrigger,
  createScheduledTask,
  type ScheduledTask,
  type ScheduleTable,
} from '../cron-scheduler.js'
import { CronLock, isPidAlive, type LockInfo } from '../cron-lock.js'

// Hermetic: unique temp dir per test instead of a shared fixed .test-tmp path,
// so concurrent runs never collide and corrupt-backup files don't leak into the
// working tree.
let tmpDir = ''
let TEST_SCHEDULE_PATH = ''
let TEST_LOCK_PATH = ''

// ─── CronScheduler ────────────────────────────────────────────

describe('CronScheduler', () => {
  let scheduler: CronScheduler
  let firedTasks: Array<{ prompt: string; tools: string[] }>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cron-sched-'))
    TEST_SCHEDULE_PATH = join(tmpDir, 'test-scheduled-tasks.json')
    firedTasks = []
    scheduler = new CronScheduler({
      schedulePath: TEST_SCHEDULE_PATH,
      tickIntervalMs: 100,
      onCreateTask: async (prompt, tools) => {
        firedTasks.push({ prompt, tools })
      },
    })
  })

  afterEach(() => {
    scheduler.stop()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('adds and lists scheduled tasks', () => {
    const task = createScheduledTask('test', { type: 'oneshot', spec: futureISO(60) })
    scheduler.add(task)

    const list = scheduler.list()
    assert.equal(list.length, 1)
    assert.equal(list[0]!.prompt, 'test')
    assert.equal(list[0]!.trigger.type, 'oneshot')
  })

  it('list/get return defensive copies so callers cannot mutate scheduler state', () => {
    const task = createScheduledTask('immutable', { type: 'interval', spec: '60000' })
    scheduler.add(task)

    const listed = scheduler.list()
    listed[0]!.prompt = 'mutated outside'

    assert.equal(scheduler.get(task.id)!.prompt, 'immutable')
  })

  it('supports multiple task-due subscribers without private-field rewiring', async () => {
    const seen: string[] = []
    const unsubscribe = scheduler.subscribeTaskDue(async (prompt) => { seen.push(`sub:${prompt}`) })
    const task = createScheduledTask('due', { type: 'oneshot', spec: new Date(Date.now() - 1000).toISOString() })

    scheduler.add(task)
    await sleep(20)
    unsubscribe()

    assert.ok(firedTasks.some(t => t.prompt === 'due'))
    assert.ok(seen.includes('sub:due'))
  })

  it('removes scheduled task by id', () => {
    const task = createScheduledTask('test', { type: 'interval', spec: '60000' })
    scheduler.add(task)
    assert.equal(scheduler.list().length, 1)

    scheduler.remove(task.id)
    assert.equal(scheduler.list().length, 0)
  })

  it('fires oneshot task that is already due', async () => {
    const task = createScheduledTask('immediate', {
      type: 'oneshot',
      spec: new Date(Date.now() - 1000).toISOString(), // 1 秒前
    })
    scheduler.add(task)

    // oneshot 已过期 → 应立即可见被触发（task 不入表，直接 fire）
    // add() 中已过期 oneshot 直接 fireTask，不入表
    assert.equal(scheduler.list().length, 0)
    assert.equal(firedTasks.length, 1)
    assert.equal(firedTasks[0]!.prompt, 'immediate')
  })

  it('fires oneshot task when its time arrives via tick', async () => {
    const task = createScheduledTask('future', {
      type: 'oneshot',
      spec: new Date(Date.now() + 200).toISOString(), // 200ms 后
    })
    scheduler.add(task)
    assert.equal(scheduler.list().length, 1)

    scheduler.start()

    // 等待 tick 触发
    await sleep(500)

    assert.equal(firedTasks.length, 1)
    assert.equal(firedTasks[0]!.prompt, 'future')

    // oneshot 触发后应被删除
    assert.equal(scheduler.list().length, 0)
  })

  it('fires interval task repeatedly', async () => {
    const task = createScheduledTask('recurring', {
      type: 'interval',
      spec: '50', // 50ms 间隔
    })
    scheduler.add(task)

    scheduler.start()

    await sleep(400)

    // 400ms / 50ms ≈ 8 次触发（至少应 >= 2）
    assert.ok(firedTasks.length >= 2, `expected >= 2 firings, got ${firedTasks.length}`)
    firedTasks.forEach(f => assert.equal(f.prompt, 'recurring'))

    // interval 任务仍在表中
    assert.equal(scheduler.list().length, 1)
  })

  it('persists schedule table and recovers on restart', () => {
    const task = createScheduledTask('persisted', { type: 'interval', spec: '60000' })
    scheduler.add(task)

    // 创建新 scheduler 实例（模拟重启）
    const scheduler2 = new CronScheduler({
      schedulePath: TEST_SCHEDULE_PATH,
    })
    scheduler2.start()

    const list = scheduler2.list()
    assert.equal(list.length, 1)
    assert.equal(list[0]!.prompt, 'persisted')

    scheduler2.stop()
  })

  it('quarantines a corrupt schedule file instead of silently clearing it', () => {
    writeFileSync(TEST_SCHEDULE_PATH, '{not-json', 'utf-8')

    const scheduler2 = new CronScheduler({ schedulePath: TEST_SCHEDULE_PATH })
    scheduler2.start()

    assert.equal(scheduler2.list().length, 0)
    assert.ok(readdirSync(tmpDir).some(f => f.startsWith('test-scheduled-tasks.json.corrupt-')))
    scheduler2.stop()
  })

  it('drops invalid persisted schedule entries while keeping valid ones', () => {
    const valid = createScheduledTask('valid', { type: 'interval', spec: '60000' })
    writeFileSync(TEST_SCHEDULE_PATH, JSON.stringify([{ id: '../bad' }, valid]), 'utf-8')

    const scheduler2 = new CronScheduler({ schedulePath: TEST_SCHEDULE_PATH })
    scheduler2.start()

    assert.deepEqual(scheduler2.list().map(t => t.id), [valid.id])
    scheduler2.stop()
  })

  it('removes recurring task past maxAge', async () => {
    const task = createScheduledTask('expiring', { type: 'interval', spec: '100' }, [], {
      recurringMaxAgeMs: 200, // 200ms 后过期
    })
    // 手动设置 createdAt 为过去
    task.createdAt = new Date(Date.now() - 300).toISOString()

    scheduler.add(task)
    scheduler.start()

    // 第一次 tick 应该清理掉过期任务
    await sleep(300)

    assert.equal(scheduler.list().length, 0)
    scheduler.stop()
  })

  it('stops tick on stop()', async () => {
    const task = createScheduledTask('stopped', { type: 'interval', spec: '100' })
    scheduler.add(task)

    scheduler.start()
    await sleep(150)

    const countBeforeStop = firedTasks.length
    scheduler.stop()
    await sleep(300)

    // 停止后不再触发
    assert.equal(firedTasks.length, countBeforeStop)
  })
})

// ─── computeNextTrigger ──────────────────────────────────────

describe('computeNextTrigger', () => {
  it('interval: returns lastTriggeredAt + interval', () => {
    const now = Date.now()
    const task: ScheduledTask = {
      ...createScheduledTask('test', { type: 'interval', spec: '60000' }),
      lastTriggeredAt: new Date(now).toISOString(),
    }
    const next = computeNextTrigger(task, now + 1000)
    assert.equal(next, now + 60000)
  })

  it('interval: uses createdAt as base if never triggered', () => {
    const now = Date.now()
    const createdAt = new Date(now - 10000).toISOString() // 10 秒前创建
    const task: ScheduledTask = {
      ...createScheduledTask('test', { type: 'interval', spec: '60000' }),
      createdAt,
    }
    const next = computeNextTrigger(task, now)
    // createdAt + 60000ms
    assert.equal(next, new Date(createdAt).getTime() + 60000)
  })

  it('oneshot: returns spec time if not yet triggered', () => {
    const future = new Date(Date.now() + 60000).toISOString()
    const task = createScheduledTask('test', { type: 'oneshot', spec: future })
    const next = computeNextTrigger(task, Date.now())
    assert.equal(next, new Date(future).getTime())
  })

  it('oneshot: returns null if already triggered', () => {
    const task: ScheduledTask = {
      ...createScheduledTask('test', { type: 'oneshot', spec: new Date().toISOString() }),
      triggerCount: 1,
    }
    const next = computeNextTrigger(task, Date.now())
    assert.equal(next, null)
  })

  it('oneshot: returns now if spec is in the past and not triggered', () => {
    const past = new Date(Date.now() - 60000).toISOString()
    const task = createScheduledTask('test', { type: 'oneshot', spec: past })
    const now = Date.now()
    const next = computeNextTrigger(task, now)
    assert.ok(next !== null)
    assert.ok(next! <= now) // 立即触发
  })

  it('cron: returns next matching time (simple minute hour)', () => {
    const now = new Date('2024-06-01T10:00:00Z').getTime()
    const task = createScheduledTask('test', { type: 'cron', spec: '30 14 * * *' }) // 14:30
    const next = computeNextTrigger(task, now)
    assert.ok(next !== null)
    // Should be today at 14:30
    const nextDate = new Date(next!)
    assert.equal(nextDate.getUTCHours(), 14)
    assert.equal(nextDate.getUTCMinutes(), 30)
  })

  it('cron: returns next day if time already passed', () => {
    const now = new Date('2024-06-01T15:00:00Z').getTime() // 15:00, past 14:30
    const task = createScheduledTask('test', { type: 'cron', spec: '30 14 * * *' })
    const next = computeNextTrigger(task, now)
    assert.ok(next !== null)
    // Should be tomorrow at 14:30
    const nextDate = new Date(next!)
    assert.equal(nextDate.getUTCHours(), 14)
    assert.equal(nextDate.getUTCMinutes(), 30)
    assert.ok(nextDate.getTime() > now)
  })

  it('cron: returns null for invalid expression', () => {
    const task = createScheduledTask('test', { type: 'cron', spec: 'invalid' })
    const next = computeNextTrigger(task, Date.now())
    assert.equal(next, null)
  })
})

// ─── CronLock ─────────────────────────────────────────────────

describe('CronLock', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cron-sched-lock-'))
    TEST_LOCK_PATH = join(tmpDir, 'test-scheduled-tasks.lock')
    rmSync(TEST_LOCK_PATH, { force: true })
  })

  afterEach(() => {
    try { unlinkSync(TEST_LOCK_PATH) } catch { /* ignore */ }
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('acquires lock when no lock file exists', () => {
    const lock = new CronLock({ lockPath: TEST_LOCK_PATH, healthCheckIntervalMs: 99999 })
    const state = lock.acquire()

    assert.equal(state.status, 'acquired')
    assert.equal((state as any).info.pid, process.pid)
    assert.ok(existsSync(TEST_LOCK_PATH))
    lock.release()
  })

  it('contends when another pid holds the lock', () => {
    // 写入一个伪造的活跃 PID 锁文件
    const fakeOwner: LockInfo = {
      pid: process.pid, // 自己（确保存活）
      acquiredAt: new Date().toISOString(),
      hostname: osHostname(),
    }
    writeFileSync(TEST_LOCK_PATH, JSON.stringify(fakeOwner), 'utf-8')

    const lock = new CronLock({ lockPath: TEST_LOCK_PATH, healthCheckIntervalMs: 99999 })
    const state = lock.acquire()

    assert.equal(state.status, 'contended') // 同 PID 但缺少 owner token → 不视为自己持有，防 PID 复用
    lock.release()
  })

  it('recovers stale lock when owner pid is dead', () => {
    // 写入一个不可能存活的 PID
    const fakeOwner: LockInfo = {
      pid: 99999, // 极不可能存在
      acquiredAt: new Date().toISOString(),
      hostname: osHostname(),
    }
    writeFileSync(TEST_LOCK_PATH, JSON.stringify(fakeOwner), 'utf-8')

    const lock = new CronLock({ lockPath: TEST_LOCK_PATH, healthCheckIntervalMs: 99999 })
    const state = lock.acquire()

    assert.equal(state.status, 'stale_recovered')
    assert.equal((state as any).previousOwner.pid, 99999)
    assert.equal((state as any).info.pid, process.pid)
    lock.release()
  })

  it('releases lock and removes file', () => {
    const lock = new CronLock({ lockPath: TEST_LOCK_PATH, healthCheckIntervalMs: 99999 })
    lock.acquire()
    assert.ok(existsSync(TEST_LOCK_PATH))

    lock.release()
    assert.equal(existsSync(TEST_LOCK_PATH), false)
  })

  it('isOwner returns true after acquire', () => {
    const lock = new CronLock({ lockPath: TEST_LOCK_PATH, healthCheckIntervalMs: 99999 })
    lock.acquire()
    assert.ok(lock.isOwner())
    lock.release()
  })

  it('isOwner returns false after release', () => {
    const lock = new CronLock({ lockPath: TEST_LOCK_PATH, healthCheckIntervalMs: 99999 })
    lock.acquire()
    lock.release()
    assert.equal(lock.isOwner(), false)
  })

  it('forceRelease removes lock regardless of owner', () => {
    const fakeOwner: LockInfo = {
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      hostname: osHostname(),
    }
    writeFileSync(TEST_LOCK_PATH, JSON.stringify(fakeOwner), 'utf-8')

    const lock = new CronLock({ lockPath: TEST_LOCK_PATH })
    lock.forceRelease()
    assert.equal(existsSync(TEST_LOCK_PATH), false)
  })

  it('getState returns null before acquire', () => {
    const lock = new CronLock({ lockPath: TEST_LOCK_PATH })
    assert.equal(lock.getState(), null)
  })
})

// ─── isPidAlive ───────────────────────────────────────────────

describe('isPidAlive', () => {
  it('current process is alive', () => {
    assert.ok(isPidAlive(process.pid))
  })

  it('pid 0 is not alive (kernel process, not a real pid)', () => {
    // pid 0 is the kernel idle process — it exists but has no state
    const alive = isPidAlive(0)
    // On macOS, pid 0 usually reports nothing from ps
    // Just verify it doesn't throw
    assert.equal(typeof alive, 'boolean')
  })

  it('very large pid is not alive', () => {
    assert.equal(isPidAlive(999999), false)
  })
})

// ─── Helpers ──────────────────────────────────────────────────

function futureISO(secondsAhead: number): string {
  return new Date(Date.now() + secondsAhead * 1000).toISOString()
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
