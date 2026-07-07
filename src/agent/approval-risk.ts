import { isIP } from 'node:net'
import { isAbsolute } from 'node:path'
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
/** Force-push detection pattern — used by assessToolRisk for clearer reason text. */
const FORCE_PUSH_PATTERN = /\bgit\s+push\b[^\n]*\s--force(?:-with-lease)?\b/i

// Destructive commands — uses shared pattern list
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
  FORCE_PUSH_PATTERN,                         // force push (reference shared for reason detection)
  /\b(?:shutdown|reboot|halt|poweroff)\b/,                    // system control — disruptive even without sudo
  /\bnpm\s+(?:publish|unpublish)\b/,                          // irreversible registry operations
  /\bxargs\b.*\brm\b/,                                        // mass deletion via xargs pipe
  /\bbase64\b[^\n]*\|\s*(?:sh|bash|zsh|fish)\b/,             // obfuscated execution via base64 decode
]

/**
 * Bash commands with write side effects. These are not always destructive, but
 * they must not be silently auto-approved by sensorium confidence. This is the
 * Phase-1 safety base: deny bash writes by default, then allow explicit
 * user/project/session permission rules to re-enable trusted command shapes.
 */
/**
 * 低风险写命令——在无沙箱环境（Windows 原生）下，auto-safe 模式可自动放行，
 * 避免每次 mkdir/touch/echo>file 都打断用户审批。这些命令的写目标通常是项目内
 * 文件（tool-pipeline 会校验路径在工作区内）。
 */
export const SAFE_WRITE_PATTERNS: ReadonlyArray<Readonly<RegExp>> = [
  /\b(?:mkdir|touch|cp)\b/,                          // create/copy — non-destructive
  /(^|[^<])>>?\s*[^&\s]/,                           // output redirection: echo hi > file
  /\|\s*tee\b/,                                      // pipe writes via tee
  /\bsed\b[^\n]*\s-i(?:\b|\s|['"])/,               // sed -i (in-place edit of existing file)
  /\bperl\b[^\n]*\s-pi(?:\b|\s|['"])/,             // perl -pi
  /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\b/, // package install — non-destructive
  /<<[-']?\w*['"]?/,                                // heredoc start (cat > file <<'EOF')
]

/**
 * 风险写命令——即使无沙箱也需审批（可能丢数据 / 改权限 / 影响版本库）。
 */
export const RISKY_WRITE_PATTERNS: ReadonlyArray<Readonly<RegExp>> = [
  /\b(?:rm|mv|truncate|dd)\b/,                       // delete/move — may lose data
  /\b(?:chmod|chown|chgrp)\b/,                       // permission/ownership mutations
  /\bgit\s+(?:add|commit|checkout|switch|restore|reset|clean|merge|rebase|cherry-pick|push|pull)\b/,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:remove|rm|update|upgrade|dedupe)\b/,
]

/**
 * All write patterns (safe + risky). Used by {@link bashCommandMayWrite} for the
 * "is this a write command at all" check. Kept for backward compat with callers
 * that just need the union (e.g. doom-loop write detection).
 */
export const BASH_WRITE_PATTERNS: ReadonlyArray<Readonly<RegExp>> = [
  ...SAFE_WRITE_PATTERNS,
  ...RISKY_WRITE_PATTERNS,
]

/** Command injection patterns — heredoc abuse, process substitution, shell exploits */
export const INJECTION_PATTERNS: ReadonlyArray<Readonly<RegExp>> = [
  /[<>]\s*\(/,                              // process substitution <(...) or >(...)
  /\bzmodload\b/,                           // zsh module loading
  /\bsysopen\b/,                            // zsh sysopen
  /\bpowershell\s+-enc/i,                   // PowerShell encoded execution
  /\beval\b.*\bexec\b/,                     // eval + exec chain
  /\bsource\b.*\/etc\/|^\.\s+\/etc\//,     // sourcing system config files
  /\benv\b.*\b(?:SHELL|PATH|HOME|LD_PRELOAD|DYLD_INSERT_LIBRARIES)=/, // env var override for privilege escalation
  /\b(?:python|perl|ruby|node)\s+-[ec]\s/, // inline code execution interpreters
  /\bcrontab\b/,                            // cron modification — persistence mechanism
  /\bsystemctl\b.*\b(?:enable|start|stop|restart|mask)\b/, // systemd service manipulation
]

/** Extended destructive commands beyond the base DANGEROUS_BASH_PATTERNS */
export const DESTRUCTIVE_EXTENDED_PATTERNS: ReadonlyArray<Readonly<RegExp>> = [
  /\bdocker\s+(?:rm|rmi)\b/,                // docker container/image removal
  /\bdocker\s+system\s+prune\b/,            // docker system cleanup
  /\bkubectl\s+delete\b/,                   // k8s resource deletion
  /\btruncate\s+-s\s+0\b/,                  // truncate file to zero
  /\bdd\s+if=.*of=\/dev\//,                 // dd writing to device
  /\bmkfs\b/,                               // filesystem formatting
]

/** Sed bypass detection — sed modifying security-critical files */
export const SED_BYPASS_PATTERNS: ReadonlyArray<Readonly<RegExp>> = [
  /\bsed\b.*\b(?:\/etc\/|\.ssh\/|authorized_keys|shadow|passwd)\b/,
]

export function bashCommandMayWrite(command: string): boolean {
  return BASH_WRITE_PATTERNS.some(pattern => pattern.test(command))
}

/**
 * 命令是否只包含安全写（无沙箱时 auto-safe 模式可自动放行）。
 * 命中 RISKY_WRITE_PATTERNS 或 DANGEROUS_BASH_PATTERNS 则返回 false。
 */
export function isSafeWriteOnly(command: string): boolean {
  if (RISKY_WRITE_PATTERNS.some(p => p.test(command))) return false
  if (DANGEROUS_BASH_PATTERNS.some(p => p.test(command))) return false
  return SAFE_WRITE_PATTERNS.some(p => p.test(command))
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

/**
 * Actions whose approval can NEVER be waived — by approval mode (incl.
 * dangerously-skip-permissions), permissions.allow rules, sensorium
 * auto-approve, or per-app grants.
 *
 * computer_use js_eval runs arbitrary JS inside the user's real browser
 * (cookies/localStorage/logged-in sessions); browser_adopt takes over an
 * external DevTools endpoint. The tool's own requiresApproval() already
 * returns true for these, but that is only consulted in manual mode — the
 * "always needs approval" promise must be enforced as a pipeline hard gate.
 */
export function requiresUnconditionalApproval(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName !== 'computer_use') return false
  const action = typeof input.action === 'string' ? input.action : ''
  return action === 'js_eval' || action === 'browser_adopt'
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

  // Arbitrary-JS / endpoint-takeover surface — double insurance alongside the
  // pipeline's unconditional approval gate (auto-safe asks on high risk even
  // if the hard gate were ever bypassed).
  if (requiresUnconditionalApproval(toolName, input)) {
    reasons.push('arbitrary JS in the user browser / DevTools endpoint takeover')
    level = 'high'
  }

  // Doom loop check. blocked is short-circuited by the pipeline early-return,
  // so destructive-git protection must trigger in the warn window too.
  if (doomLoopLevel === 'warn' || doomLoopLevel === 'blocked') {
    if (isDestructiveGitAction(toolName, input)) {
      reasons.push('保护模式：工具失败率高，破坏性动作需确认')
      level = 'high'
    } else {
      reasons.push(doomLoopLevel === 'blocked' ? 'Agent is in doom loop (repeated identical tool calls)' : 'Agent may be entering doom loop')
      if (level === 'none') level = 'medium'
    }
  }

  // Path traversal
  const targets = [input.file_path, input.path, input.target].filter((v): v is string => typeof v === 'string')
  // Absolute (incl. Windows `C:\`) or any `..` traversal segment (either separator).
  if (targets.some(t => isAbsolute(t) || /(^|[\\/])\.\.([\\/]|$)/.test(t))) {
    reasons.push('absolute path target')
    level = level === 'high' ? 'high' : 'medium'
  }

  // Destructive commands — uses shared pattern list
  if (toolName === 'bash') {
    const cmd = typeof input.command === 'string' ? input.command : ''
    for (const pattern of DANGEROUS_BASH_PATTERNS) {
      if (pattern.test(cmd)) {
        // Distinguish force push for clearer reason
        if (pattern === FORCE_PUSH_PATTERN) {
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
    // Command injection detection
    for (const p of INJECTION_PATTERNS) {
      if (p.test(cmd)) {
        reasons.push(`command injection pattern: ${p.source}`)
        level = 'high'
        break
      }
    }
    // Extended destructive command detection
    for (const p of DESTRUCTIVE_EXTENDED_PATTERNS) {
      if (p.test(cmd)) {
        reasons.push(`extended destructive command: ${p.source}`)
        level = level === 'high' ? 'high' : 'medium'
        break
      }
    }
    // Sed bypass on security-critical files
    for (const p of SED_BYPASS_PATTERNS) {
      if (p.test(cmd)) {
        reasons.push('sed bypass on security-critical file')
        level = 'high'
        break
      }
    }
  }

  // Sandbox execution: code runs in Node.js child process with full fs/net/child_process
  // access. Despite the "sandbox" name, this is NOT isolated — treat as arbitrary code execution.
  if (toolName === 'sandbox_exec') {
    reasons.push('arbitrary JavaScript execution — full Node.js process with fs/net/child_process access')
    level = 'high'
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
