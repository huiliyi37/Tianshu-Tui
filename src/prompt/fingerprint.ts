import { createHash } from 'crypto'
import type { ToolDefinition } from '../api/types.js'

export interface PrefixFingerprint {
  systemSha256: string
  toolsSha256: string
  combinedSha256: string
}

export interface DriftEvent {
  systemChanged: boolean
  toolsChanged: boolean
  message: string
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

export function computeFingerprint(
  systemText: string,
  tools: ToolDefinition[] | undefined,
): PrefixFingerprint {
  const systemSha256 = sha256(systemText)

  const toolsSha256 = tools && tools.length > 0
    ? sha256(tools.map(t => t.name).sort().join(','))
    : sha256('')

  const combinedSha256 = sha256(`${systemSha256}:${toolsSha256}`)

  return { systemSha256, toolsSha256, combinedSha256 }
}

export function detectDrift(
  baseline: PrefixFingerprint,
  current: PrefixFingerprint,
): DriftEvent | null {
  if (baseline.combinedSha256 === current.combinedSha256) return null

  const systemChanged = baseline.systemSha256 !== current.systemSha256
  const toolsChanged = baseline.toolsSha256 !== current.toolsSha256

  const parts: string[] = []
  if (systemChanged) parts.push('system prompt')
  if (toolsChanged) parts.push('tool definitions')
  const message = `Prefix cache drift detected: ${parts.join(' and ')} changed`

  return { systemChanged, toolsChanged, message }
}
