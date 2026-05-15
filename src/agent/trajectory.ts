export interface TrajectoryEntry {
  turn: number
  tool: string
  target: string
  durationMs: number
  status: 'success' | 'failed' | 'retried-success' | 'retried-failed'
  errorClass?: string
  inputSummary: string
  resultSummary: string
}

export class TrajectoryRecorder {
  private entries: TrajectoryEntry[] = []

  record(entry: TrajectoryEntry): void {
    this.entries.push(entry)
  }

  getEntries(): TrajectoryEntry[] {
    return this.entries
  }

  summarize(): { totalTools: number; failures: number; retries: number; avgDurationMs: number } {
    const total = this.entries.length
    const failures = this.entries.filter(e => e.status === 'failed' || e.status === 'retried-failed').length
    const retries = this.entries.filter(e => e.status.startsWith('retried')).length
    const avgDurationMs = total > 0 ? Math.round(this.entries.reduce((s, e) => s + e.durationMs, 0) / total) : 0
    return { totalTools: total, failures, retries, avgDurationMs }
  }

  exportJson(): string {
    return JSON.stringify(this.entries)
  }

  reset(): void {
    this.entries = []
  }
}
