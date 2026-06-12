/**
 * Recovery stack — list and undo via recovery journal entries.
 *
 * Tracks both mutations (file changes with backups) and restorations (undo events),
 * providing a complete audit trail for file operations.
 */

import { readUnacknowledged, recordRecovery, type RecoveryEntry } from './recovery-journal.js'
import { existsSync, readFileSync, mkdirSync, copyFileSync } from 'node:fs'
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

export function listRecoveryStack(cwd: string): RecoveryEntry[] {
  return readUnacknowledged(cwd)
}

export function renderRecoveryStack(cwd: string): string {
  const entries = listRecoveryStack(cwd)
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
): void {
  recordRecovery(cwd, { file, action, linesLost })
}

/**
 * Create a backup of a file before mutation and record the change.
 * The backup lives in .rivet/backups/<timestamp>/<relpath> so undo can recover.
 */
export function trackFileChange(cwd: string, record: Omit<FileChangeRecord, 'backupPath' | 'ts'>): FileChangeRecord {
  const ts = Date.now()
  let backupPath: string | undefined

  const absPath = join(cwd, record.filePath)
  if (existsSync(absPath)) {
    const backupDir = join(cwd, '.rivet', 'backups', String(ts))
    mkdirSync(backupDir, { recursive: true })
    const relDir = dirname(record.filePath)
    if (relDir && relDir !== '.') {
      mkdirSync(join(backupDir, relDir), { recursive: true })
    }
    backupPath = join(backupDir, record.filePath)
    copyFileSync(absPath, backupPath)
  }

  // Also record in the recovery journal for deliver_task visibility
  const linesLost = 0 // mutations don't lose lines yet; only restores do
  recordRecovery(cwd, { file: record.filePath, action: record.action, linesLost })

  return { ...record, backupPath, ts }
}

/** Estimate lines lost by comparing current file to backup if available. */
export function estimateLinesLost(cwd: string, file: string, backupPath?: string): number {
  if (!backupPath || !existsSync(backupPath)) return 0
  try {
    const backupLines = readFileSync(backupPath, 'utf-8').split('\n').length
    const currentPath = join(cwd, file)
    if (!existsSync(currentPath)) return backupLines
    const currentLines = readFileSync(currentPath, 'utf-8').split('\n').length
    return Math.max(0, backupLines - currentLines)
  } catch {
    return 0
  }
}
