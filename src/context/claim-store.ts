import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertValidSessionId } from '../validation.js'
import {
  createClaimFromProposal,
  isPromptEligibleClaim,
  type ClaimProposal,
  type ContextClaim,
  type ContextClaimStatus,
  type EvidenceRef,
} from './claims.js'
import { claimHasFileEvidence, countClaimsByStatus, evaluatePromotion, type ClaimStatusCounts } from './promotion.js'

export type ContextClaimEvent =
  | { type: 'claim_proposed'; eventId: string; createdAt: number; claim: ContextClaim }
  | { type: 'claim_status_changed'; eventId: string; createdAt: number; claimId: string; status: ContextClaimStatus; reason: string }
  | { type: 'claim_used'; eventId: string; createdAt: number; claimId: string; consumerId: string; consumerKind: 'prompt' | 'tool' | 'test' | 'worker' }

export interface ClaimFilter {
  status?: ContextClaimStatus[]
  kind?: ContextClaim['kind'][]
  scope?: ContextClaim['scope'][]
}

export interface ClaimUseInput {
  consumerId: string
  consumerKind: 'prompt' | 'tool' | 'test' | 'worker'
  usedAt: number
}

export class ContextClaimStore {
  readonly path: string

  readonly sessionId: string

  private cachedClaims: ContextClaim[] | null = null
  private lastProcessedLineCount: number = 0

  constructor(dir: string, sessionId: string) {
    assertValidSessionId(sessionId)
    this.sessionId = sessionId
    mkdirSync(dir, { recursive: true })
    this.path = join(dir, `${this.sessionId}.claims.jsonl`)
  }

  appendEvent(event: ContextClaimEvent): void {
    appendFileSync(this.path, JSON.stringify(event) + '\n', 'utf-8')
  }

  propose(proposal: ClaimProposal): ContextClaim {
    const claim = createClaimFromProposal(proposal)
    const existing = this.listClaims().find(current => current.id === claim.id)
    if (existing) return existing

    this.appendEvent({
      type: 'claim_proposed',
      eventId: `${proposal.source.eventId}:claim:${claim.id}`,
      createdAt: proposal.createdAt,
      claim,
    })
    return claim
  }

  updateClaimStatus(id: string, status: ContextClaimStatus, reason: string): ContextClaim | null {
    const current = this.listClaims().find(claim => claim.id === id)
    if (!current) return null

    this.appendEvent({
      type: 'claim_status_changed',
      eventId: `${id}:status:${status}:${Date.now()}`,
      createdAt: Date.now(),
      claimId: id,
      status,
      reason,
    })

    return this.listClaims().find(claim => claim.id === id) ?? null
  }

  recordClaimUsed(id: string, input: ClaimUseInput): ContextClaim | null {
    const current = this.listClaims().find(claim => claim.id === id)
    if (!current) return null

    this.appendEvent({
      type: 'claim_used',
      eventId: `${id}:used:${input.consumerId}:${input.usedAt}`,
      createdAt: input.usedAt,
      claimId: id,
      consumerId: input.consumerId,
      consumerKind: input.consumerKind,
    })

    return this.listClaims().find(claim => claim.id === id) ?? null
  }

  listClaims(filter: ClaimFilter = {}): ContextClaim[] {
    return this.projectClaims().filter(claim => {
      if (filter.status && !filter.status.includes(claim.status)) return false
      if (filter.kind && !filter.kind.includes(claim.kind)) return false
      if (filter.scope && !filter.scope.includes(claim.scope)) return false
      return true
    })
  }

  listActiveClaims(now = Date.now()): ContextClaim[] {
    return this.listClaims().filter(claim => isPromptEligibleClaim(claim, now))
  }

  listClaimsByFileEvidence(path: string): ContextClaim[] {
    return this.listClaims().filter(claim => claimHasFileEvidence(claim, path))
  }

  getStatusCounts(): ClaimStatusCounts {
    return countClaimsByStatus(this.listClaims())
  }

  markClaimsStaleForFile(path: string, reason: string): ContextClaim[] {
    const changed: ContextClaim[] = []
    for (const claim of this.listClaimsByFileEvidence(path)) {
      if (claim.status === 'stale' || claim.status === 'quarantined') continue
      const updated = this.updateClaimStatus(claim.id, 'stale', reason)
      if (updated) changed.push(updated)
    }
    return changed
  }

  promoteEligibleClaims(now = Date.now()): ContextClaim[] {
    const promoted: ContextClaim[] = []
    for (const claim of this.listClaims()) {
      const next = evaluatePromotion(claim, now)
      if (!next) continue
      const updated = this.updateClaimStatus(claim.id, next, 'promotion threshold met')
      if (updated) promoted.push(updated)
    }
    return promoted
  }

  exportSession(): string {
    if (!existsSync(this.path)) return ''
    return readFileSync(this.path, 'utf-8')
  }

  private readEvents(): ContextClaimEvent[] {
    if (!existsSync(this.path)) return []
    return readFileSync(this.path, 'utf-8')
      .split('\n')
      .filter(line => line.trim().length > 0)
      .flatMap(line => {
        try {
          return [JSON.parse(line) as ContextClaimEvent]
        } catch {
          return []
        }
      })
  }

  private projectClaims(): ContextClaim[] {
    const events = this.readEvents()

    if (this.cachedClaims && this.lastProcessedLineCount === events.length) {
      return this.cachedClaims
    }

    if (this.cachedClaims && this.lastProcessedLineCount < events.length) {
      const newEvents = events.slice(this.lastProcessedLineCount)
      const map = new Map(this.cachedClaims.map(c => [c.id, c]))
      this.applyEventsToMap(map, newEvents)
      this.cachedClaims = [...map.values()]
      this.lastProcessedLineCount = events.length
      return this.cachedClaims
    }

    const claims = new Map<string, ContextClaim>()
    this.applyEventsToMap(claims, events)
    this.cachedClaims = [...claims.values()]
    this.lastProcessedLineCount = events.length
    return this.cachedClaims
  }

  private applyEventsToMap(claims: Map<string, ContextClaim>, events: ContextClaimEvent[]): void {
    for (const event of events) {
      if (event.type === 'claim_proposed') {
        if (!claims.has(event.claim.id)) {
          claims.set(event.claim.id, event.claim)
        }
        continue
      }

      if (event.type === 'claim_status_changed') {
        const claim = claims.get(event.claimId)
        if (!claim) continue
        const counterevidence: EvidenceRef[] = event.status === 'active'
          ? claim.counterevidence
          : [...claim.counterevidence, {
              id: event.eventId,
              kind: 'tool_result',
              summary: event.reason,
              createdAt: event.createdAt,
            }]
        claims.set(event.claimId, { ...claim, status: event.status, counterevidence })
        continue
      }

      const claim = claims.get(event.claimId)
      if (!claim) continue
      claims.set(event.claimId, {
        ...claim,
        lastUsedAt: event.createdAt,
        consumers: [...claim.consumers, {
          id: event.consumerId,
          kind: event.consumerKind,
          usedAt: event.createdAt,
        }],
      })
    }
  }
}
