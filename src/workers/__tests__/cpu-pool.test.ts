/**
 * Tests for the CPU worker pool inline functions.
 *
 * Pool round-trip correctness (worker thread) is verified by the dist smoke
 * test and direct integration test — the `unref()` worker fundamentally
 * conflicts with node:test's event-loop drain detection.
 *
 * Pathological diff timeout tests live in edit-diff.test.ts.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { cpuPool } from '../cpu-pool.js'
import {
  diffUnifiedRaw,
  diffStructuredRaw,
  diffLinesRaw,
} from '../cpu-tasks.js'

// ── Inline functions (no pool needed, always work) ──

describe('cpu-tasks (inline)', () => {
  it('diffUnifiedRaw returns a unified diff for a small change', () => {
    const result = diffUnifiedRaw('test.txt', 'a\n', 'b\n', 1000)
    assert.ok(typeof result === 'string')
    assert.ok(result!.includes('--- test.txt'))
    assert.ok(result!.includes('+++ test.txt'))
  })

  it('diffUnifiedRaw handles empty before (new file)', () => {
    const result = diffUnifiedRaw('new.txt', '', 'alpha\nbeta\n', 1000)
    assert.ok(typeof result === 'string')
    assert.ok(result!.includes('+alpha'))
  })

  it('diffStructuredRaw returns hunks for a small change', () => {
    const before = 'one\ntwo\nthree\n'
    const after = 'one\nTWO\nthree\n'
    const patch = diffStructuredRaw(before, after, 1000)
    assert.ok(patch, 'should produce a patch')
    assert.ok(patch!.hunks.length >= 1, 'at least one hunk')
    const hunk = patch!.hunks[0]!
    assert.equal(hunk.newStart, 2, 'change at line 2')
    assert.equal(hunk.newLines, 1, 'one line changed')
  })

  it('diffLinesRaw returns change objects for a small change', () => {
    const changes = diffLinesRaw('a\nb\nc\n', 'a\nB\nc\n', 1000)
    assert.ok(changes, 'should produce changes')
    const added = changes!.filter(c => c.added)
    const removed = changes!.filter(c => c.removed)
    assert.equal(added.length, 1, 'one added line')
    assert.equal(removed.length, 1, 'one removed line')
  })

  it('diffLinesRaw handles identical content', () => {
    const changes = diffLinesRaw('a\nb\nc\n', 'a\nb\nc\n', 1000)
    assert.ok(changes, 'should produce changes')
    // Identical content: all lines are unchanged (no added/removed flags)
    const added = changes!.filter(c => c.added)
    const removed = changes!.filter(c => c.removed)
    assert.equal(added.length, 0, 'no added lines')
    assert.equal(removed.length, 0, 'no removed lines')
  })
})

// ── Pool availability (no worker spawn needed) ──

describe('cpuPool availability', () => {
  it('cpuPool.available reflects RIVET_CPU_POOL setting', () => {
    const disabled = process.env.RIVET_CPU_POOL === '0'
    assert.equal(cpuPool.available, !disabled)
  })
})

// ── Idle recycle（子进程隔离验证）──
// 主进程内真实 spawn worker 会留下 MessagePort ref（unref 不覆盖），阻塞
// node:test 退出——因此用子进程验证「任务完成后 worker 被空闲回收、进程可
// 退出」。无回收的实现中该子进程永不退出，withTimeout 断言失败 → RED。

const RUN_SCRIPT = `
import { cpuPool } from './src/workers/cpu-pool.ts'
try {
  const r = await cpuPool.run('diffUnifiedRaw', ['t.txt', 'a\\n', 'b\\n', 4000])
  console.log('result:' + (typeof r))
} catch (err) {
  // 禁用路径（RIVET_CPU_POOL=0）下 run 立即 reject——捕获后正常退出
  console.log('rejected:' + (err instanceof Error ? err.message : String(err)))
}
`

function spawnPoolRunner(env: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', RUN_SCRIPT], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    // 失败路径（error / 非零退出 / 外部 reject）先 kill 子进程：挂起的 runner
    // 会经 stderr pipe 保持句柄 ref，拖住测试进程自身退出（审查 LOW-3）。
    const fail = (err: Error): void => {
      try { child.kill() } catch { /* already gone */ }
      reject(err)
    }
    child.stderr.on('data', (chunk: Buffer) => { stderr += String(chunk) })
    child.on('error', fail)
    child.on('close', (code) => {
      if (code !== 0) fail(new Error(`runner exited ${code}: ${stderr.slice(0, 300)}`))
      else resolve(code)
    })
  })
}

describe('cpuPool idle recycle', () => {
  it('任务完成后 worker 被回收，进程在 idle 窗口后退出', async () => {
    const exit = await Promise.race([
      spawnPoolRunner({ RIVET_CPU_POOL_IDLE_MS: '100' }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('runner 未退出：worker 未被空闲回收')), 10_000)),
    ])
    assert.equal(exit, 0)
  })

  it('禁用 worker（RIVET_CPU_POOL=0）时进程同样可退出（回归护栏）', async () => {
    const exit = await Promise.race([
      spawnPoolRunner({ RIVET_CPU_POOL: '0' }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('runner 未退出（禁用路径）')), 10_000)),
    ])
    assert.equal(exit, 0)
  })

  it('非法 RIVET_CPU_POOL_IDLE_MS 值（非数字）回退默认，任务与退出不受影响', async () => {
    // 修复前 NaN → setTimeout(NaN) 立即回收 → 每次 run() 重新 spawn（性能抖动，
    // 功能仍正确）。本测试是回归护栏：非法值不 crash、任务成功、进程可退出。
    // 回退默认 10s 空闲 → 子进程 ~11s 后退出；超时 25s 覆盖（不能设 10s，
    // 会与回退默认的回收窗口竞争）。
    const exit = await Promise.race([
      spawnPoolRunner({ RIVET_CPU_POOL_IDLE_MS: 'abc' }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('runner 未退出（非法 IDLE 值路径）')), 25_000)),
    ])
    assert.equal(exit, 0)
  })
})
