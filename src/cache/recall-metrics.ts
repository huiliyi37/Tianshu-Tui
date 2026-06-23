/**
 * Observability for compact-history recall (layered-archival plan, phase 3).
 *
 * Records WHEN and HOW OFTEN the model recalls archived history via
 * read_section, and how far back (turn distance) the recalled block was.
 *
 * Deliberately observe-only: it does NOT feed back into compaction thresholds.
 * A high recall rate is ambiguous — it can mean "compacted too aggressively"
 * OR "the task legitimately needs to revisit early decisions" — so we collect
 * data first and defer any adaptive control until the data justifies it.
 */

export interface RecallObservation {
  artifactId: string
  recalledAtTurn: number
  /** currentTurn − archiveTurn, or null when the archive turn is unknown. */
  turnDistance: number | null
}

export interface RecallMetricsSummary {
  totalRecalls: number
  uniqueArtifacts: number
  avgTurnDistance: number | null
  maxTurnDistance: number | null
}

export class RecallMetrics {
  private readonly archiveTurn = new Map<string, number>()
  private readonly observations: RecallObservation[] = []

  /** Record the turn at which a compact-history artifact was created. */
  registerArchive(artifactId: string, turn: number): void {
    this.archiveTurn.set(artifactId, turn)
  }

  /** Record a recall (read_section) of a compact-history artifact. */
  recordRecall(artifactId: string, currentTurn: number): void {
    const archivedAt = this.archiveTurn.get(artifactId)
    this.observations.push({
      artifactId,
      recalledAtTurn: currentTurn,
      turnDistance: archivedAt !== undefined ? currentTurn - archivedAt : null,
    })
  }

  getObservations(): readonly RecallObservation[] {
    return this.observations
  }

  getSummary(): RecallMetricsSummary {
    const total = this.observations.length
    const unique = new Set(this.observations.map(o => o.artifactId)).size
    const distances = this.observations
      .map(o => o.turnDistance)
      .filter((d): d is number => d !== null)
    const avg = distances.length > 0
      ? distances.reduce((a, b) => a + b, 0) / distances.length
      : null
    const max = distances.length > 0 ? Math.max(...distances) : null
    return { totalRecalls: total, uniqueArtifacts: unique, avgTurnDistance: avg, maxTurnDistance: max }
  }
}
