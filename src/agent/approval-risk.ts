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

/**
 * Bash commands with write side effects. These are not always destructive, but
 * they must not be silently auto-approved by sensorium confidence. This is the
 * Phase-1 safety base: deny bash writes by default, then allow explicit
 * user/project/session permission rules to re-enable trusted command shapes.
 */
export const BASH_WRITE_PATTERNS: ReadonlyArray<Readonly<RegExp>> = [
  /(^|[^<])>>?\s*[^&\s]/,                         // shell output redirection: echo hi > file
  /\|\s*tee\b/,                                    // pipe writes via tee
  /\b(?:rm|mv|cp|mkdir|touch|truncate|dd)\b/,       // filesystem mutations
  /\bsed\b[^\n]*\s-i(?:\b|\s|['"])/,              // sed -i
  /\bperl\b[^\n]*\s-pi(?:\b|\s|['"])/,            // perl -pi
  /\b(?:chmod|chown|chgrp)\b/,                      // permission/ownership mutations
  /\bgit\s+(?:add|commit|checkout|switch|restore|reset|clean|merge|rebase|cherry-pick|push|pull)\b/,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|remove|rm|update|upgrade|dedupe)\b/,
  /<<[-']?\w*['"]?/,                                // heredoc start (cat > file <<'EOF')
]

export function bashCommandMayWrite(command: string): boolean {
  return BASH_WRITE_PATTERNS.some(pattern => pattern.test(command))
}

/** Detect scope-bypassing bash git commands (unscoped add/commit/stash). */
const GIT_BYPASS_PATTERNS: ReadonlyArray<RegExp> = [
  /\bgit\s+add\s+(?:-A\b|--all\b|\.(?:\s|$))/,        // git add -A / --all / .
  /\bgit\s+commit\s+[^\n]*-[a-z]*a/,                  // git commit -a / -am
  /\bgit\s+stash\s*$/,                                 // bare git stash (no pathspec)
  /\bgit\s+stash\s+(?:push\s*)?$/,                     // git stash push (no --)
]

export function bashGitBypassesScope(command: string): boolean {
  return GIT_BYPASS_PATTERNS.some(p => p.test(command.trim()))
}

/** Destructive git actions that can wipe working-tree changes — the panic targets. */
export function isDestructiveGitAction(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName === 'git') {
    const action = input.action as string
    return action === 'stash' || action === 'stash_pop'
  }
  // bash path already caught by BASH_WRITE_PATTERNS; listed here for explicit protection-mode gating
  if (toolName === 'bash') {
    const cmd = typeof input.command === 'string' ? input.command : ''
    return /\bgit\s+(?:stash\b|checkout\s|restore\b|reset\b|rm\s)/.test(cmd)
  }
  return false
}

export function requiresBashWriteApproval(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName !== 'bash') return false
  const command = typeof input.command === 'string' ? input.command : ''
  return bashCommandMayWrite(command)
}

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

  // Doom loop check — only escalate destructive git to 'high'; others stay at
  // their natural risk level so read-only tools aren't blocked.
  if (doomLoopLevel === 'blocked') {
    if (isDestructiveGitAction(toolName, input)) {
      reasons.push('保护模式：工具失败率高，破坏性动作需确认')
      level = 'high'
    } else {
      reasons.push('Agent is in doom loop (repeated identical tool calls)')
      if (level === 'none') level = 'medium'
    }
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
    if (bashCommandMayWrite(cmd)) {
      reasons.push('bash command may write to filesystem, package state, or git state')
      if (level === 'none') level = 'medium'
    }
    if (bashGitBypassesScope(cmd)) {
      reasons.push('unscoped git command bypasses scope — use deliver_task or git tool with ownedFiles instead')
      level = 'high'
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
