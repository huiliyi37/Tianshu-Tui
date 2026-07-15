import { createHash } from 'node:crypto'
import type { Sensorium } from './sensorium.js'
import type { CapabilityTask, ModelCapabilityCard } from '../model/capability.js'
import { recommendModelForTask } from '../model/capability.js'
import { inferTaskType, type ToolCallRecord } from '../model/task-inferrer.js'

export interface LegacyRoutingRecommendation {
  task: CapabilityTask
  model: string
  reason: string
}

export interface ModelRoutingShadowEvent {
  schemaVersion: 1
  sessionId: string
  turn: number
  objectiveHash: string
  currentModel: string
  selectedBy: 'human' | 'config'
  legacyRouterRecommendedModel?: string
  efeRecommendedModel?: string
  sensorium: Pick<Sensorium, 'complexity' | 'pressure' | 'confidence' | 'stability'>
  /** W4-D2: latest main-loop verification status at record time. Feeds the
   *  shadow reward's verificationPass; 'blocked' stays neutral. */
  verificationOutcome?: 'passed' | 'failed' | 'blocked'
  reason: string
  timestamp: number
}

export interface ModelRoutingShadowStore {
  saveBanditState(kind: string, json: string): void
}

export interface BuildModelRoutingShadowEventInput {
  sessionId: string
  turn: number
  objective: string
  currentModel: string
  sensorium: Pick<Sensorium, 'complexity' | 'pressure' | 'confidence' | 'stability'>
  selectedBy?: 'human' | 'config'
  legacyRouting?: LegacyRoutingRecommendation | null
  efeRecommendedModel?: string
  verificationOutcome?: 'passed' | 'failed' | 'blocked'
  reason?: string
  timestamp?: number
}

export function hashObjective(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

export function routingShadowKind(event: Pick<ModelRoutingShadowEvent, 'sessionId' | 'turn' | 'timestamp'>): string {
  return `routing_shadow:${event.sessionId}:${event.turn}:${event.timestamp}`
}

export function inferLegacyRoutingRecommendation(
  recentCalls: ToolCallRecord[],
  modelCards: ModelCapabilityCard[] | undefined,
): LegacyRoutingRecommendation | null {
  if (!modelCards || modelCards.length === 0) return null
  const inference = inferTaskType(recentCalls)
  if (!inference) return null

  try {
    const recommended = recommendModelForTask(inference.task, modelCards)
    return {
      task: inference.task,
      model: recommended.model,
      reason: inference.reason,
    }
  } catch {
    return null
  }
}

export function buildModelRoutingShadowEvent(input: BuildModelRoutingShadowEventInput): ModelRoutingShadowEvent {
  const legacyReason = input.legacyRouting
    ? `${input.legacyRouting.task} · ${input.legacyRouting.model} ${input.legacyRouting.reason}`
    : 'legacy router produced no recommendation'
  return {
    schemaVersion: 1,
    sessionId: input.sessionId,
    turn: input.turn,
    objectiveHash: hashObjective(input.objective),
    currentModel: input.currentModel,
    selectedBy: input.selectedBy ?? 'config',
    ...(input.legacyRouting ? { legacyRouterRecommendedModel: input.legacyRouting.model } : {}),
    ...(input.efeRecommendedModel ? { efeRecommendedModel: input.efeRecommendedModel } : {}),
    ...(input.verificationOutcome ? { verificationOutcome: input.verificationOutcome } : {}),
    sensorium: {
      complexity: input.sensorium.complexity,
      pressure: input.sensorium.pressure,
      confidence: input.sensorium.confidence,
      stability: input.sensorium.stability,
    },
    reason: input.reason ?? legacyReason,
    timestamp: input.timestamp ?? Date.now(),
  }
}

export function persistModelRoutingShadow(
  store: ModelRoutingShadowStore | undefined | null,
  event: ModelRoutingShadowEvent,
): void {
  if (!store) return
  try {
    store.saveBanditState(routingShadowKind(event), JSON.stringify(event))
  } catch {
    // Shadow telemetry must never affect the turn.
  }
}
