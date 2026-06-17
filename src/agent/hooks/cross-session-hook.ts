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
 * Format active cross-session file claims into a dynamic appendix block so the
 * LLM can proactively avoid editing files another live session holds (P2b
 * conflict avoidance). Returns empty string if no claims.
 *
 * Previously the producer grouped claims into lines and then discarded them —
 * the signal was computed but never injected. This helper closes that gap and
 * is independently unit-testable (the producer wiring is integration-heavy).
 */
export function renderCrossSessionClaims(
  claims: Array<{ sessionId: string; filePath: string; claimType: string }>,
): string {
  if (claims.length === 0) return ''

  const grouped = new Map<string, string[]>()
  for (const c of claims) {
    if (!grouped.has(c.filePath)) grouped.set(c.filePath, [])
    grouped.get(c.filePath)!.push(`${c.sessionId}(${c.claimType})`)
  }
  const lines = [...grouped.entries()].map(
    ([file, holders]) => `  ${file} — claimed by ${holders.join(', ')}`,
  )

  return `<cross-session-claims note="Other live sessions hold these files. Coordinate or avoid editing to prevent conflicts.">\n${lines.join('\n')}\n</cross-session-claims>`
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
