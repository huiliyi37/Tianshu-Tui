/**
 * Recovery stack — list and undo via recovery journal entries.
 *
 * Tracks both mutations (file changes with backups) and restorations (undo events),
 * providing a complete audit trail for file operations.
 *
 * 2026-08-25 全异步化（fs/promises）：备份链（copy/mkdir/淘汰的 readdir+rm）原是
 * 每次编辑跑一遍的同步 IO——Windows+杀毒下 copyFileSync 大文件、rmSync 递归删
 * 目录树都是百毫秒~秒级主线程卡顿（apply_patch 每 target 再 ×N），是编辑热路径
 * 上最后一批同步阻塞点（/scout 卡死事故线的同类项）。纪律不变量：备份必须先于
 * 覆写完成——调用方必须 await trackFileChange，否则备份会拷到新内容。
 */

import { readUnacknowledged, recordRecovery, type RecoveryEntry } from './recovery-journal.js'
import { access, copyFile, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'

/** Lightweight record of a file mutation with a backup for undo. */
export interface FileChangeRecord {
  filePath: string
  action: 'edit' | 'write' | 'delete'
  /** Path to a temporary backup of the original file content. */
  backupPath?: string
  toolCallId: string
  ts: number
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

export function listRecoveryStack(cwd: string, sessionId?: string): RecoveryEntry[] {
  return readUnacknowledged(cwd, sessionId)
}

export function renderRecoveryStack(cwd: string, sessionId?: string): string {
  const entries = listRecoveryStack(cwd, sessionId)
  if (entries.length === 0) return 'Recovery stack empty — no unacknowledged recovery events.'

  const lines = entries.map((e, i) =>
    `${i + 1}. ${e.file} — ${e.action} (${e.linesLost} lines lost, ${e.ts})`,
  )
  return `Recovery stack (${entries.length}):\n${lines.join('\n')}\n\nThese files were restored during the session; verify intent before deliver_task.`
}

/** Record a file restore event (called from undo/edit recovery paths). */
export function trackFileRestore(
  cwd: string,
  file: string,
  action: string,
  linesLost = 0,
  sessionId?: string,
): void {
  recordRecovery(cwd, { file, action, linesLost }, sessionId)
}

/** Per-process latest backup path per (cwd, filePath). Used by the edit tools
 *  to roll back a write when post-edit structural validation fails.
 *  Keyed by canonical absolute path to avoid collisions across sessions. */
const latestBackups = new Map<string, string>()

function backupKey(cwd: string, filePath: string): string {
  return join(cwd, filePath)
}

/** Cap on `.rivet/backups/` timestamp directories kept on disk. */
const MAX_BACKUP_DIRS = 100

/** 淘汰去频窗口：淘汰（readdir 全目录 + 递归 rm）不再逐编辑跑，每 cwd 至多
 *  5 分钟一次。窗口内目录数可短暂超过上限（增量 = 窗口内编辑次数，有界），
 *  下一窗口收敛——磁盘换事件循环，值得。 */
const EVICT_INTERVAL_MS = 5 * 60_000
const lastEvictByCwd = new Map<string, number>()

/**
 * Evict oldest timestamp-named backup dirs beyond the cap. The dirs are
 * `Date.now()`-named (see trackFileChange), so name order = age order; only
 * fully-numeric names are eligible, foreign dirs are never touched. Best-effort
 * — eviction failures degrade silently (backup cleanup is non-critical).
 */
export async function evictOldBackups(cwd: string, maxDirs = MAX_BACKUP_DIRS): Promise<void> {
  try {
    const backupsDir = join(cwd, '.rivet', 'backups')
    const dirs = (await readdir(backupsDir, { withFileTypes: true }))
      .filter(e => e.isDirectory() && /^\d+$/.test(e.name))
      .map(e => e.name)
      .sort()
    const excess = dirs.length - maxDirs
    if (excess <= 0) return
    await Promise.all(
      dirs.slice(0, excess).map(name => rm(join(backupsDir, name), { recursive: true, force: true })),
    )
  } catch {
    // Non-critical — degrade silently
  }
}

/** 去频版淘汰：窗口内至多一次，fire-and-forget（不阻塞编辑路径）。 */
function evictOldBackupsDebounced(cwd: string): void {
  const now = Date.now()
  const last = lastEvictByCwd.get(cwd) ?? 0
  if (now - last < EVICT_INTERVAL_MS) return
  lastEvictByCwd.set(cwd, now)
  void evictOldBackups(cwd)
}

/** 测试钩子：清去频窗口（同 __setToolKeepaliveMs 先例）。 */
export function __resetEvictDebounceForTest(): void {
  lastEvictByCwd.clear()
}

/**
 * Restore a file to its most recent backup recorded by trackFileChange.
 * Returns true if a backup existed and was restored; false otherwise.
 */
export async function restoreLatestBackup(cwd: string, filePath: string, sessionId?: string): Promise<boolean> {
  const key = backupKey(cwd, filePath)
  const backupPath = latestBackups.get(key)
  if (!backupPath || !(await pathExists(backupPath))) return false
  const absPath = join(cwd, filePath)
  try {
    await copyFile(backupPath, absPath)
    recordRecovery(cwd, { file: filePath, action: 'restore latest backup', linesLost: 0 }, sessionId)
    return true
  } catch {
    return false
  }
}

/**
 * Create a backup of a file before mutation and record the change.
 * The backup lives in .rivet/backups/<timestamp>/<relpath> so undo can recover.
 *
 * 调用方纪律：必须 await 后再写文件——备份先于覆写是回滚正确性的前提。
 */
export async function trackFileChange(
  cwd: string,
  record: Omit<FileChangeRecord, 'backupPath' | 'ts'>,
): Promise<FileChangeRecord> {
  const ts = Date.now()
  let backupPath: string | undefined

  const absPath = join(cwd, record.filePath)
  if (await pathExists(absPath)) {
    const backupDir = join(cwd, '.rivet', 'backups', String(ts))
    await mkdir(backupDir, { recursive: true })
    const relDir = dirname(record.filePath)
    if (relDir && relDir !== '.') {
      await mkdir(join(backupDir, relDir), { recursive: true })
    }
    backupPath = join(backupDir, record.filePath)
    await copyFile(absPath, backupPath)
    latestBackups.set(backupKey(cwd, record.filePath), backupPath)
    // Unbounded .rivet/backups growth (observed 6,396 dirs / 238MB) — cap it.
    // 去频后不在每次编辑跑（见 evictOldBackupsDebounced 注释）。
    evictOldBackupsDebounced(cwd)
  }

  return { ...record, backupPath, ts }
}

/** Estimate lines lost by comparing current file to backup if available. */
export async function estimateLinesLost(cwd: string, file: string, backupPath?: string): Promise<number> {
  if (!backupPath || !(await pathExists(backupPath))) return 0
  try {
    const backupContent = await readFile(backupPath, 'utf-8')
    const backupLines = backupContent.split('\n').length
    const currentPath = join(cwd, file)
    if (!(await pathExists(currentPath))) return backupLines
    const currentLines = (await readFile(currentPath, 'utf-8')).split('\n').length
    return Math.max(0, backupLines - currentLines)
  } catch {
    return 0
  }
}
