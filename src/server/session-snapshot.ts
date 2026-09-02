/**
 * P1-4 — read-only portable session snapshot builder.
 *
 * A snapshot is a versioned JSON document containing ONLY conversational
 * messages (user/assistant text, optional reasoning) and — when requested —
 * working-tree change metadata/diffs. It never contains tool call arguments,
 * shell commands, tool outputs, or raw workspace files (aligned with Codex's
 * shared-thread snapshots). All text is redacted before it leaves the server.
 */
import { SessionPersist } from '../agent/session-persist.js'
import { oaiMessageText, type OaiMessage } from '../api/oai-types.js'
import { getFileDiff, getWorkingTreeFiles, type WorkingTreeFile } from '../tools/git.js'
import type { SessionEvent, SessionRecord } from './protocol.js'
import { redactSnapshotValue } from './snapshot-redact.js'

export const SNAPSHOT_VERSION = 1 as const

const MAX_MESSAGES = 2000
const MAX_REASONING_CHARS = 6000
const MAX_FILES = 50
const MAX_DIFF_CHARS = 20_000

export interface SessionSnapshotMessage {
  role: 'user' | 'assistant'
  text: string
  /** Submission time for user messages (best-effort ordinal match to events). */
  ts?: number
  /** Provider reasoning content when includeReasoning is on (truncated). */
  reasoningSummary?: string
}

export interface SessionSnapshotFileChange {
  path: string
  status: WorkingTreeFile['status']
  additions: number
  deletions: number
  diff?: string
}

export interface SessionSnapshot {
  version: typeof SNAPSHOT_VERSION
  createdAt: number
  meta: {
    title: string
    model?: string
  }
  messages: SessionSnapshotMessage[]
  /** Present only when includeFileChanges was requested. */
  fileChanges?: SessionSnapshotFileChange[]
  redaction: {
    findings: number
    appliedAt: number
  }
}

export interface BuildSessionSnapshotOptions {
  includeReasoning?: boolean
  includeFileChanges?: boolean
}

export interface BuildSessionSnapshotResult {
  snapshot: SessionSnapshot
  findings: number
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…(truncated)`
}

/**
 * Build a redacted read-only snapshot for one session. `events` is the full
 * event log (the route passes manager.getEvents(id, 0)); it only supplies
 * user-message timestamps.
 */
export async function buildSessionSnapshot(
  record: SessionRecord,
  events: SessionEvent[],
  options: BuildSessionSnapshotOptions = {},
): Promise<BuildSessionSnapshotResult> {
  const persist = new SessionPersist(record.id, record.cwd)
  let oaiMessages: OaiMessage[]
  try {
    oaiMessages = persist.loadOai()
  } catch {
    oaiMessages = []
  }

  const userEvents = events.filter((e) => e.type === 'user')
  const messages: SessionSnapshotMessage[] = []
  let userOrdinal = 0
  for (const msg of oaiMessages.slice(0, MAX_MESSAGES * 2)) {
    if (msg.role === 'tool') continue // tool inputs/outputs never enter snapshots
    const text = oaiMessageText(msg) ?? ''
    if (msg.role === 'user') {
      if (!text.trim()) continue
      messages.push({ role: 'user', text, ts: userEvents[userOrdinal]?.ts })
      userOrdinal++
    } else if (msg.role === 'assistant') {
      const reasoning = options.includeReasoning && msg.reasoning_content
        ? truncate(msg.reasoning_content, MAX_REASONING_CHARS)
        : undefined
      if (!text.trim() && !reasoning) continue
      messages.push({ role: 'assistant', text, ...(reasoning ? { reasoningSummary: reasoning } : {}) })
    }
    if (messages.length >= MAX_MESSAGES) break
  }

  let fileChanges: SessionSnapshotFileChange[] | undefined
  if (options.includeFileChanges) {
    const tree = await getWorkingTreeFiles(record.cwd, record.baselineHead ?? 'HEAD')
    fileChanges = []
    for (const file of tree.files.slice(0, MAX_FILES)) {
      let diff: string | undefined
      try {
        const raw = await getFileDiff(record.cwd, file.path, record.baselineHead ?? 'HEAD')
        if (raw.trim()) diff = truncate(raw, MAX_DIFF_CHARS)
      } catch { /* unreadable file → metadata only */ }
      fileChanges.push({
        path: file.path,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        ...(diff ? { diff } : {}),
      })
    }
  }

  const rawSnapshot: SessionSnapshot = {
    version: SNAPSHOT_VERSION,
    createdAt: Date.now(),
    meta: {
      title: record.title ?? record.id.slice(0, 8),
      ...(record.model ? { model: record.model } : {}),
    },
    messages,
    ...(fileChanges ? { fileChanges } : {}),
    redaction: { findings: 0, appliedAt: 0 },
  }

  const { value: snapshot, findings } = redactSnapshotValue(rawSnapshot)
  snapshot.redaction = { findings, appliedAt: Date.now() }
  return { snapshot, findings }
}
