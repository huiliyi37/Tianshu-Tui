/**
 * 主控心流控制面 — pure signal reducer (Wave 1).
 *
 * The control plane folds mechanism-level facts (advisory lifecycle, worker
 * verification, compaction/cache decisions, ownership) into a single
 * deterministic frame with four attention routes:
 *
 *   silent        → existing telemetry/ledger only, never provider-visible
 *   status        → TUI status sink (AdvisoryBus.setStatusSink fallback semantics)
 *   appendix      → PromptEngine dynamic appendix (state-change driven, K1)
 *   decision-gate → the master must decide; never auto-fixed/auto-approved
 *
 * Purity contract: no IO, no model calls, no SessionContext, no Date.now(),
 * no randomness. Identical input → identical frame. `revision` bumps ONLY
 * when model-visible state (appendix / decision gates) changes, so callers
 * can use it as a cheap "do I need to re-render the appendix" check without
 * risking prefix-cache churn from silent/status noise.
 */

export type ControlSignalKind =
  | 'advisory'
  | 'worker'
  | 'verification'
  | 'ownership'
  | 'compaction'
  | 'cache'
  | 'cross-session'
  | 'obligation'

export type AttentionRoute = 'silent' | 'status' | 'appendix' | 'decision-gate'
export type SignalSeverity = 'info' | 'attention' | 'blocking'

export interface ControlSignal {
  key: string
  kind: ControlSignalKind
  severity: SignalSeverity
  /** Stable, short, trackable fact. No timestamps / random IDs / free-form model text. */
  summary: string
  routeHint?: AttentionRoute
  requiresDecision: boolean
  /** Remaining turns; ticked once per turn via tickControlSignals(), dropped at 0. */
  ttlTurns: number
  evidenceKey?: string
  cacheImpact: 'none' | 'dynamic-tail' | 'history-boundary'
}

export interface ControlPlaneFrame {
  focus: 'continue' | 'inspect' | 'verify' | 'resolve-conflict' | 'await-user'
  signals: readonly ControlSignal[]
  decisionGates: readonly ControlSignal[]
  status: readonly ControlSignal[]
  appendix: readonly ControlSignal[]
  revision: number
}

const APPENDIX_CAP = 3
const STATUS_CAP = 8

const SEVERITY_RANK: Record<SignalSeverity, number> = { blocking: 0, attention: 1, info: 2 }
const ROUTE_RANK: Record<AttentionRoute, number> = { 'decision-gate': 0, appendix: 1, status: 2, silent: 3 }

export function emptyControlPlaneFrame(): ControlPlaneFrame {
  return { focus: 'continue', signals: [], decisionGates: [], status: [], appendix: [], revision: 0 }
}

/** Attention route for a signal. A decision requirement or blocking severity
 *  always wins over any hint — gates cannot be silenced by mislabeling. */
export function routeFor(signal: ControlSignal): AttentionRoute {
  if (signal.requiresDecision || signal.severity === 'blocking') return 'decision-gate'
  if (signal.routeHint && signal.routeHint !== 'decision-gate') return signal.routeHint
  return signal.severity === 'attention' ? 'status' : 'silent'
}

/** One turn boundary passed: decrement every TTL exactly once (pure copy). */
export function tickControlSignals(signals: readonly ControlSignal[]): ControlSignal[] {
  return signals.map(s => ({ ...s, ttlTurns: s.ttlTurns - 1 }))
}

function compareSignals(a: ControlSignal, b: ControlSignal): number {
  const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
  if (bySeverity !== 0) return bySeverity
  const byRoute = ROUTE_RANK[routeFor(a)] - ROUTE_RANK[routeFor(b)]
  if (byRoute !== 0) return byRoute
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

/** Model-visible identity: appendix + decision gates. Silent/status churn
 *  must not bump revision (they never reach the provider payload). */
function visibleFingerprint(appendix: readonly ControlSignal[], gates: readonly ControlSignal[]): string {
  const part = (s: ControlSignal) => `${s.key}\u0001${s.severity}\u0001${s.summary}`
  return `${appendix.map(part).join('\u0002')}\u0003${gates.map(part).join('\u0002')}`
}

function inferFocus(ordered: readonly ControlSignal[]): ControlPlaneFrame['focus'] {
  if (ordered.some(s => s.kind === 'ownership' && s.severity !== 'info')) return 'resolve-conflict'
  if (ordered.some(s => s.kind === 'verification' && s.severity !== 'info')) return 'verify'
  if (ordered.some(s => (s.kind === 'compaction' || s.kind === 'cache') && s.severity !== 'info')) return 'inspect'
  return 'continue'
}

/**
 * Focus for a frame that has decision gates. Obligation-kind gates mean "the
 * model must go act" (inspect/verify) — NOT "wait for the user". Any
 * non-obligation gate (false-green worker episode, worker timeout rebudget,
 * permission/approval) keeps the historical `await-user` semantics and wins
 * over obligation focus when mixed.
 *
 * Obligation gate keys carry their focus verb by convention:
 * `obligation:verify:<id>` → verify, anything else → inspect.
 */
function focusForGates(gates: readonly ControlSignal[]): ControlPlaneFrame['focus'] {
  if (gates.some(s => s.kind !== 'obligation')) return 'await-user'
  return gates.some(s => s.key.startsWith('obligation:verify:')) ? 'verify' : 'inspect'
}

/**
 * Fold incoming signals into the previous frame. Pure and idempotent:
 * reducing again with no incoming input returns a deep-equal frame.
 */
export function reduceControlSignals(
  previous: ControlPlaneFrame,
  incoming: readonly ControlSignal[],
): ControlPlaneFrame {
  // Dedup by key: highest severity wins; on tie the later submission wins
  // (incoming refreshes previous state for the same fact).
  const byKey = new Map<string, ControlSignal>()
  for (const signal of [...previous.signals, ...incoming]) {
    if (signal.ttlTurns <= 0) continue
    const existing = byKey.get(signal.key)
    if (!existing || SEVERITY_RANK[signal.severity] <= SEVERITY_RANK[existing.severity]) {
      byKey.set(signal.key, signal)
    }
  }

  const ordered = [...byKey.values()].sort(compareSignals)
  const decisionGates = ordered.filter(s => routeFor(s) === 'decision-gate')
  const appendix = ordered.filter(s => routeFor(s) === 'appendix').slice(0, APPENDIX_CAP)
  const status = ordered.filter(s => routeFor(s) === 'status').slice(0, STATUS_CAP)

  const changed = visibleFingerprint(appendix, decisionGates)
    !== visibleFingerprint(previous.appendix, previous.decisionGates)

  return {
    focus: decisionGates.length > 0 ? focusForGates(decisionGates) : inferFocus(ordered),
    signals: ordered,
    decisionGates,
    status,
    appendix,
    revision: previous.revision + (changed ? 1 : 0),
  }
}

/** Signals routed to `silent` — consumers write them to existing ledgers. */
export function silentSignals(frame: ControlPlaneFrame): ControlSignal[] {
  return frame.signals.filter(s => routeFor(s) === 'silent')
}

/**
 * Render the appendix lane as a byte-stable dynamic block (Wave 4, active
 * mode only). Pure function of the frame's appendix lane: no timestamps,
 * no random IDs, no counters, no revision number in the output — identical
 * lane content → identical bytes, so the appendixDelta path sees zero churn
 * while the model-visible state is unchanged.
 */
export function renderControlPlaneAppendix(frame: ControlPlaneFrame): string | null {
  if (frame.appendix.length === 0) return null
  const lines = frame.appendix.map(s => `- [${s.severity}] ${s.summary}${s.evidenceKey ? ` (evidence: ${s.evidenceKey})` : ''}`)
  return `<control-plane>\n${lines.join('\n')}\n</control-plane>`
}
