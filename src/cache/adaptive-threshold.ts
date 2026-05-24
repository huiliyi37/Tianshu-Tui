import type { ThresholdState } from './types.js'
import type { GhostRegistry } from './ghost-registry.js'
import { pruneThresholds } from '../compact/constants.js'

export interface AdaptiveThresholdConfig {
  ghostRegistry: GhostRegistry
  initialThresholds?: Partial<ThresholdState>
  /** Active context window — drives the upper bounds so the controller
   *  doesn't train itself into a sub-scale 4K cap on a 1M window. */
  contextWindow?: number
}

const DEFAULTS: ThresholdState = {
  artifactThreshold: 800,
  artifactErrorThreshold: 1600,
  stalePreviewChars: 1200,
}

/** Base bounds for small (<200K) windows — legacy behaviour. */
const MIN_ARTIFACT_BASE = 400
const MAX_ARTIFACT_BASE = 4000
const MIN_STALE_BASE = 600
const MAX_STALE_BASE = 2400

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val))
}

/** Scale the adaptive bounds to match the window-aware compaction thresholds.
 *  On a 1M window this lifts the artifact cap from 4 000 → ~150 000 chars so
 *  the controller can meaningfully adapt in the regime where tools actually
 *  make wrapping decisions (pruneThresholds.minChars). */
function scaleBounds(contextWindow: number | undefined): {
  minArtifact: number
  maxArtifact: number
  minStale: number
  maxStale: number
} {
  if (!contextWindow || contextWindow < 200_000) {
    return {
      minArtifact: MIN_ARTIFACT_BASE,
      maxArtifact: MAX_ARTIFACT_BASE,
      minStale: MIN_STALE_BASE,
      maxStale: MAX_STALE_BASE,
    }
  }
  const { minChars } = pruneThresholds(contextWindow)
  // Scale the artifact bound to match the window-aware floor used by
  // artifactIntercept in tool-pipeline.  The controller's adaptive range
  // should span from a reasonable floor (1/4 of minChars) to the ceiling
  // (minChars itself), giving it meaningful room to move.
  return {
    minArtifact: Math.max(MIN_ARTIFACT_BASE, Math.floor(minChars / 4)),
    maxArtifact: Math.max(MIN_ARTIFACT_BASE * 10, minChars),
    minStale: Math.max(MIN_STALE_BASE, Math.floor(minChars / 6)),
    maxStale: Math.max(MAX_STALE_BASE * 10, Math.floor(minChars * 0.6)),
  }
}

export class AdaptiveThresholdController {
  private state: ThresholdState
  private readonly ghostRegistry: GhostRegistry
  private readonly bounds: ReturnType<typeof scaleBounds>

  constructor(config: AdaptiveThresholdConfig) {
    this.ghostRegistry = config.ghostRegistry
    this.bounds = scaleBounds(config.contextWindow)
    const initial = { ...DEFAULTS, ...config.initialThresholds }
    // Clamp the initial state into the active bounds so getArtifactThreshold
    // returns a sensible value before the first adjust() call. Without this,
    // a 1M window starts the controller at 800 chars (legacy DEFAULTS) and
    // would only escalate to ~37 500 after the first cache-feedback tick.
    this.state = {
      artifactThreshold: clamp(initial.artifactThreshold, this.bounds.minArtifact, this.bounds.maxArtifact),
      artifactErrorThreshold: clamp(initial.artifactErrorThreshold, this.bounds.minArtifact, this.bounds.maxArtifact * 2),
      stalePreviewChars: clamp(initial.stalePreviewChars, this.bounds.minStale, this.bounds.maxStale),
    }
  }

  adjust(cacheHitRate: number, currentTurn: number): ThresholdState {
    const recentGhostHits = this.ghostRegistry.getRecentGhostHits(3, currentTurn)
    const { minArtifact, maxArtifact, minStale, maxStale } = this.bounds

    // Ghost hit feedback: evicted content re-requested → thresholds too low
    if (recentGhostHits.length >= 2) {
      this.state.artifactThreshold = clamp(this.state.artifactThreshold + 200, minArtifact, maxArtifact)
      this.state.stalePreviewChars = clamp(this.state.stalePreviewChars + 400, minStale, maxStale)
      this.state.artifactErrorThreshold = this.state.artifactThreshold * 2
      return { ...this.state }
    }

    // Cache economics: high hit rate → inline is cheap → raise threshold
    if (cacheHitRate >= 0.8) {
      this.state.artifactThreshold = clamp(this.state.artifactThreshold + 100, minArtifact, maxArtifact)
    } else if (cacheHitRate < 0.3) {
      this.state.artifactThreshold = clamp(this.state.artifactThreshold - 100, minArtifact, maxArtifact)
    }

    // Ghost efficiency high AND we have enough data → can be more aggressive
    const efficiency = this.ghostRegistry.getEvictionEfficiency()
    if (efficiency > 0.9 && this.ghostRegistry.size() >= 5 && this.state.artifactThreshold > minArtifact + 200) {
      this.state.artifactThreshold = clamp(this.state.artifactThreshold - 50, minArtifact, maxArtifact)
    }

    this.state.artifactErrorThreshold = this.state.artifactThreshold * 2
    return { ...this.state }
  }

  getState(): ThresholdState {
    return { ...this.state }
  }
}
