/**
 * Control-plane adapters + session controller (Wave 2).
 *
 * Adapters translate existing subsystem facts into `ControlSignal`s. They do
 * STRUCTURE MAPPING ONLY — no copies of AdvisoryBus counters, worker-evidence
 * policy, or CacheAdvisor strategy live here. Consumers of the original facts
 * (advisory-readback, vitals telemetry, routing metrics) keep their single
 * drain; the adapter receives the SAME immutable snapshot (single drain →
 * snapshot → multi-dispatch), never draining the source itself.
 *
 * Mode switch (RIVET_CONTROL_PLANE): `off | shadow | active`, default shadow.
 *   off    — controller ignores all submissions; frame stays empty.
 *   shadow — frames are reduced and recorded (K0 telemetry); prompt unchanged.
 *   active — Wave 4+: appendix lane may reach the dynamic appendix (K1).
 * In off/shadow the PromptEngine output MUST be byte-identical to a build
 * without the control plane (locked by tests).
 */
import {
  emptyControlPlaneFrame,
  reduceControlSignals,
  tickControlSignals,
  type ControlPlaneFrame,
  type ControlSignal,
} from './control-plane.js'
import type { AdvisoryLedgerDelta, DeliveredAdvisory } from './advisory-bus.js'
import type { WorkerEpisode } from './worker-episode.js'
import type { WorkerResult } from './work-order.js'
import type { EvidenceObligation, ObligationStore } from './evidence-obligation.js'

export type ControlPlaneMode = 'off' | 'shadow' | 'active'

export function controlPlaneMode(env: NodeJS.ProcessEnv = process.env): ControlPlaneMode {
  const raw = env.RIVET_CONTROL_PLANE
  if (raw === 'off' || raw === '0') return 'off'
  if (raw === 'active') return 'active'
  return 'shadow'
}

/**
 * Session-scoped controller. Signals accumulate during a turn (from drain
 * tees, hooks via emitControlSignal, worker episode closures) and are folded
 * exactly once per turn at the buildTurnRequest merge step — which is also
 * the single TTL tick point (one tick per turn, per design).
 */
export class ControlPlaneController {
  private frame = emptyControlPlaneFrame()
  private pending: ControlSignal[] = []

  constructor(readonly mode: ControlPlaneMode = controlPlaneMode()) {}

  get enabled(): boolean {
    return this.mode !== 'off'
  }

  submit(signal: ControlSignal): void {
    if (!this.enabled) return
    this.pending.push(signal)
  }

  submitAll(signals: readonly ControlSignal[]): void {
    if (!this.enabled) return
    this.pending.push(...signals)
  }

  /** Fold pending signals into the frame. Call once per turn (merge step). */
  reduceTurn(): ControlPlaneFrame {
    if (!this.enabled) return this.frame
    const carried = tickControlSignals(this.frame.signals)
    this.frame = reduceControlSignals({ ...this.frame, signals: carried }, this.pending)
    this.pending = []
    return this.frame
  }

  getFrame(): ControlPlaneFrame {
    return this.frame
  }
}

// ── Advisory lifecycle adapters (Wave 2) ────────────────────────────────────
// Delivered advisories already reached the model through the appendix/SR —
// the control plane only records the lifecycle fact on the silent route.

export function signalsFromDelivered(delivered: readonly DeliveredAdvisory[]): ControlSignal[] {
  return delivered.map(d => ({
    key: `advisory:delivered:${d.key}`,
    kind: 'advisory' as const,
    severity: 'info' as const,
    summary: `advisory ${d.key} delivered (${d.category}${d.shadow ? ', holdout-shadow' : ''})`,
    requiresDecision: false,
    ttlTurns: 1,
    cacheImpact: 'none' as const,
  }))
}

/** Ledger deltas are cumulative counters — silent-only by contract (counts
 *  would fragment the prefix if they ever reached a prompt block). */
export function signalFromLedgerDelta(delta: AdvisoryLedgerDelta): ControlSignal | null {
  if (delta.submitted === 0 && delta.dropped === 0 && delta.rendered === 0) return null
  return {
    key: 'advisory:ledger',
    kind: 'advisory',
    severity: 'info',
    summary: `advisory ledger: submitted=${delta.submitted} rendered=${delta.rendered} dropped=${delta.dropped} liftMuted=${delta.liftMuted}`,
    requiresDecision: false,
    ttlTurns: 1,
    cacheImpact: 'none',
  }
}

// ── Worker fact adapters (Wave 3, dual-source wiring) ───────────────────────
// Episode path: hands-session/write-gate → HandsSessionRun.writeGate →
// buildWorkerEpisode (coordinator.recordWorkerEpisode, 3 dispatch sites).
// Aggregation path: post-verifyWorkerEvidence results ONLY — the adapter
// never re-derives evidence policy, it maps the gated outcome.

/**
 * Episode-path signal (writeGate/falseGreen/repairCount facts).
 * Classification per plan: falseGreen → decision-gate; blocked (environment-
 * neutral) → status without escalation; everything else stays silent — the
 * result itself already reaches the master through the aggregation packet.
 */
export function signalFromWorkerEpisode(episode: WorkerEpisode): ControlSignal {
  if (episode.falseGreen) {
    return {
      key: `worker:false-green:${episode.orderId}`,
      kind: 'worker',
      severity: 'blocking',
      summary: `worker ${episode.orderId} claimed passed but main write-gate failed (false green, repairs=${episode.repairCount})`,
      requiresDecision: true,
      ttlTurns: 3,
      evidenceKey: `worker-episode:${episode.orderId}`,
      cacheImpact: 'none',
    }
  }
  if (episode.gateOutcome === 'blocked') {
    return {
      key: `worker:gate-blocked:${episode.orderId}`,
      kind: 'worker',
      severity: 'attention',
      summary: `worker ${episode.orderId} write-gate blocked (environment-neutral, not a capability failure)`,
      routeHint: 'status',
      requiresDecision: false,
      ttlTurns: 2,
      evidenceKey: `worker-episode:${episode.orderId}`,
      cacheImpact: 'none',
    }
  }
  if (episode.gateOutcome === 'failed') {
    return {
      key: `worker:gate-failed:${episode.orderId}`,
      kind: 'worker',
      severity: 'attention',
      summary: `worker ${episode.orderId} write-gate failed after ${episode.repairCount} repair round(s)`,
      routeHint: 'status',
      requiresDecision: false,
      ttlTurns: 2,
      evidenceKey: `worker-episode:${episode.orderId}`,
      cacheImpact: 'none',
    }
  }
  return {
    key: `worker:episode:${episode.orderId}`,
    kind: 'worker',
    severity: 'info',
    summary: `worker ${episode.orderId} ${episode.status} (gate=${episode.gateOutcome}, files=${episode.changedFileCount})`,
    requiresDecision: false,
    ttlTurns: 1,
    evidenceKey: `worker-episode:${episode.orderId}`,
    cacheImpact: 'none',
  }
}

/**
 * Aggregation-path signals — input MUST be verifyWorkerEvidence-gated results
 * (the `aggregateResults` output). Verified ordinary results stay silent;
 * unverified write claims become a decision gate: the master must decide to
 * re-verify or reject, never auto-accept.
 *
 * `opts.obligationVoice` (worker_claim_single_voice): when the caller also
 * creates an external_claim obligation for unverified write claims, the
 * obligation IS the model-visible voice — the worker signal here degrades to
 * a status line (no second decision gate, no duplicate appendix copy).
 */
export function signalsFromVerifiedResults(
  results: readonly WorkerResult[],
  opts?: { obligationVoice?: boolean },
): ControlSignal[] {
  return results.map(result => {
    if (result.evidenceStatus === 'unverified' && result.changedFiles.length > 0) {
      if (opts?.obligationVoice) {
        return {
          key: `worker:unverified:${result.workOrderId}`,
          kind: 'worker' as const,
          severity: 'attention' as const,
          summary: `worker ${result.workOrderId} wrote ${result.changedFiles.length} file(s) without transcript verification evidence (tracked as external_claim obligation)`,
          routeHint: 'status' as const,
          requiresDecision: false,
          ttlTurns: 2,
          evidenceKey: `worker-result:${result.workOrderId}`,
          cacheImpact: 'none' as const,
        }
      }
      return {
        key: `worker:unverified:${result.workOrderId}`,
        kind: 'verification' as const,
        severity: 'attention' as const,
        summary: `worker ${result.workOrderId} wrote ${result.changedFiles.length} file(s) without transcript verification evidence`,
        requiresDecision: true,
        ttlTurns: 3,
        evidenceKey: `worker-result:${result.workOrderId}`,
        cacheImpact: 'none' as const,
      }
    }
    if (result.status === 'blocked') {
      // W4: grade by failureReason — a json_parse block is a repairable
      // protocol fault (report existed, contract broke: status-level noise),
      // while timeout/caller_aborted means real work was cut off and the
      // primary should decide (rebudget / resume re-dispatch).
      const reason = result.failureReason
      const cutOff = reason === 'timeout' || reason === 'caller_aborted'
      return {
        key: `worker:blocked:${result.workOrderId}`,
        kind: 'worker' as const,
        severity: 'attention' as const,
        summary: `worker ${result.workOrderId} blocked${reason ? ` (${reason})` : ''}${reason === 'timeout' ? ' — budget exhausted, consider resume re-dispatch or a larger timeoutMs' : ''}`,
        routeHint: 'status' as const,
        requiresDecision: cutOff,
        ttlTurns: 2,
        evidenceKey: `worker-result:${result.workOrderId}`,
        cacheImpact: 'none' as const,
      }
    }
    return {
      key: `worker:result:${result.workOrderId}`,
      kind: 'worker' as const,
      severity: 'info' as const,
      summary: `worker ${result.workOrderId} ${result.status} (evidence=${result.evidenceStatus ?? 'n/a'})`,
      requiresDecision: false,
      ttlTurns: 1,
      evidenceKey: `worker-result:${result.workOrderId}`,
      cacheImpact: 'none' as const,
    }
  })
}

// ── Obligation adapters (Wave 3, evidence-driven reasoning loop) ─────────────

/** Families whose next step is a verification run (focus → verify);
 *  everything else routes to inspect (read/probe/cross-check). */
const VERIFY_FAMILIES: ReadonlySet<EvidenceObligation['family']> = new Set(['bugfix', 'delivery', 'regression'])

/**
 * Project the obligation store onto the control plane. Deterministic and
 * byte-stable: keys derive from the stable obligation ID, summaries reuse the
 * normalized claim text (identical state → identical signals → revision quiet).
 *
 * Routing: high open/attempted → decision-gate (kind='obligation', focus
 * inspect/verify — NOT await-user); medium and high-blocked → status lane.
 * Low obligations never surface (low_risk_small_edit_never_gates_final).
 *
 * Single-voice discipline: the model-visible copy of obligations is the
 * `<evidence-obligation>` cognitive-projection block. Control-plane signals
 * here carry focus/fingerprint/telemetry semantics only — they must NOT
 * route to the appendix lane, or active mode would render the same fact
 * twice (block + control-plane line).
 */
export function signalsFromObligations(store: ObligationStore): ControlSignal[] {
  const signals: ControlSignal[] = []
  for (const ob of store.obligations) {
    if (ob.state === 'satisfied' || ob.state === 'superseded') continue
    if (ob.risk === 'low') continue
    const focusVerb = VERIFY_FAMILIES.has(ob.family) ? 'verify' : 'inspect'
    if (ob.risk === 'high' && (ob.state === 'open' || ob.state === 'attempted')) {
      signals.push({
        key: `obligation:${focusVerb}:${ob.id}`,
        kind: 'obligation',
        severity: 'attention',
        summary: `未证断言 [${ob.family}] ${ob.claim} → 下一步 ${ob.requiredAction}`,
        requiresDecision: true,
        ttlTurns: 2,
        evidenceKey: `obligation:${ob.id}`,
        cacheImpact: 'none',
      })
    } else if (ob.risk === 'high' && ob.state === 'blocked') {
      signals.push({
        key: `obligation:blocked:${ob.id}`,
        kind: 'obligation',
        severity: 'attention',
        summary: `义务受阻 [${ob.family}] ${ob.claim}（${ob.lastFailureClass ?? 'blocked'}）——交付时须明示未验证与障碍`,
        routeHint: 'status',
        requiresDecision: false,
        ttlTurns: 2,
        evidenceKey: `obligation:${ob.id}`,
        cacheImpact: 'none',
      })
    } else {
      signals.push({
        key: `obligation:${focusVerb}:${ob.id}`,
        kind: 'obligation',
        severity: 'attention',
        summary: `未证断言 [${ob.family}] ${ob.claim} → 下一步 ${ob.requiredAction}`,
        routeHint: 'status',
        requiresDecision: false,
        ttlTurns: 2,
        evidenceKey: `obligation:${ob.id}`,
        cacheImpact: 'none',
      })
    }
  }
  return signals
}
