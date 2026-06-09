import type { ModelTier } from './model-tier-policy.js'

export interface ModelTierShadowEvent {
  schemaVersion: 1
  sessionId: string
  workOrderId: string
  authority?: string
  profile: string
  kind: string
  recommendedTier: ModelTier
  actualModel: string
  actualTier: ModelTier
  matched: boolean
  reason: string
  timestamp: number
}

export interface ModelTierGatedDecisionEvent {
  schemaVersion: 1
  sessionId: string
  workOrderId: string
  authority?: string
  profile: string
  kind: string
  ruleTier: ModelTier
  candidateTier: ModelTier
  applied: boolean
  gateOpen: boolean
  reason: string
  selectedModel: string
  selectedTier: ModelTier
  timestamp: number
}

export interface ModelTierShadowStore {
  saveBanditState(kind: string, json: string): void
  loadBanditStatesByPrefix?(prefix: string, limit?: number): Array<{ kind: string; json: string }>
}

export interface BuildModelTierShadowEventInput {
  sessionId: string
  workOrderId: string
  authority?: string
  profile: string
  kind: string
  recommendedTier: ModelTier
  actualModel: string
  actualTier: ModelTier
  reason: string
  timestamp?: number
}

export interface BuildModelTierGatedDecisionEventInput {
  sessionId: string
  workOrderId: string
  authority?: string
  profile: string
  kind: string
  ruleTier: ModelTier
  candidateTier: ModelTier
  applied: boolean
  gateOpen: boolean
  reason: string
  selectedModel: string
  selectedTier: ModelTier
  timestamp?: number
}

export function modelTierShadowKind(event: Pick<ModelTierShadowEvent, 'sessionId' | 'workOrderId' | 'timestamp'>): string {
  return `model_tier_shadow:${event.sessionId}:${event.workOrderId}:${event.timestamp}`
}

export function modelTierGatedDecisionKind(event: Pick<ModelTierGatedDecisionEvent, 'sessionId' | 'workOrderId' | 'timestamp'>): string {
  return `model_tier_gated_decision:${event.sessionId}:${event.workOrderId}:${event.timestamp}`
}

export function buildModelTierShadowEvent(input: BuildModelTierShadowEventInput): ModelTierShadowEvent {
  return {
    schemaVersion: 1,
    sessionId: input.sessionId,
    workOrderId: input.workOrderId,
    ...(input.authority ? { authority: input.authority } : {}),
    profile: input.profile,
    kind: input.kind,
    recommendedTier: input.recommendedTier,
    actualModel: input.actualModel,
    actualTier: input.actualTier,
    matched: input.recommendedTier === input.actualTier,
    reason: input.reason,
    timestamp: input.timestamp ?? Date.now(),
  }
}

export function buildModelTierGatedDecisionEvent(input: BuildModelTierGatedDecisionEventInput): ModelTierGatedDecisionEvent {
  return {
    schemaVersion: 1,
    sessionId: input.sessionId,
    workOrderId: input.workOrderId,
    ...(input.authority ? { authority: input.authority } : {}),
    profile: input.profile,
    kind: input.kind,
    ruleTier: input.ruleTier,
    candidateTier: input.candidateTier,
    applied: input.applied,
    gateOpen: input.gateOpen,
    reason: input.reason,
    selectedModel: input.selectedModel,
    selectedTier: input.selectedTier,
    timestamp: input.timestamp ?? Date.now(),
  }
}

export function persistModelTierShadow(
  store: ModelTierShadowStore | undefined | null,
  event: ModelTierShadowEvent,
): void {
  if (!store) return
  try {
    store.saveBanditState(modelTierShadowKind(event), JSON.stringify(event))
  } catch {
    // Tier shadow telemetry must never affect worker dispatch.
  }
}

export function persistModelTierGatedDecision(
  store: ModelTierShadowStore | undefined | null,
  event: ModelTierGatedDecisionEvent,
): void {
  if (!store) return
  try {
    store.saveBanditState(modelTierGatedDecisionKind(event), JSON.stringify(event))
  } catch {
    // Tier gated telemetry must never affect worker dispatch.
  }
}
