import type { EventRecord } from '../session-registry.js'

export interface CrossSessionHookDeps {
  consumeEvents: (sessionId: string, afterId: number) => EventRecord[]
  sessionId: string
  setCrossSessionAppendix: (content: string) => void
  getLastSeenEventId: () => number
  setLastSeenEventId: (id: number) => void
}

/**
 * Format cross-session events into a dynamic appendix block.
 * Returns empty string if no events.
 */
export function formatEventsForAppendix(events: EventRecord[]): string {
  if (events.length === 0) return ''

  // Sort high-priority events first for LLM attention
  const sorted = [...events].sort((a, b) => b.priority - a.priority)
  const lines = sorted.map(e => {
    const prefix = e.priority >= 1 ? '[ALERT]' : '[info]'
    const file = e.filePath ? ` ${e.filePath}` : ''
    return `  ${prefix} ${e.eventType}${file}: ${e.detail ?? 'no detail'}`
  })

  return `<cross-session-events>\n${lines.join('\n')}\n</cross-session-events>`
}

/**
 * Create a preTurn hook that reads cross-session events from SQLite
 * and injects them into the dynamic appendix (cache-safe).
 */
export function createCrossSessionHook(deps: CrossSessionHookDeps) {
  return {
    name: 'cross-session-sync',
    run(): void {
      const lastSeen = deps.getLastSeenEventId()
      const events = deps.consumeEvents(deps.sessionId, lastSeen)

      if (events.length > 0) {
        const maxId = Math.max(...events.map(e => e.id))
        deps.setLastSeenEventId(maxId)
        deps.setCrossSessionAppendix(formatEventsForAppendix(events))
      }
    },
  }
}
