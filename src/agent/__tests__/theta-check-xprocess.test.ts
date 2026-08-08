import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runThetaCheck, clearThetaCache } from '../theta-check.js'

// Cross-process cache behavior: disk-backed cache + lock so independent
// 天枢 TUI processes on the same repo don't each spawn tsc.

const tempDirs: string[] = []

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'theta-xproc-'))
  tempDirs.push(dir)
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: true },
    include: ['*.ts'],
  }))
  writeFileSync(join(dir, 'valid.ts'), 'export const x: number = 42\n')
  // Pre-create the cache dir so tests can seed disk cache / lock files directly.
  mkdirSync(join(dir, '.rivet', 'tmp'), { recursive: true })
  return dir
}

const cacheFile = (dir: string) => join(dir, '.rivet', 'tmp', 'theta-cache.json')
const lockFile = (dir: string) => join(dir, '.rivet', 'tmp', 'theta-cache.lock')

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    clearThetaCache(dir)
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

describe('runThetaCheck cross-process cache', () => {
  it('writes an on-disk cache under .rivet/tmp so other processes can reuse it', async () => {
    const dir = makeProject()
    await runThetaCheck(dir, 20_000)

    assert.ok(existsSync(cacheFile(dir)), 'disk cache file should exist')
    const entry = JSON.parse(readFileSync(cacheFile(dir), 'utf8'))
    assert.ok(Array.isArray(entry.result.errors))
    assert.equal(typeof entry.cachedAt, 'number')
  })

  it('reuses fresh on-disk cache instead of spawning (simulates a second process)', async () => {
    const dir = makeProject()
    // Seed a fresh disk cache as if another process just ran tsc.
    const seeded = { result: { errors: ['seeded.ts'], durationMs: 1, timedOut: false }, cachedAt: Date.now() }
    writeFileSync(cacheFile(dir), JSON.stringify(seeded))
    // New in-process call (clear mem so it must consult disk) must reuse it.
    clearThetaCache()
    const result = await runThetaCheck(dir, 20_000)
    assert.deepEqual(result.errors, ['seeded.ts'], 'should reuse seeded disk result, not spawn')
    // 旧格式缓存（无 outcome 字段）兼容读取：按正缓存处理
    assert.equal(result.outcome, 'type_errors')
  })

  it('a held lock makes a concurrent caller reuse last result without spawning', async () => {
    const dir = makeProject()
    // Simulate another process currently running tsc: fresh lock, stale-ish
    // disk result from before.
    const old = { result: { errors: ['prev.ts'], durationMs: 5, timedOut: false }, cachedAt: Date.now() - 30_000 }
    writeFileSync(cacheFile(dir), JSON.stringify(old))
    writeFileSync(lockFile(dir), JSON.stringify({ pid: 999999, at: Date.now() }))
    clearThetaCache()

    const start = Date.now()
    const result = await runThetaCheck(dir, 20_000)
    // Must not block on a real tsc (~6s) — returns the prior result fast.
    assert.ok(Date.now() - start < 2_000, 'lock-held path must not spawn tsc')
    assert.deepEqual(result.errors, ['prev.ts'], 'reuses last on-disk result under contention')
    // 锁竞争不再伪装成新鲜成功——outcome 标 busy（诚实归因）
    assert.equal(result.outcome, 'busy')
  })

  it('negative cache: 锁竞争 + fresh 负缓存 → backoff（不 spawn 不伪装）', async () => {
    const dir = makeProject()
    const neg = {
      result: { errors: [], durationMs: 15_000, timedOut: true, outcome: 'timeout' },
      cachedAt: Date.now(),
      negative: true,
    }
    writeFileSync(cacheFile(dir), JSON.stringify(neg))
    writeFileSync(lockFile(dir), JSON.stringify({ pid: 999999, at: Date.now() }))
    clearThetaCache()

    const result = await runThetaCheck(dir, 20_000)
    assert.equal(result.outcome, 'backoff', '负缓存窗口内锁竞争也返回 backoff')
    assert.deepEqual(result.errors, [])
  })

  it('negative cache: 无磁盘结果 + 锁竞争 → busy（不再是空错误且非超时的假绿）', async () => {
    const dir = makeProject()
    writeFileSync(lockFile(dir), JSON.stringify({ pid: 999999, at: Date.now() }))
    clearThetaCache()

    const result = await runThetaCheck(dir, 20_000)
    assert.equal(result.outcome, 'busy', '锁竞争且无可用结果必须显式 busy')
    assert.equal(result.timedOut, false)
  })

  it('half-open probe: 负缓存过期后成功运行覆盖为正值（失败状态清除）', async () => {
    const dir = makeProject()
    // 61 秒前的负缓存——已过期，半开探针允许放行
    const staleNeg = {
      result: { errors: [], durationMs: 15_000, timedOut: true, outcome: 'timeout' },
      cachedAt: Date.now() - 61_000,
      negative: true,
    }
    writeFileSync(cacheFile(dir), JSON.stringify(staleNeg))
    clearThetaCache()

    const result = await runThetaCheck(dir, 20_000)
    assert.equal(result.outcome, 'ok', '过期负缓存放行真实检查')
    const disk = JSON.parse(readFileSync(cacheFile(dir), 'utf8'))
    assert.equal(disk.negative, false, '成功结果必须覆盖负缓存')
    assert.equal(disk.result.outcome, 'ok')
  })

  it('steals a stale lock (crashed owner) and proceeds', async () => {
    const dir = makeProject()
    // Lock far older than timeout + buffer → considered stale, stealable.
    writeFileSync(lockFile(dir), JSON.stringify({ pid: 999999, at: Date.now() - 60_000 }))
    clearThetaCache()
    const result = await runThetaCheck(dir, 10_000)
    assert.deepEqual(result.errors, [], 'after stealing stale lock, runs tsc on valid project')
  })

  it('keys the in-memory cache by cwd (no cross-cwd pollution)', async () => {
    const dirA = makeProject()
    const dirB = makeProject()
    // Seed disk cache for B with a distinct marker.
    writeFileSync(cacheFile(dirB), JSON.stringify({
      result: { errors: ['only-in-B.ts'], durationMs: 1, timedOut: false }, cachedAt: Date.now(),
    }))
    const a = await runThetaCheck(dirA, 20_000)
    const b = await runThetaCheck(dirB, 20_000)
    assert.deepEqual(a.errors, [], 'A is a valid project')
    assert.deepEqual(b.errors, ['only-in-B.ts'], 'B must read its own cache, not A result')
  })
})
