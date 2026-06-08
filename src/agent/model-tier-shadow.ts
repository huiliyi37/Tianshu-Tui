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

export interface ModelTierShadowStore {
  saveBanditState(kind: string, json: string): void
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

export function modelTierShadowKind(event: Pick<ModelTierShadowEvent, 'sessionId' | 'workOrderId' | 'timestamp'>): string {
  return `model_tier_shadow:${event.sessionId}:${event.workOrderId}:${event.timestamp}`
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
