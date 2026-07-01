/**
 * Map an agent phase to a human-readable status label for the heartbeat line.
 * Returns null for phases that should not override the current status.
 *
 * IMPORTANT: every phase emitted by loop.ts via onPhaseChange must be handled
 * here or explicitly documented as intentionally ignored. Currently handled:
 * - heartbeat (loop.ts heartbeat timer)
 * - intent-veto (loop.ts intent evaluation)
 * - preparing (loop.ts pre-stream chain)
 * - working (loop.ts stream start)
 * - tool-hint (loop.ts tool call hint)
 * - stop-reason (loop.ts / turn-orchestrator — why the turn loop ended)
 */
export function phaseStatusLabel(
  phase: string,
  detail?: { tool?: string; reason?: string; suggestion?: string },
): string | null {
  switch (phase) {
    case 'heartbeat': return detail?.reason ?? 'still working'
    case 'intent-veto': return detail?.reason ?? 'intent vetoed'
    case 'preparing': return 'preparing…'
    case 'working': return detail?.reason ?? 'working…'
    case 'tool-hint': return detail?.tool ? `preparing ${detail.tool}…` : 'preparing…'
    case 'stop-reason': return detail?.reason ?? null
    default: return null
  }
}
