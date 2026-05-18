import { createHash } from 'node:crypto'

export type ContextLayerId =
  | 'system'
  | 'tools'
  | 'session-memory'
  | 'historical-lessons'
  | 'working-set'
  | 'recent-raw-turns'
  | 'current-request'
  | 'project-instructions'
  | 'git-status'
  | 'tool-history'
  | 'task-progress'
  | 'behavior-mirror'
  | 'decisions'

export type ContextLayerStability = 'stable' | 'stable-volatile' | 'dynamic'
export type ContextLayerChannel = 'system' | 'tools' | 'volatile-user-message' | 'raw-messages' | 'current-user-message'
export type ContextLayerFingerprint = 'included' | 'excluded' | 'partial'

export interface ContextLayerInput {
  id: ContextLayerId
  label: string
  stability: ContextLayerStability
  channel: ContextLayerChannel
  fingerprint: ContextLayerFingerprint
  content: string
  tokenEstimate?: number
}

export interface ContextLayer extends ContextLayerInput {
  digest: string
  tokenEstimate: number
}

export interface ContextLayerReport {
  layers: ContextLayer[]
  fingerprintIncluded: ContextLayer[]
  dynamicLayers: ContextLayer[]
}

const LAYER_ORDER: ContextLayerId[] = [
  'system',
  'tools',
  'project-instructions',
  'git-status',
  'session-memory',
  'historical-lessons',
  'working-set',
  'recent-raw-turns',
  'tool-history',
  'task-progress',
  'behavior-mirror',
  'decisions',
  'current-request',
]

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`
}

export function stableLayerDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function createContextLayer(input: ContextLayerInput): ContextLayer {
  return {
    ...input,
    digest: stableLayerDigest(input.content),
    tokenEstimate: input.tokenEstimate ?? estimateTokens(input.content),
  }
}

export function createContextLayerReport(layers: ContextLayer[]): ContextLayerReport {
  const ordered = [...layers].sort((a, b) => LAYER_ORDER.indexOf(a.id) - LAYER_ORDER.indexOf(b.id))
  return {
    layers: ordered,
    fingerprintIncluded: ordered.filter(layer => layer.fingerprint === 'included'),
    dynamicLayers: ordered.filter(layer => layer.stability === 'dynamic'),
  }
}
