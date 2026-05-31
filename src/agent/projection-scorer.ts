export class ProjectionScorer {
  /**
   * Score how much output is a "projection" of anchor phrases.
   * Uses occurrence-weighted overlap. Returns 0.0–1.0.
   * < 0.3 = independent thinking. > 0.3 = anchor-dominated.
   */
  score(output: string, anchorPhrases: string[]): number {
    if (!output || !anchorPhrases.length) return 0
    const outputLower = output.toLowerCase()
    const outputLen = outputLower.length || 1
    let totalOverlap = 0
    for (const phrase of anchorPhrases) {
      const p = phrase.toLowerCase()
      let idx = 0
      while ((idx = outputLower.indexOf(p, idx)) !== -1) {
        totalOverlap += p.length
        idx += p.length
      }
    }
    return Math.min(1, totalOverlap / outputLen)
  }

  /**
   * Deletion test: remove anchor phrases from plan.
   * If remaining text < 50% of original, the plan collapses without the anchor.
   */
  deletionTest(plan: string, anchorPhrases: string[]): boolean {
    let stripped = plan
    for (const phrase of anchorPhrases) {
      stripped = stripped.replaceAll(new RegExp(phrase, 'gi'), '')
    }
    stripped = stripped.replace(/ {2,}/g, ' ').trim()
    return stripped.length < plan.length * 0.5
  }
}
