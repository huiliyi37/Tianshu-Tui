export interface GhostEntry {
  artifactId: string
  tool: string
  target: string
  evictedAtTurn: number
  originalTokens: number
  accessedAfterEviction: number
}

export interface DiscoveredCacheBehavior {
  hasCache: boolean
  matchingStrategy: 'exact-prefix' | 'partial' | 'unknown'
  observedMinTokens: number | null
  confidence: number
}

export interface ThresholdState {
  artifactThreshold: number
  artifactErrorThreshold: number
  stalePreviewChars: number
}

export type CacheTemperature = 'hot' | 'warm' | 'cold'

export interface TurnMetrics {
  turn: number
  cacheRead: number
  cacheCreation: number
  prefixChanged: boolean
  artifactIdsEvicted: string[]
  artifactIdsAccessed: string[]
}

export interface CacheAdvisorDiagnostic {
  temperature: CacheTemperature
  discoveredBehavior: DiscoveredCacheBehavior
  ghostHitRate: number
  currentThresholds: ThresholdState
  adaptiveStrategy: string
  recentHitRate: number | null
}
