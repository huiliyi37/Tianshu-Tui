import { createHash } from 'node:crypto'

export type TraceEventKind = 'model' | 'tool' | 'verification' | 'checkpoint' | 'cache'
export type TraceEventStatus = 'running' | 'passed' | 'failed' | 'blocked'
export type DoomLoopLevel = 'none' | 'warn' | 'blocked'

export interface TraceEvent {
  id: string
  turn: number
  kind: TraceEventKind
  name: string
  status: TraceEventStatus
  startedAt: number
  endedAt?: number
  durationMs?: number
  summary?: string
  rawPath?: string
  predictedSuccess?: boolean
}

export type TraceEventStartInput = Pick<TraceEvent, 'id' | 'turn' | 'kind' | 'name' | 'startedAt' | 'summary' | 'predictedSuccess'>

export interface TraceStore {
  maxEvents: number
  events: TraceEvent[]
  toolFingerprints: string[]
}

export function createTraceStore(maxEvents = 50): TraceStore {
  return { maxEvents, events: [], toolFingerprints: [] }
}

function capEvents(store: TraceStore, events: TraceEvent[]): TraceEvent[] {
  return events.slice(-store.maxEvents)
}

export function recordTraceEvent(store: TraceStore, event: TraceEvent): TraceStore {
  return { ...store, events: capEvents(store, [...store.events, event]) }
}

export function startTraceEvent(
  store: TraceStore,
  input: TraceEventStartInput,
): TraceStore {
  return recordTraceEvent(store, { ...input, status: 'running' })
}

export function finishTraceEvent(
  store: TraceStore,
  id: string,
  update: { status: TraceEventStatus; endedAt: number; summary?: string; rawPath?: string },
): TraceStore {
  const events = store.events.map(event => {
    if (event.id !== id) return event
    return {
      ...event,
      ...update,
      durationMs: Math.max(0, update.endedAt - event.startedAt),
    }
  })
  return { ...store, events }
}

function sortedStringify(obj: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(obj).sort()) {
    const val = obj[key]
    sorted[key] = val && typeof val === 'object' && !Array.isArray(val)
      ? JSON.parse(sortedStringify(val as Record<string, unknown>))
      : val
  }
  return JSON.stringify(sorted)
}

export function fingerprintToolCall(
  name: string,
  input: Record<string, unknown>,
  outputClass: string,
): string {
  const payload = sortedStringify({ name, input, outputClass })
  return createHash('sha256').update(payload).digest('hex').slice(0, 16)
}

export function recordToolFingerprint(store: TraceStore, fingerprint: string): TraceStore {
  return { ...store, toolFingerprints: [...store.toolFingerprints, fingerprint].slice(-20) }
}

/**
 * Detects doom loops using a dual-strategy approach:
 * 1. Consecutive repeats: tight-loop pattern where the same tool is called back-to-back.
 *    Threshold: 3 consecutive (4th identical call) → blocked, 1 consecutive → warn.
 * 2. Sliding-window frequency: oscillation pattern (A→B→A→B→A) where a tool
 *    dominates the recent window even if not consecutive.
 *    Threshold: 6/8 → blocked, 4/8 → warn.
 *
 * This is less sensitive than the old global-count approach which flagged
 * normal iteration (typecheck→edit→typecheck→edit→typecheck) as blocked at 3 occurrences.
 */
export function getDoomLoopLevel(fingerprints: string[]): DoomLoopLevel {
  const WINDOW = 8
  const recent = fingerprints.slice(-WINDOW)

  // Strategy 1: consecutive repeats
  let maxConsecutive = 0
  let currentConsecutive = 0
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] === recent[i! - 1]) {
      currentConsecutive++
    } else {
      currentConsecutive = 0
    }
    maxConsecutive = Math.max(maxConsecutive, currentConsecutive)
  }

  // Strategy 2: sliding-window frequency
  const counts = new Map<string, number>()
  for (const fp of recent) counts.set(fp, (counts.get(fp) ?? 0) + 1)
  const maxCount = Math.max(0, ...counts.values())

  // Blocked: 3+ consecutive identical (4th same call) OR 6+ out of 8 window
  if (maxConsecutive >= 3 || maxCount >= 6) return 'blocked'
  // Warn: 1+ consecutive identical (2nd same call) OR 4+ out of 8 window
  if (maxConsecutive >= 1 || maxCount >= 4) return 'warn'
  return 'none'
}
