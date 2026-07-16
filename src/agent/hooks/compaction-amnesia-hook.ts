import { createHash } from 'node:crypto'
import type { PostToolRuntimeHook, RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'
import { isLossyObservation } from '../lossy-markers.js'

/**
 * W3-C1: compaction amnesia SHADOW ledger.
 *
 * After a history rewrite, the model may "forget" content it had already
 * observed and burn turns re-reading it. This hook detects the strongest
 * signal — a full re-read of a file whose content hash is UNCHANGED since it
 * was read before the compact — and records it as a shadow row.
 *
 * Shadow-only discipline: this hook NEVER injects anything into the prompt
 * and NEVER changes behavior. Rows feed offline analysis first; any future
 * gate/advisory must be justified by sampled precision (see plan Wave 3).
 *
 * Exclusions built into the signal:
 *   - content hash changed since the pre-compact read → legitimate re-read,
 *     not recorded;
 *   - prior observation was lossy (truncated/collapsed) → recorded with
 *     `exclusion: 'prior-lossy'` so offline analysis can discount it;
 *   - reads more than WINDOW_TURNS after the compact → out of scope.
 */

export interface AmnesiaShadowRow {
  event: 'amnesia_shadow'
  kind: 'full-reread'
  /** Compact generation (count of compact events when the row was recorded). */
  generation: number
  turn: number
  turnsSinceCompact: number
  target: string
  contentHash: string
  /** Set when the signal is probably legitimate — offline analysis discounts it. */
  exclusion?: 'prior-lossy'
}

export interface CompactionAmnesiaHookDeps {
  getCompactEvents: () => Array<{ turn: number }>
  record: (row: AmnesiaShadowRow) => void
}

/** Re-reads more than this many turns after a compact are out of scope. */
const WINDOW_TURNS = 10

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

/** Full read = no offset/limit narrowing in the input. */
function isFullRead(input: Record<string, unknown> | undefined): boolean {
  if (!input) return true
  return input['offset'] == null && input['limit'] == null
}

export function createCompactionAmnesiaHook(deps: CompactionAmnesiaHookDeps): PostToolRuntimeHook {
  /** Latest observation per file path. */
  const observed = new Map<string, { hash: string; lossy: boolean }>()
  /** Snapshot of `observed` taken at the last seen compact boundary. */
  let preCompact = new Map<string, { hash: string; lossy: boolean }>()
  let seenCompactCount = 0
  let lastCompactTurn = -1

  return {
    phase: 'postTool',
    name: 'compaction-amnesia',
    run(ctx: RuntimeHookContext, tool: RuntimeToolEvent): void {
      // Detect a new compact boundary: snapshot the observation map.
      const events = deps.getCompactEvents()
      if (events.length > seenCompactCount) {
        seenCompactCount = events.length
        lastCompactTurn = events[events.length - 1]!.turn
        preCompact = new Map(observed)
      }

      if (tool.name !== 'read_file' || !tool.success || !tool.resultContent) return
      const target = tool.target ?? (typeof tool.input?.['path'] === 'string' ? tool.input['path'] as string : undefined)
      if (!target) return

      const hash = hashContent(tool.resultContent)
      const lossy = isLossyObservation(tool.resultContent)

      // Amnesia check BEFORE updating the map (compare against prior state).
      if (
        seenCompactCount > 0 &&
        isFullRead(tool.input) &&
        ctx.snapshot.turn - lastCompactTurn >= 0 &&
        ctx.snapshot.turn - lastCompactTurn <= WINDOW_TURNS
      ) {
        const prior = preCompact.get(target)
        if (prior && prior.hash === hash) {
          deps.record({
            event: 'amnesia_shadow',
            kind: 'full-reread',
            generation: seenCompactCount,
            turn: ctx.snapshot.turn,
            turnsSinceCompact: ctx.snapshot.turn - lastCompactTurn,
            target,
            contentHash: hash,
            ...(prior.lossy ? { exclusion: 'prior-lossy' as const } : {}),
          })
          // Wave 4 控制面：失忆事实只进 silent（shadow 记账，绝不进 prompt）。
          // effects 可缺省（旧测试固件手工构造 ctx）——控制面上报是 best-effort。
          ctx.effects?.emitControlSignal?.({
            key: `compaction:amnesia:${target}`,
            kind: 'compaction',
            severity: 'info',
            summary: `post-compact full re-read of unchanged file ${target}${prior.lossy ? ' (prior-lossy, discounted)' : ''}`,
            requiresDecision: false,
            ttlTurns: 1,
            cacheImpact: 'none',
          })
        }
      }

      observed.set(target, { hash, lossy })
    },
  }
}

/** Offline consumer: aggregate shadow rows into a per-session summary. */
export function summarizeAmnesiaRows(rows: AmnesiaShadowRow[]): {
  total: number
  strongSignals: number
  excluded: number
  byTarget: Record<string, number>
} {
  const byTarget: Record<string, number> = {}
  let excluded = 0
  for (const row of rows) {
    if (row.exclusion) { excluded++; continue }
    byTarget[row.target] = (byTarget[row.target] ?? 0) + 1
  }
  return {
    total: rows.length,
    strongSignals: rows.length - excluded,
    excluded,
    byTarget,
  }
}
