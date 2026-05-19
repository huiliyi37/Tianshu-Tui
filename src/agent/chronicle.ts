import { PHASE_LABELS, PHASE_GLYPHS, type StarPhase } from './star-event.js'

// ─── Types ──────────────────────────────────────────────────────────────

export interface ChronicleEntry {
  type: 'phase-transition' | 'milestone' | 'radio'
  turn: number
  timestamp: number
  summary: string
  phase?: StarPhase
  files?: string[]
}

export interface PhaseSegment {
  phase: StarPhase
  startTurn: number
  startTimestamp: number
  endTurn?: number
  endTimestamp?: number
  entries: ChronicleEntry[]
}

// ─── Chronicle ──────────────────────────────────────────────────────────

/**
 * Collects events (phase transitions, milestones, radio messages) during
 * agent execution. Provides structured access for the starmap, chronicle
 * view, and session markdown export.
 */
export class Chronicle {
  private readonly entries: ChronicleEntry[] = []
  private currentPhase: StarPhase | undefined

  /**
   * Record a phase change.
   */
  addPhaseTransition({
    fromPhase: _fromPhase,
    toPhase,
    turn,
    summary,
  }: {
    fromPhase: StarPhase
    toPhase: StarPhase
    turn: number
    summary: string
  }): void {
    this.currentPhase = toPhase
    this.entries.push({
      type: 'phase-transition',
      turn,
      timestamp: Date.now(),
      summary,
      phase: toPhase,
    })
  }

  /**
   * Record a milestone (test pass/fail, error, etc.).
   */
  addMilestone({
    kind: _kind,
    turn,
    summary,
    files,
  }: {
    kind: string
    turn: number
    summary: string
    files?: string[]
  }): void {
    this.entries.push({
      type: 'milestone',
      turn,
      timestamp: Date.now(),
      summary,
      phase: this.currentPhase,
      files,
    })
  }

  /**
   * Record a [天枢] radio message.
   */
  addRadio(message: string, turn: number): void {
    this.entries.push({
      type: 'radio',
      turn,
      timestamp: Date.now(),
      summary: message,
      phase: this.currentPhase,
    })
  }

  /**
   * Return all recorded entries (readonly snapshot).
   */
  getEntries(): readonly ChronicleEntry[] {
    return this.entries
  }

  /**
   * Return the last `count` radio messages, newest first.
   */
  getRecentRadio(count: number): readonly ChronicleEntry[] {
    return this.entries
      .filter((e) => e.type === 'radio')
      .slice(-count)
  }

  /**
   * Group entries into phase segments.
   *
   * A new segment is created each time a phase-transition entry is
   * recorded. Non-transition entries (radio, milestone) are appended
   * to the current segment.
   */
  getPhaseSegments(): PhaseSegment[] {
    const segments: PhaseSegment[] = []
    let current: PhaseSegment | undefined

    for (const entry of this.entries) {
      if (entry.type === 'phase-transition') {
        // Close the previous segment
        if (current) {
          current.endTurn = entry.turn
          current.endTimestamp = entry.timestamp
        }
        // Start a new segment
        current = {
          phase: entry.phase!,
          startTurn: entry.turn,
          startTimestamp: entry.timestamp,
          entries: [],
        }
        segments.push(current)
        continue
      }

      // Non-transition entries go into the current segment
      if (current) {
        current.entries.push(entry)
      }
    }

    return segments
  }

  /**
   * Render the chronicle as structured markdown.
   *
   * Output format:
   * ```
   * # 星辰编年史
   *
   * ## ⭐ 天枢 · 观局授策  [Turn 0 – 5]
   *
   * - [Turn 3] [天枢] writing
   * ```
   */
  toMarkdown(): string {
    const lines: string[] = ['# 星辰编年史', '']

    for (const segment of this.getPhaseSegments()) {
      const glyph = PHASE_GLYPHS[segment.phase]
      const label = PHASE_LABELS[segment.phase]
      const turnRange = segment.endTurn != null
        ? `[Turn ${segment.startTurn} – ${segment.endTurn}]`
        : `[Turn ${segment.startTurn}]`
      lines.push(`## ${glyph} ${label}  ${turnRange}`, '')

      for (const entry of segment.entries) {
        if (entry.type === 'phase-transition') {
          const from = PHASE_LABELS[entry.phase!] ?? entry.phase
          lines.push(`- [Turn ${entry.turn}] **${from}** — ${entry.summary}`)
        } else if (entry.type === 'milestone') {
          const filesStr = entry.files?.length ? ` (${entry.files.join(', ')})` : ''
          lines.push(`- [Turn ${entry.turn}] ${entry.summary}${filesStr}`)
        } else {
          lines.push(`- [Turn ${entry.turn}] ${entry.summary}`)
        }
      }

      lines.push('')
    }

    return lines.join('\n')
  }
}
