import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { writeFileAtomicSync } from '../fs-atomic.js'

export interface CompanionPresenceEntry {
  sessionId: string
  starDomain: string
  objective: string
  updatedAt: number
  cognitiveState?: {
    vigor: number
    stability: number
    season: string
  }
}

const PRESENCE_TTL_MS = 5 * 60_000 // 5 minutes

function presencePath(cwd: string): string {
  return join(cwd, '.rivet', 'presence.json')
}

function isAlive(entry: CompanionPresenceEntry, now: number): boolean {
  return now - entry.updatedAt < PRESENCE_TTL_MS
}

export function loadPresence(cwd: string, excludeSessionId?: string): CompanionPresenceEntry[] {
  const filePath = presencePath(cwd)
  if (!existsSync(filePath)) return []
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const entries: CompanionPresenceEntry[] = JSON.parse(raw)
    if (!Array.isArray(entries)) return []
    const now = Date.now()
    return entries
      .filter(e => isAlive(e, now))
      .filter(e => e.sessionId !== excludeSessionId)
  } catch {
    return []
  }
}

export function writePresence(cwd: string, entry: CompanionPresenceEntry): void {
  const filePath = presencePath(cwd)
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })

  const now = Date.now()
  const existing = loadPresenceAll(filePath, now)
  const idx = existing.findIndex(e => e.sessionId === entry.sessionId)
  if (idx >= 0) {
    existing[idx] = entry
  } else {
    existing.push(entry)
  }
  writeFileAtomicSync(filePath, JSON.stringify(existing, null, 2))
}

function loadPresenceAll(filePath: string, now: number): CompanionPresenceEntry[] {
  if (!existsSync(filePath)) return []
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const entries: CompanionPresenceEntry[] = JSON.parse(raw)
    if (!Array.isArray(entries)) return []
    return entries.filter(e => isAlive(e, now))
  } catch {
    return []
  }
}

export function formatPresenceForAppendix(entries: CompanionPresenceEntry[]): string {
  if (entries.length === 0) return ''
  const now = Date.now()
  const lines = entries.map(e => {
    const ago = Math.round((now - e.updatedAt) / 60_000)
    const agoText = ago < 1 ? '刚刚' : `${ago} 分钟前`
    const stability = e.cognitiveState ? ` · stability ${e.cognitiveState.stability.toFixed(2)}` : ''
    const season = e.cognitiveState?.season ? ` · ${e.cognitiveState.season}` : ''
    return `  <m>${e.starDomain}域${stability}${season} · "${e.objective}" · ${agoText}</m>`
  })
  return `<companion-presence>\n${lines.join('\n')}\n</companion-presence>`
}
