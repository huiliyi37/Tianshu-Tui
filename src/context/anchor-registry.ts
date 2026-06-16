import type { ContextAnchor } from './types.js'

const CONSTRAINT_PATTERNS = [
  /不要|不能|禁止|必须|一定要|always|never|don'?t|must|do not/i,
]

const IMPERATIVE_USE_RE = /(?:^|\.\s+)(?:please\s+)?use\s+\w+/im

function estimateAnchorTokens(text: string): number {
  return Math.ceil(text.length / 3)
}

function scoreSalience(text: string, round: number): number {
  let score = 1
  if (/CRITICAL|IMPORTANT|重要|关键/i.test(text)) score += 3
  if (CONSTRAINT_PATTERNS.some(pattern => pattern.test(text))) score += 2
  score += Math.max(0, 5 - Math.floor(round / 10))
  return score
}

export class AnchorRegistry {
  private anchors: ContextAnchor[] = []

  constructor(private budgetTokens: number) {}

  processUserMessage(text: string, round: number): void {
    const hasConstraint = CONSTRAINT_PATTERNS.some(pattern => pattern.test(text))
      || IMPERATIVE_USE_RE.test(text)
    if (!hasConstraint) return
    this.addAnchor({
      kind: 'user_constraint',
      text: text.slice(0, 200),
      sourceRoundIndex: round,
      salience: scoreSalience(text, round),
    })
  }

  getAnchors(): ContextAnchor[] {
    return [...this.anchors]
  }

  estimateTokens(): number {
    return this.anchors.reduce((sum, anchor) => sum + estimateAnchorTokens(anchor.text), 0)
  }

  private addAnchor(anchor: ContextAnchor): void {
    this.anchors = [...this.anchors, anchor]
    this.enforceBudget()
  }

  private enforceBudget(): void {
    while (this.estimateTokens() > this.budgetTokens && this.anchors.length > 1) {
      let minIndex = 0
      let minSalience = Infinity
      for (let index = 0; index < this.anchors.length; index++) {
        const anchor = this.anchors[index]
        if (anchor && anchor.salience < minSalience) {
          minSalience = anchor.salience
          minIndex = index
        }
      }
      this.anchors = [...this.anchors.slice(0, minIndex), ...this.anchors.slice(minIndex + 1)]
    }
  }
}
