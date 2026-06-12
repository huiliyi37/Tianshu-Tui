/**
 * Data model for the Worker Status Panel — analogous to team-panel-model.ts
 * but focused on individual worker delegation status and circuit breaker state.
 */

export type WorkerPanelStatus = 'queued' | 'running' | 'done' | 'failed' | 'circuit-open'

export interface WorkerStatusEntry {
  workerId: string
  profile: string
  status: WorkerPanelStatus
  /** Progress within the worker (e.g., "3/4 files"). */
  progress?: { current: number; total: number; label: string }
  /** Elapsed time in ms since worker started. */
  elapsed?: number
  /** Error message if status is 'failed'. */
  error?: string
  /** Brief result summary if status is 'done'. */
  resultSummary?: string
}

export interface CircuitSummary {
  profile: string
  state: 'closed' | 'open' | 'half-open'
  failureCount: number
  /** Seconds remaining until open→half-open transition (0 if not open). */
  cooldownRemainingS: number
}

export interface WorkerPanelModel {
  workers: WorkerStatusEntry[]
  circuits: CircuitSummary[]
  /** Whether any workers are currently active (used for auto-collapse). */
  hasActive: boolean
}

export function buildWorkerPanelModel(
  workers: WorkerStatusEntry[],
  circuits: CircuitSummary[],
): WorkerPanelModel {
  const hasActive = workers.some(w => w.status === 'queued' || w.status === 'running')
  return { workers, circuits, hasActive }
}

export function formatElapsed(ms: number | undefined): string {
  if (ms === undefined || ms < 0) return ''
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${s % 60}s`
}

export function progressBar(current: number, total: number, width = 8): string {
  if (total <= 0) return '░'.repeat(width)
  const filled = Math.min(width, Math.round((current / total) * width))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}
