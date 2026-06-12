/**
 * Recovery stack — list and undo via recovery journal entries.
 */

import { readUnacknowledged, recordRecovery, type RecoveryEntry } from './recovery-journal.js'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

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
