import { existsSync, readFileSync } from 'node:fs'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { SessionMemoryEntry, SessionMemoryState } from './types.js'
import { assertValidSessionId } from '../validation.js'

function memoryPath(dir: string, sessionId: string): string {
  assertValidSessionId(sessionId)
  return join(dir, `${sessionId}.memory.json`)
}

function idFor(input: { text: string; createdAt: number; source: SessionMemoryEntry['source'] }): string {
  return createHash('sha256').update(`${input.createdAt}:${input.source}:${input.text}`).digest('hex').slice(0, 12)
}

export function loadSessionMemory(dir: string, sessionId: string): SessionMemoryState {
  const filePath = memoryPath(dir, sessionId)
  if (!existsSync(filePath)) return { sessionId, entries: [] }
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as SessionMemoryState
  } catch {
    return { sessionId, entries: [] }
  }
}

export function appendSessionMemory(
  dir: string,
  sessionId: string,
  input: { text: string; source: SessionMemoryEntry['source']; createdAt: number },
): SessionMemoryState {
  const state = loadSessionMemory(dir, sessionId)
  const duplicate = state.entries.some(entry => entry.text === input.text && entry.source === input.source)
  if (duplicate) return state

  const entry: SessionMemoryEntry = { id: idFor(input), ...input }
  const next: SessionMemoryState = { sessionId, entries: [...state.entries, entry].slice(-50) }
  writeFileAtomicSync(memoryPath(dir, sessionId), JSON.stringify(next, null, 2) + '\n')
  return next
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function buildSessionMemoryBlock(state: SessionMemoryState): string {
  if (state.entries.length === 0) return ''
  const entries = state.entries.map(entry => (
    `<entry id="${entry.id}" created_at="${entry.createdAt}" source="${entry.source}">${escapeXml(entry.text)}</entry>`
  ))
  return `<session-memory session_id="${state.sessionId}">\n${entries.join('\n')}\n</session-memory>`
}
