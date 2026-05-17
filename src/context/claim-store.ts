import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
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

const MAX_CONSUMERS_PER_CLAIM = 50
const MAX_ACTIVE_CLAIMS = 50

export type ContextClaimEvent =
  | { type: 'claim_proposed'; eventId: string; createdAt: number; claim: ContextClaim }
  | { type: 'claim_status_changed'; eventId: string; createdAt: number; claimId: string; status: ContextClaimStatus; reason: string }
  | { type: 'claim_used'; eventId: string; createdAt: number; claimId: string; consumerId: string; consumerKind: 'prompt' | 'tool' | 'test' | 'worker' }
  | { type: 'claim_boosted'; eventId: string; createdAt: number; claimId: string; fitness: number }

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

  private cachedEvents: ContextClaimEvent[] | null = null
  private lastFileSize: number = -1
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
    if (this.cachedEvents) {
      this.cachedEvents.push(event)
      this.lastFileSize += Buffer.byteLength(JSON.stringify(event) + '\n')
    }
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
    // Evict excess active claims after proposing new one
    this.evictExcessActiveClaims()
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

  boostFitness(id: string, delta: number, cap: number): ContextClaim | null {
    const claim = this.listClaims().find(c => c.id === id)
    if (!claim) return null
    const newFitness = Math.min(claim.fitness + delta, cap)
    this.appendEvent({
      type: 'claim_boosted',
      eventId: `${id}:boost:${Date.now()}`,
      createdAt: Date.now(),
      claimId: id,
      fitness: newFitness,
    })
    return { ...claim, fitness: newFitness }
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
    // Evict excess active claims (cap at MAX_ACTIVE_CLAIMS)
    this.evictExcessActiveClaims()
    return promoted
  }

  private evictExcessActiveClaims(): void {
    // Only evict active/durable_candidate — durable claims are terminal and must not be evicted
    const evictable = this.listActiveClaims().filter(c => c.status !== 'durable')
    if (evictable.length <= MAX_ACTIVE_CLAIMS) return
    // Evict oldest (lowest createdAt) excess claims
    const toEvict = [...evictable]
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, evictable.length - MAX_ACTIVE_CLAIMS)
    for (const claim of toEvict) {
      this.updateClaimStatus(claim.id, 'stale', 'evicted-overflow')
    }
  }

  exportSession(): string {
    if (!existsSync(this.path)) return ''
    return readFileSync(this.path, 'utf-8')
  }

  static loadDurableClaims(dir: string, sessionId: string): ContextClaim[] {
    const filePath = join(dir, `${sessionId}.claims.jsonl`)
    if (!existsSync(filePath)) return []
    const lines = readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim().length > 0)
    const claims = new Map<string, ContextClaim>()
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as ContextClaimEvent
        if (event.type === 'claim_proposed' && !claims.has(event.claim.id)) {
          claims.set(event.claim.id, event.claim)
        } else if (event.type === 'claim_status_changed') {
          const claim = claims.get(event.claimId)
          if (claim) claims.set(event.claimId, { ...claim, status: event.status })
        } else if (event.type === 'claim_used') {
          const claim = claims.get(event.claimId)
          if (claim) {
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
      } catch { /* skip malformed lines */ }
    }
    return [...claims.values()].filter(c => c.status === 'durable')
  }

  private readEvents(): ContextClaimEvent[] {
    if (!existsSync(this.path)) return []
    if (this.cachedEvents) {
      // Check if file was externally modified by comparing byte size.
      // This avoids the readFileSync in the common case (all events flow through appendEvent).
      const size = statSync(this.path).size
      if (size === this.lastFileSize) return this.cachedEvents
    }
    const content = readFileSync(this.path, 'utf-8')
    this.lastFileSize = Buffer.byteLength(content)
    const events = content
      .split('\n')
      .filter(line => line.trim().length > 0)
      .flatMap(line => {
        try {
          return [JSON.parse(line) as ContextClaimEvent]
        } catch {
          return []
        }
      })
    this.cachedEvents = events
    return events
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

      if (event.type === 'claim_used') {
        const claim = claims.get(event.claimId)
        if (!claim) continue
        const newConsumers = [...claim.consumers, {
          id: event.consumerId,
          kind: event.consumerKind,
          usedAt: event.createdAt,
        }]
        // Cap consumers array — keep most recent
        const cappedConsumers = newConsumers.length > MAX_CONSUMERS_PER_CLAIM
          ? newConsumers.slice(-MAX_CONSUMERS_PER_CLAIM)
          : newConsumers
        claims.set(event.claimId, {
          ...claim,
          lastUsedAt: event.createdAt,
          consumers: cappedConsumers,
        })
        continue
      }

      if (event.type === 'claim_boosted') {
        const claim = claims.get(event.claimId)
        if (!claim) continue
        claims.set(event.claimId, { ...claim, fitness: event.fitness })
        continue
      }
    }
  }
}
