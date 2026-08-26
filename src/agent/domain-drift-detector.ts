import { DOMAIN_AUTO_POOL, type StarDomainId } from './star-domain.js'
import { starDomainRegistry } from './star-domain-registry.js'

export interface DomainDriftResult {
  recommendedId: StarDomainId
  recommendedName: string
  currentId: StarDomainId
  currentName: string
  matchedKeywords: string[]
}

/**
 * Tracks intent drift for one Auto-resolved session. Detection is
 * observational only: it never changes the active domain or prompt state.
 */
export class DomainDriftDetector {
  private readonly suggested = new Set<string>()

  constructor(private readonly currentDomainId: StarDomainId) {}

  /**
   * Suggest immediately when another Auto-pool domain uniquely wins with at
   * least one keyword. Repeated suggestions for the same direction are muted.
   */
  evaluate(userMessage: string): DomainDriftResult | null {
    const detail = starDomainRegistry.matchDomainDetailed(userMessage, DOMAIN_AUTO_POOL)

    if (
      detail.verdict !== 'hit' ||
      detail.id === null ||
      detail.id === this.currentDomainId ||
      detail.matchedKeywords.length < 1
    ) {
      return null
    }

    const matchedId = detail.id as StarDomainId
    const suggestionKey = `${this.currentDomainId}->${matchedId}`
    if (this.suggested.has(suggestionKey)) return null

    const recommended = starDomainRegistry.get(matchedId)
    const current = starDomainRegistry.get(this.currentDomainId)
    if (!recommended || !current) return null

    this.suggested.add(suggestionKey)
    return {
      recommendedId: matchedId,
      recommendedName: recommended.name,
      currentId: this.currentDomainId,
      currentName: current.name,
      matchedKeywords: detail.matchedKeywords.slice(0, 4),
    }
  }
}
