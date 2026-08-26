import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  trackFileRestore, renderRecoveryStack, evictOldBackups, trackFileChange,
  __resetEvictDebounceForTest,
} from '../recovery-stack.js'
import { readUnacknowledged } from '../recovery-journal.js'

/** 造 N 个数字命名的备份目录（名字 = Date.now() 格式的时间戳，越早越旧）。 */
function seedBackupDirs(backupsDir: string, count: number, startTs: number): void {
  for (let i = 0; i < count; i++) {
    mkdirSync(join(backupsDir, String(startTs + i)), { recursive: true })
  }
}

function numericBackupCount(backupsDir: string): number {
  try {
    return readdirSync(backupsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && /^\d+$/.test(e.name))
      .length
  } catch {
    return 0
  }
}

/** 轮询等待去频淘汰（fire-and-forget）收敛到期望目录数——有界等待。 */
async function waitForDirCount(backupsDir: string, expected: number, timeoutMs = 2_000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const n = numericBackupCount(backupsDir)
    if (n === expected || Date.now() > deadline) return n
    await new Promise(r => setTimeout(r, 25))
  }
}

describe('recovery-stack', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-recovery-'))

  it('tracks file restore events in journal', () => {
    trackFileRestore(cwd, 'src/a.ts', 'undo tool restore', 5)
    const entries = readUnacknowledged(cwd)
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.file, 'src/a.ts')
    assert.match(renderRecoveryStack(cwd), /src\/a.ts/)
  })

  it('evictOldBackups keeps the newest 100 numeric dirs and leaves foreign dirs alone', async () => {
    const backupsDir = join(cwd, '.rivet', 'backups')
    seedBackupDirs(backupsDir, 105, 1_700_000_000_000)
    mkdirSync(join(backupsDir, 'not-a-timestamp'), { recursive: true })

    await evictOldBackups(cwd)

    const remaining = readdirSync(backupsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort()
    // 105 数字目录 → 保留最新 100（时间戳 1_700_000_000_005 … 1_700_000_000_104）
    const numeric = remaining.filter(n => /^\d+$/.test(n))
    assert.equal(numeric.length, 100, `expected 100 numeric dirs, got ${numeric.length}: ${numeric.join(',')}`)
    assert.equal(numeric[0], '1700000000005', 'oldest numeric dirs must be evicted')
    assert.ok(remaining.includes('not-a-timestamp'), 'non-numeric dir must never be touched')
  })

  it('trackFileChange 触发去频淘汰并最终收敛到上限（fire-and-forget）', async () => {
    const backupsDir = join(cwd, '.rivet', 'backups')
    rmSync(backupsDir, { recursive: true, force: true })
    seedBackupDirs(backupsDir, 101, 1_700_000_000_000)
    const target = join(cwd, 'src', 'x.ts')
    mkdirSync(join(cwd, 'src'), { recursive: true })
    writeFileSync(target, 'v1', 'utf-8')

    __resetEvictDebounceForTest()
    const rec = await trackFileChange(cwd, { filePath: 'src/x.ts', action: 'write', toolCallId: 't1' })
    assert.ok(rec.backupPath, '备份路径应返回（写前备份）')

    // 去频淘汰是 fire-and-forget——轮询等收敛（101 旧 + 1 新 = 102 → 淘汰至 100）
    const n = await waitForDirCount(backupsDir, 100)
    assert.equal(n, 100, `expected eventual convergence to 100, got ${n}`)
  })

  it('去频窗口内的后续编辑不再触发淘汰（每 cwd 5 分钟至多一次）', async () => {
    const backupsDir = join(cwd, '.rivet', 'backups')
    // 上一用例收敛在 100；再造超限并在窗口内编辑——目录应只增不减
    seedBackupDirs(backupsDir, 6, 1_800_000_000_000) // 100 + 6 = 106 > cap
    const target = join(cwd, 'src', 'y.ts')
    writeFileSync(target, 'v1', 'utf-8')

    const before = numericBackupCount(backupsDir)
    await trackFileChange(cwd, { filePath: 'src/y.ts', action: 'write', toolCallId: 't2' })
    await new Promise(r => setTimeout(r, 150))
    const after = numericBackupCount(backupsDir)
    assert.equal(after, before + 1, '窗口内不淘汰：新备份目录入列，旧目录保留')
  })

  after(() => {
    rmSync(cwd, { recursive: true, force: true })
  })
})
