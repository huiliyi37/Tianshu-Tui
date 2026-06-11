export type GatedInfluenceSource =
  | 'team_scheduler_bandit'
  | 'model_tier_bandit'
  | 'model_routing'
  | 'plan_cache_advisory'
  | 'physarum_supervision'
  | 'effort_bandit'

export interface GatedInfluenceAuditEvent {
  schemaVersion: 1
  source: GatedInfluenceSource
  sessionId: string
  targetId: string
  gateOpen: boolean
  applied: boolean
  reason: string
  evidenceWindow: Record<string, number | boolean | string>
  vetoSignals: string[]
  timestamp: number
}

export interface GatedInfluenceAuditStore {
  saveBanditState(kind: string, json: string): void
}

export interface BuildGatedInfluenceAuditInput {
  source: GatedInfluenceSource
  sessionId: string
  targetId: string
  gateOpen: boolean
  applied: boolean
  reason: string
  evidenceWindow?: Record<string, number | boolean | string | undefined>
  vetoSignals?: string[]
  timestamp?: number
}

function sanitizeEvidenceWindow(input: Record<string, number | boolean | string | undefined> | undefined): Record<string, number | boolean | string> {
  const out: Record<string, number | boolean | string> = {}
  if (!input) return out
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue
    if (typeof value === 'number' && !Number.isFinite(value)) continue
    out[key] = value
  }
  return out
}

function safeTargetId(value: string): string {
  return value.replace(/[^a-zA-Z0-9:_@.-]/g, '_').slice(0, 160) || 'unknown'
}

export function gatedInfluenceAuditKind(event: Pick<GatedInfluenceAuditEvent, 'source' | 'sessionId' | 'targetId' | 'timestamp'>): string {
  return `gated_influence_audit:${event.source}:${event.sessionId}:${safeTargetId(event.targetId)}:${event.timestamp}`
}

export function buildGatedInfluenceAuditEvent(input: BuildGatedInfluenceAuditInput): GatedInfluenceAuditEvent {
  return {
    schemaVersion: 1,
    source: input.source,
    sessionId: input.sessionId,
    targetId: input.targetId,
    gateOpen: input.gateOpen,
    applied: input.applied,
    reason: input.reason,
    evidenceWindow: sanitizeEvidenceWindow(input.evidenceWindow),
    vetoSignals: [...new Set(input.vetoSignals ?? [])].sort(),
    timestamp: input.timestamp ?? Date.now(),
  }
}

export function persistGatedInfluenceAudit(
  store: GatedInfluenceAuditStore | undefined | null,
  event: GatedInfluenceAuditEvent,
): void {
  if (!store) return
  try {
    store.saveBanditState(gatedInfluenceAuditKind(event), JSON.stringify(event))
  } catch {
    // Audit telemetry is append-only evidence and must never affect runtime decisions.
  }
}
