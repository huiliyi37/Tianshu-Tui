const HIGH_FREQ_VERBS = new Set([
  '修复', '实现', '优化', '设计', '重构', '验证', '测试', '修改', '更新', '解决', '查看',
  'fix', 'solve', 'implement', 'design', 'optimize', 'refactor', 'verify', 'test', 'update',
  'add', 'remove', 'setup', 'configure', 'check', 'audit', 'review'
])

function tokenize(text: string): string[] {
  const matches = text.match(/[\u4e00-\u9fa5]|\b[a-zA-Z_][a-zA-Z0-9_]*\b/g) ?? []
  return matches.map(m => m.toLowerCase())
}

export class ProjectionScorer {
  /**
   * Score how much output is a "projection" of anchor phrases.
   * Uses occurrence-weighted overlap. Returns 0.0–1.0.
   * < 0.3 = independent thinking. > 0.3 = anchor-dominated.
   */
  score(output: string, anchorPhrases: string[]): number {
    if (!output || !anchorPhrases.length) return 0

    const filteredPhrases = anchorPhrases
      .map(p => p.toLowerCase())
      .filter(p => !HIGH_FREQ_VERBS.has(p))

    if (filteredPhrases.length === 0) return 0

    const outputTokens = tokenize(output)
    if (outputTokens.length === 0) return 0

    let matchedTokens = 0
    for (const token of outputTokens) {
      for (const phrase of filteredPhrases) {
        if (token === phrase || token.includes(phrase) || phrase.includes(token)) {
          matchedTokens++
          break
        }
      }
    }
    return Math.min(1, matchedTokens / outputTokens.length)
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
