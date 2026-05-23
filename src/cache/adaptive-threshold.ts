import type { ThresholdState } from './types.js'
import type { GhostRegistry } from './ghost-registry.js'

export interface AdaptiveThresholdConfig {
  ghostRegistry: GhostRegistry
  initialThresholds?: Partial<ThresholdState>
}

const DEFAULTS: ThresholdState = {
  artifactThreshold: 800,
  artifactErrorThreshold: 1600,
  stalePreviewChars: 1200,
}

const MIN_ARTIFACT = 400
const MAX_ARTIFACT = 2000
const MIN_STALE = 600
const MAX_STALE = 2400

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val))
}

export class AdaptiveThresholdController {
  private state: ThresholdState
  private readonly ghostRegistry: GhostRegistry

  constructor(config: AdaptiveThresholdConfig) {
    this.ghostRegistry = config.ghostRegistry
    this.state = { ...DEFAULTS, ...config.initialThresholds }
  }

  adjust(cacheHitRate: number, currentTurn: number): ThresholdState {
    const recentGhostHits = this.ghostRegistry.getRecentGhostHits(3, currentTurn)

    // Ghost hit feedback: evicted content re-requested → thresholds too low
    if (recentGhostHits.length >= 2) {
      this.state.artifactThreshold = clamp(this.state.artifactThreshold + 200, MIN_ARTIFACT, MAX_ARTIFACT)
      this.state.stalePreviewChars = clamp(this.state.stalePreviewChars + 400, MIN_STALE, MAX_STALE)
      this.state.artifactErrorThreshold = this.state.artifactThreshold * 2
      return { ...this.state }
    }

    // Cache economics: high hit rate → inline is cheap → raise threshold
    if (cacheHitRate >= 0.8) {
      this.state.artifactThreshold = clamp(this.state.artifactThreshold + 100, MIN_ARTIFACT, MAX_ARTIFACT)
    } else if (cacheHitRate < 0.3) {
      this.state.artifactThreshold = clamp(this.state.artifactThreshold - 100, MIN_ARTIFACT, MAX_ARTIFACT)
    }

    // Ghost efficiency high AND we have enough data → can be more aggressive
    const efficiency = this.ghostRegistry.getEvictionEfficiency()
    if (efficiency > 0.9 && this.ghostRegistry.size() >= 5 && this.state.artifactThreshold > 600) {
      this.state.artifactThreshold = clamp(this.state.artifactThreshold - 50, MIN_ARTIFACT, MAX_ARTIFACT)
    }

    this.state.artifactErrorThreshold = this.state.artifactThreshold * 2
    return { ...this.state }
  }

  getState(): ThresholdState {
    return { ...this.state }
  }
}
