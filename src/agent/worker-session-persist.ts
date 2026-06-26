import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import type { OaiMessage } from '../api/oai-types.js'

/** Persisted worker session history — the full OaiMessage transcript from a
 *  completed worker run, so a later `resume` delegate_task can rebuild it. */
export interface WorkerSessionRecord {
  readonly workOrderId: string
  readonly profile: string
  readonly objective: string
  readonly messages: readonly OaiMessage[]
  readonly savedAt: number
}

export function workerSessionPath(workOrderId: string, homeDir: string = homedir()): string {
  return join(homeDir, '.rivet', 'subagents', `${workOrderId}.session.jsonl`)
}

/** Persist worker session history to ~/.rivet/subagents/<orderId>.session.jsonl.
 *  Best-effort: never blocks the primary session on persistence failure. */
export function saveWorkerSession(
  workOrderId: string,
  profile: string,
  objective: string,
  messages: readonly OaiMessage[],
  homeDir: string = homedir(),
): void {
  try {
    const dir = join(homeDir, '.rivet', 'subagents')
    mkdirSync(dir, { recursive: true })
    const record: WorkerSessionRecord = {
      workOrderId,
      profile,
      objective,
      messages,
      savedAt: Date.now(),
    }
    writeFileSync(workerSessionPath(workOrderId, homeDir), JSON.stringify(record) + '\n', 'utf-8')
  } catch {
    // Best-effort: never block primary session on persistence failure
  }
}

/** Load a previously persisted worker session history.
 *  Returns null on cold miss, empty file, or unparseable content — callers
 *  must handle it (typically by degrading to a fresh worker). */
export function loadWorkerSession(workOrderId: string, homeDir: string = homedir()): WorkerSessionRecord | null {
  const path = workerSessionPath(workOrderId, homeDir)
  if (!existsSync(path)) return null
  try {
    const content = readFileSync(path, 'utf-8').trim()
    if (!content) return null
    return JSON.parse(content) as WorkerSessionRecord
  } catch {
    return null
  }
}
