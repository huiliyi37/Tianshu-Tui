import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { assertValidSessionId } from '../validation.js'
import {
  createClaimFromProposal,
  isPromptEligibleClaim,
  loadClaimSnapshot,
  checkpointClaims,
  type ClaimProposal,
  type ClaimSnapshot,
  type ContextClaim,
  type ContextClaimStatus,
  type EvidenceRef,
} from './claims.js'
import { claimHasFileEvidence, countClaimsByStatus, evaluatePromotion, canRecallClaim, type ClaimStatusCounts } from './promotion.js'

const MAX_CONSUMERS_PER_CLAIM = 50
const MAX_ACTIVE_CLAIMS = 50
const DEFAULT_CHECKPOINT_EVERY_EVENTS = 500

export type ContextClaimEvent =
  | { type: 'claim_proposed'; eventId: string; createdAt: number; seq?: number; claim: ContextClaim }
  | { type: 'claim_status_changed'; eventId: string; createdAt: number; seq?: number; claimId: string; status: ContextClaimStatus; reason: string }
  | { type: 'claim_used'; eventId: string; createdAt: number; seq?: number; claimId: string; consumerId: string; consumerKind: 'prompt' | 'tool' | 'test' | 'worker' }
  | { type: 'claim_boosted'; eventId: string; createdAt: number; seq?: number; claimId: string; fitness: number }

export interface ContextClaimStoreOptions {
  /** Auto-checkpoint after this many incremental JSONL events. Defaults to 500. */
  checkpointEveryEvents?: number
}

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

export interface ClaimStoreCheckpointResult {
  snapshotPath: string
  claimCount: number
  truncatedPath: string
}

export class ContextClaimStore {
  readonly path: string

  readonly sessionId: string

  private cachedEvents: ContextClaimEvent[] | null = null
  private lastFileSize: number = -1
  private cachedClaims: ContextClaim[] | null = null
  private lastProcessedLineCount: number = 0
  private readonly snapshotPath: string
  // ⚠️ Single-writer assumption: seq is per-instance, not coordinated across processes.
  // If multiple processes append to the same .claims.jsonl concurrently, seq may collide.
  // This is acceptable because claim-store is session-scoped and each session has exactly one writer.
  private nextSeq: number = 1
  private checkpointing = false
  private readonly checkpointEveryEvents?: number

  constructor(dir: string, sessionId: string, options: ContextClaimStoreOptions = {}) {
    assertValidSessionId(sessionId)
    this.sessionId = sessionId
    this.checkpointEveryEvents = options.checkpointEveryEvents ?? DEFAULT_CHECKPOINT_EVERY_EVENTS
    mkdirSync(dir, { recursive: true })
    this.path = join(dir, `${this.sessionId}.claims.jsonl`)
    this.snapshotPath = join(dir, `${this.sessionId}.claims.snapshot.json`)
  }

  get eventCount(): number {
    return this.readEvents().length
  }

  appendEvent(event: ContextClaimEvent): void {
    if (!this.cachedEvents) {
      if (existsSync(this.path)) this.readEvents()
      const checkpointSnapshot = this.loadFromCheckpoint()
      if (checkpointSnapshot) this.nextSeq = Math.max(this.nextSeq, checkpointSnapshot.lastEventSeq + 1)
    }
    const withSeq: ContextClaimEvent = { ...event, seq: event.seq ?? this.nextSeq }
    const line = JSON.stringify(withSeq) + '\n'
    appendFileSync(this.path, line, 'utf-8')
    this.nextSeq = Math.max(this.nextSeq, (withSeq.seq ?? 0) + 1)
    if (this.cachedEvents) {
      this.cachedEvents.push(withSeq)
      this.lastFileSize += Buffer.byteLength(line)
    }
    if (!this.checkpointing && this.checkpointEveryEvents !== undefined && this.checkpointEveryEvents > 0 && this.cachedEvents !== null && this.cachedEvents.length >= this.checkpointEveryEvents) {
      this.checkpoint()
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

  promoteEligibleClaims(now = Date.now(), cwd?: string): ContextClaim[] {
    const promoted: ContextClaim[] = []
    for (const claim of this.listClaims()) {
      const next = evaluatePromotion(claim, now)
      if (!next) continue

      // Recall-gate (NREM consolidation): verify evidence files still exist
      // before promoting. If evidence is irrecoverable, mark stale and skip.
      if (!canRecallClaim(claim, cwd)) {
        this.updateClaimStatus(claim.id, 'stale', 'recall-gate: evidence files no longer exist')
        continue
      }

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

  /**
   * Checkpoint: write current claims state as a snapshot, then truncate JSONL.
   * Follows Redis 7.0 Base+Incr pattern:
   * - Snapshot = full projected state (base)
   * - JSONL = incremental events after snapshot (incr)
   * - Load = read snapshot + replay incr events
   */
  checkpoint(now = Date.now()): ClaimStoreCheckpointResult {
    this.checkpointing = true
    try {
      const snapshot = checkpointClaims(this.listClaims(), now, this.maxEventSeq(this.readEvents()))
      writeFileAtomicSync(this.snapshotPath, JSON.stringify(snapshot, null, 2) + '\n')

      // Truncate JSONL — start fresh incremental log.
      writeFileAtomicSync(this.path, '')

      // Keep the projected snapshot in memory so the current store remains usable.
      this.cachedEvents = []
      this.cachedClaims = loadClaimSnapshot(snapshot, now)
      this.lastProcessedLineCount = 0
      this.lastFileSize = 0

      return { snapshotPath: this.snapshotPath, claimCount: snapshot.claims.length, truncatedPath: this.path }
    } finally {
      this.checkpointing = false
    }
  }

  /**
   * Load claims from checkpoint snapshot. Incremental JSONL events are replayed
   * by projectClaims() after this base state is loaded.
   */
  private loadFromCheckpoint(now = Date.now()): { claims: ContextClaim[]; lastEventSeq: number } | null {
    if (!existsSync(this.snapshotPath)) return null

    try {
      const raw = readFileSync(this.snapshotPath, 'utf-8')
      const snapshot = JSON.parse(raw) as ClaimSnapshot
      return {
        claims: loadClaimSnapshot(snapshot, now),
        // Old snapshots predate watermarks and were always paired with a
        // truncated JSONL in production. Treat them as base state only.
        lastEventSeq: snapshot.lastEventSeq ?? 0,
      }
    } catch {
      return null
    }
  }

  /** Delete checkpoint snapshot file (for testing or cleanup). */
  deleteCheckpoint(): void {
    if (existsSync(this.snapshotPath)) {
      unlinkSync(this.snapshotPath)
    }
  }

  static loadDurableClaims(dir: string, sessionId: string): ContextClaim[] {
    if (!existsSync(join(dir, `${sessionId}.claims.jsonl`)) && !existsSync(join(dir, `${sessionId}.claims.snapshot.json`))) return []
    const store = new ContextClaimStore(dir, sessionId)
    return store.listClaims().filter(c => c.status === 'durable')
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
    this.nextSeq = Math.max(1, this.maxEventSeq(events) + 1)
    return events
  }

  private maxEventSeq(events: readonly ContextClaimEvent[]): number {
    return events.reduce((max, event, index) => Math.max(max, event.seq ?? index + 1), 0)
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

    // Try loading from checkpoint snapshot first
    const checkpointSnapshot = this.loadFromCheckpoint()
    if (checkpointSnapshot) {
      const claims = new Map(checkpointSnapshot.claims.map(c => [c.id, c]))
      this.nextSeq = Math.max(this.nextSeq, checkpointSnapshot.lastEventSeq + 1, this.maxEventSeq(events) + 1)
      // Replay only events newer than the snapshot watermark. This makes the
      // snapshot-write-before-jsonl-truncate crash window safe.
      const replayEvents = events.filter((event, index) => (event.seq ?? index + 1) > checkpointSnapshot.lastEventSeq)
      this.applyEventsToMap(claims, replayEvents)
      this.cachedClaims = [...claims.values()]
      this.lastProcessedLineCount = events.length
      return this.cachedClaims
    }

    // Full rebuild from events
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
