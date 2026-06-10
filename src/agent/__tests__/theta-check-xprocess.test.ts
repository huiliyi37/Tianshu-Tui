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
