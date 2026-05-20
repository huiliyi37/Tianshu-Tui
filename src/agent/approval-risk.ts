import { isIP } from 'node:net'
import { evaluateMcpPolicy } from '../mcp/policy.js'
import type { ContextClaim } from '../context/claims.js'
import type { Sensorium } from './sensorium.js'

export type RiskLevel = 'none' | 'low' | 'medium' | 'high'

export interface RiskAssessment {
  level: RiskLevel
  reasons: string[]
  suggestedAction: string
}

/**
 * Shared dangerous command patterns — single source of truth for both
 * approval-risk and bash.ts requiresApproval().
 *
 * Design principles:
 * - Match dangerous *intent*, not just keywords
 * - Minimize false positives (sudo ls should not trigger)
 * - Catch destructive, irreversible, or privilege-escalating commands
 */
export const DANGEROUS_BASH_PATTERNS: ReadonlyArray<Readonly<RegExp>> = [
  /\brm\s+-(?:[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)\b/,  // rm -rf, rm -fr
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-zA-Z]*f\b/,
  /\bkillall\b/,
  /\bpkill\s+-[9Kf]\b/,               // pkill -9, pkill -KILL, pkill -f (forceful)
  /\bdrop\s+table\b/i,
  /\bsudo\s+(?:rm|chmod|chown|dd|mkfs|mount|umount|systemctl|shutdown|reboot|passwd|user(?:add|del|mod))\b/,  // sudo + destructive subcommand
  /\bchmod\s+(?:777|[0-7]*7[0-7]*7)\b/,  // chmod 777, chmod 757, chmod 737, etc.
  /\bwget\b.*\|\s*(?:sh|bash|zsh|fish)\b/,
  /\bcurl\b.*\|\s*(?:sh|bash|zsh|fish)\b/,
  /\beval\b.*\$[({]/,                   // eval "$(curl ...)" or eval $(...)
  /\bgit\s+push\b[^\n]*\s--force(?:-with-lease)?\b/i,
]

/** Confidence thresholds for sensorium-driven adaptive approval. */
export const CONFIDENCE_THRESHOLDS = {
  /** Above this + risk='none'|'low' → eligible for auto-approve */
  autoApproveConfidence: 0.8,
  /** Below this → risk escalated one level */
  escalateConfidence: 0.3,
} as const

export function assessToolRisk(
  toolName: string,
  input: Record<string, unknown>,
  doomLoopLevel: 'none' | 'warn' | 'blocked' = 'none',
  antibodies: ContextClaim[] = [],
  sensorium?: Sensorium,
): RiskAssessment {
  const reasons: string[] = []
  let level: RiskLevel = 'none'

  // Doom loop check
  if (doomLoopLevel === 'blocked') {
    reasons.push('Agent is in doom loop (repeated identical tool calls)')
    level = 'high'
  } else if (doomLoopLevel === 'warn') {
    reasons.push('Agent may be entering doom loop')
    level = 'medium'
  }

  // Path traversal
  const targets = [input.file_path, input.path, input.target].filter((v): v is string => typeof v === 'string')
  if (targets.some(t => t.startsWith('/') || t.split('/').includes('..'))) {
    reasons.push('absolute path target')
    level = level === 'high' ? 'high' : 'medium'
  }

  // Destructive commands — uses shared pattern list
  if (toolName === 'bash') {
    const cmd = typeof input.command === 'string' ? input.command : ''
    for (const pattern of DANGEROUS_BASH_PATTERNS) {
      if (pattern.test(cmd)) {
        // Distinguish force push for clearer reason
        if (pattern === DANGEROUS_BASH_PATTERNS[DANGEROUS_BASH_PATTERNS.length - 1]) {
          reasons.push('force push can overwrite shared remote history')
        } else {
          reasons.push('destructive shell command')
        }
        level = 'high'
        break
      }
    }
    if (cmd.includes('curl') && cmd.includes('|')) {
      reasons.push('Pipe from network')
      level = level === 'high' ? 'high' : 'medium'
    }
  }

  // Write operations
  if (toolName === 'write_file' || toolName === 'edit_file') {
    level = level === 'none' ? 'low' : level
  }

  // Web fetch URL risk
  if (toolName === 'web_fetch') {
    const url = typeof input.url === 'string' ? input.url : ''
    if (url) {
      try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          reasons.push('non-http URL protocol')
          level = 'high'
        } else if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1') {
          reasons.push('localhost URL target')
          level = level === 'high' ? 'high' : 'medium'
        } else if (isIP(parsed.hostname) > 0) {
          reasons.push('IP literal URL target')
          level = level === 'high' ? 'high' : 'medium'
        }
      } catch {
        reasons.push('malformed URL')
        level = 'medium'
      }
    }
  }

  // Rollback/undo is always high risk
  if (toolName === 'rollback' || toolName === 'undo') {
    reasons.push('state rollback changes working tree')
    level = 'high'
  }

  // MCP tool risk
  const mcpMatch = toolName.match(/^mcp__(.+)__(.+)$/)
  if (mcpMatch) {
    const serverId = mcpMatch[1]!
    reasons.push(`MCP tool from server "${serverId}"`)
    level = level === 'none' ? 'low' : level
    const policy = evaluateMcpPolicy({
      toolName,
      trustedServers: [],
      blockedTools: [],
      allowedTools: [],
      mustConfirmCapabilities: ['write', 'execute'],
    })
    reasons.push(`MCP policy: ${policy.action} (${policy.reason})`)
    if (policy.action === 'block') level = 'high'
    else if (policy.action === 'confirm' || policy.action === 'require') level = level === 'high' ? 'high' : 'medium'
    if (policy.capability === 'write' || policy.capability === 'execute') {
      reasons.push('MCP write-capable tool')
      level = level === 'high' ? 'high' : 'medium'
    }
  }

  // Antibody boost: raise risk if a failure_pattern claim's evidence mentions this tool
  for (const ab of antibodies) {
    const evidenceSummary = ab.evidence[0]?.summary ?? ''
    if (evidenceSummary.includes(toolName)) {
      reasons.push(`antibody match: ${ab.text.slice(0, 60)}`)
      if (level === 'none') level = 'low'
      break
    }
  }

  // ── Sensorium-driven adaptive confidence ──────────────────────
  if (sensorium) {
    if (sensorium.confidence < CONFIDENCE_THRESHOLDS.escalateConfidence) {
      // Low confidence → escalate risk one level (never downgrade)
      if (level === 'none') { level = 'low'; reasons.push('low sensorium confidence (escalated)') }
      else if (level === 'low') { level = 'medium'; reasons.push('low sensorium confidence (escalated)') }
      else if (level === 'medium') { level = 'high'; reasons.push('low sensorium confidence (escalated)') }
      // 'high' stays 'high'
    }
    // Note: confidence > autoApproveConfidence does NOT downgrade here.
    // The auto-approve decision is made downstream in tool-pipeline.ts
    // based on the combination of risk level + confidence.
  }

  const suggestedAction = level === 'high'
    ? 'Require explicit user approval before execution.'
    : level === 'medium'
      ? 'Show risk context and proceed only in auto-safe/manual modes.'
      : 'No additional approval required.'

  return { level, reasons, suggestedAction }
}
