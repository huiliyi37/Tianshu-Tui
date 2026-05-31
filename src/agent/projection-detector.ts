import { AnchorVault, type SealedAnchor } from './anchor-vault.js'
import { ProjectionScorer } from './projection-scorer.js'

export interface ProjectionDetectorOpts {
  threshold?: number
}

export interface ProjectionWarning {
  score: number
  threshold: number
  message: string
}

/**
 * Projection Detector — detects when model output is anchor-dominated.
 *
 * Usage: create once per session, call `check()` after each turn.
 * Seals the user's first message as the anchor, then scores subsequent
 * outputs against it.
 */
export class ProjectionDetector {
  private vault = new AnchorVault()
  private scorer = new ProjectionScorer()
  private sealed: SealedAnchor | null = null
  private threshold: number

  constructor(opts: ProjectionDetectorOpts = {}) {
    this.threshold = opts.threshold ?? 0.3
  }

  /** Seal the task anchor (call once with the user's initial message). */
  sealAnchor(userMessage: string): void {
    this.sealed = this.vault.seal(userMessage)
  }

  /** Check if output is anchor-dominated. Returns warning or null. */
  check(output: string): ProjectionWarning | null {
    if (!this.sealed || !output) return null
    const score = this.scorer.score(output, this.sealed.phrases)
    if (score <= this.threshold) return null
    return {
      score,
      threshold: this.threshold,
      message: `[anti-anchor] projection ${score.toFixed(2)} > ${this.threshold}. Output may be anchor-dominated.`,
    }
  }

  /** Run deletion test on a completed plan. */
  deletionTest(plan: string): boolean {
    if (!this.sealed) return false
    return this.scorer.deletionTest(plan, this.sealed.phrases)
  }

  get anchor(): SealedAnchor | null {
    return this.sealed
  }
}
