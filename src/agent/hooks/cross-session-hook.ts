import { isAbsolute, resolve } from 'node:path'
import type { EventRecord } from '../session-registry.js'
import { invalidateReadHistory } from '../../tools/read-file.js'

export interface CrossSessionHookDeps {
  consumeEvents: (sessionId: string, afterId: number) => EventRecord[]
  sessionId: string
  setCrossSessionAppendix: (content: string) => void
  getLastSeenEventId: () => number
  setLastSeenEventId: (id: number) => void
  /** Workspace root — enables read-cache invalidation for file_changed events
   *  (relative event paths are resolved against it). */
  cwd?: string
}

/**
 * Drop this process's read-dedup records for files another session reports as
 * changed (`file_changed` events from stigmergy-hook). Aligns the read cache
 * with the file-level concurrency ownership semantics: once a peer session's
 * exclusive-claim edit lands, "already read and unchanged" must never be
 * answered from pre-edit state — the next read_file does a real read.
 * Passive mtime+size staleness checks remain the backstop; this is the
 * proactive path.
 */
export function invalidateReadCachesForEvents(events: readonly EventRecord[], cwd: string): void {
  for (const e of events) {
    if (e.eventType !== 'file_changed' || !e.filePath) continue
    const canonical = isAbsolute(e.filePath) ? e.filePath : resolve(cwd, e.filePath)
    invalidateReadHistory(canonical)
  }
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

    // B2: workspace_mutation events get enriched advisory text so the LLM
    // knows why files may appear changed/missing and what NOT to do.
    if (e.eventType === 'workspace_mutation') {
      const detail = formatWorkspaceMutationDetail(e.detail)
      return `  ${prefix} workspace_mutation${file}: ${detail}`
    }

    return `  ${prefix} ${e.eventType}${file}: ${e.detail ?? 'no detail'}`
  })

  return `<cross-session-events>\n${lines.join('\n')}\n</cross-session-events>`
}

/**
 * Parse workspace_mutation detail JSON into a human-readable advisory.
 * Returns the raw detail string if parsing fails (degraded but not silent).
 */
function formatWorkspaceMutationDetail(detail: string | null): string {
  if (!detail) return 'workspace mutation (no detail)'
  try {
    const parsed = JSON.parse(detail) as { kind?: string; sessionId?: string }
    const kind = parsed.kind ?? 'unknown'
    const session = parsed.sessionId ? `session ${parsed.sessionId.slice(-8)}` : 'another session'
    switch (kind) {
      case 'stash':
        return `${session} stashed the working tree — your uncommitted changes may temporarily disappear. Do NOT re-edit or revert; wait for stash_pop.`
      case 'stash_pop':
        return `${session} restored stashed changes (stash_pop). Working tree is back to pre-stash state.`
      case 'reset':
        return `${session} performed git reset. Some tracked changes may have been discarded.`
      case 'checkout':
        return `${session} performed git checkout -- <files>. Affected files were reverted to HEAD.`
      case 'restore':
        return `${session} performed git restore. Affected files were reverted.`
      case 'clean':
        return `${session} performed git clean. Untracked files may have been removed.`
      default:
        return `${session} performed ${kind} — working tree was modified.`
    }
  } catch {
    return detail
  }
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
        if (deps.cwd) invalidateReadCachesForEvents(events, deps.cwd)
      }
    },
  }
}
