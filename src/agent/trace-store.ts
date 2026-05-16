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
}

export type TraceEventStartInput = Pick<TraceEvent, 'id' | 'turn' | 'kind' | 'name' | 'startedAt' | 'summary'>

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

export function getDoomLoopLevel(fingerprints: string[]): DoomLoopLevel {
  const counts = new Map<string, number>()
  for (const fp of fingerprints) counts.set(fp, (counts.get(fp) ?? 0) + 1)
  const max = Math.max(0, ...counts.values())
  if (max >= 3) return 'blocked'
  if (max >= 2) return 'warn'
  return 'none'
}
