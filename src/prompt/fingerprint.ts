import { createHash } from 'crypto'
import type { ToolDefinition } from '../api/types.js'
import type { AnchorGraph } from './anchor-graph.js'
import { stableStringify } from '../api/stable-json.js'

export interface PrefixFingerprint {
  systemSha256: string
  toolsSha256: string
  stableVolatileSha256: string
  combinedSha256: string
}

export interface DriftEvent {
  systemChanged: boolean
  toolsChanged: boolean
  stableVolatileChanged: boolean
  message: string
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

export function computeFingerprint(
  systemText: string,
  tools: ToolDefinition[] | undefined,
  stableVolatileBlock = '',
): PrefixFingerprint {
  const systemSha256 = sha256(systemText)

  const toolsSha256 = tools && tools.length > 0
    ? sha256(stableStringify([...tools].sort((a, b) => a.name.localeCompare(b.name))))
    : sha256('')

  const stableVolatileSha256 = sha256(stableVolatileBlock)
  const combinedSha256 = sha256(`${systemSha256}:${toolsSha256}:${stableVolatileSha256}`)

  return { systemSha256, toolsSha256, stableVolatileSha256, combinedSha256 }
}

export function detectDrift(
  baseline: PrefixFingerprint,
  current: PrefixFingerprint,
): DriftEvent | null {
  if (baseline.combinedSha256 === current.combinedSha256) return null

  const systemChanged = baseline.systemSha256 !== current.systemSha256
  const toolsChanged = baseline.toolsSha256 !== current.toolsSha256
  const stableVolatileChanged = baseline.stableVolatileSha256 !== current.stableVolatileSha256

  const parts: string[] = []
  if (systemChanged) parts.push('system prompt')
  if (toolsChanged) parts.push('tool definitions')
  if (stableVolatileChanged) parts.push('stable volatile context')
  const message = `Prefix cache drift detected: ${parts.join(' and ')} changed`

  return { systemChanged, toolsChanged, stableVolatileChanged, message }
}

/**
 * Compute an independent hash for the HEARTH anchor graph.
 *
 * This is NOT part of the prefix cache fingerprint — it's a parallel
 * verification layer that does not affect cache stability.
 * Uses the 'hearth:' salt to avoid collision with graph.graphHash.
 */
export function computeAnchorGraphHash(graph: AnchorGraph): string {
  return sha256(`hearth:${graph.graphHash}`)
}
