/**
 * Recovery Journal — intent preservation across destructive file operations.
 *
 * When a file edit goes wrong and the agent restores the file (undo / git checkout),
 * the original intent is lost — the file is clean, and the task appears "done."
 *
 * This module records each recovery event so deliver_task can flag outstanding
 * intent that might have been silently dropped.
 *
 * Format (.rivet/recovery-journal.jsonl, one JSON object per line):
 *   {"file":"src/agent/deliver-task.ts","action":"git checkout HEAD","ts":"2026-06-07T...","linesLost":22}
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface RecoveryEntry {
  file: string
  action: string
  ts: string
  linesLost: number
  /** Set to true after deliver_task has shown the warning so it won't repeat. */
  acknowledged?: boolean
}

function journalPath(cwd: string): string {
  return join(cwd, '.rivet', 'recovery-journal.jsonl')
}

export function recordRecovery(cwd: string, entry: Omit<RecoveryEntry, 'ts'>): void {
  const dir = join(cwd, '.rivet')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const record: RecoveryEntry = { ...entry, ts: new Date().toISOString() }
  appendFileSync(journalPath(cwd), JSON.stringify(record) + '\n', 'utf-8')
}

export function readUnacknowledged(cwd: string): RecoveryEntry[] {
  const path = journalPath(cwd)
  if (!existsSync(path)) return []
  try {
    const raw = readFileSync(path, 'utf-8')
    return raw.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line) as RecoveryEntry } catch { return null }
    }).filter((e): e is RecoveryEntry => e !== null && !e.acknowledged)
  } catch {
    return []
  }
}

export function acknowledgeAll(cwd: string): void {
  const entries = readUnacknowledged(cwd)
  if (entries.length === 0) return
  const acknowledged = entries.map(e => ({ ...e, acknowledged: true }))
  const path = journalPath(cwd)
  writeFileSync(path, acknowledged.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8')
}
