import { isIP } from 'node:net'

export type RiskLevel = 'none' | 'low' | 'medium' | 'high'

export interface RiskAssessment {
  level: RiskLevel
  reasons: string[]
  suggestedAction: string
}

export function assessToolRisk(
  toolName: string,
  input: Record<string, unknown>,
  doomLoopLevel: 'none' | 'warn' | 'blocked' = 'none',
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

  // Destructive commands
  if (toolName === 'bash') {
    const cmd = typeof input.command === 'string' ? input.command : ''
    const destructive = /\b(rm\s+-|git\s+reset\s+--hard|git\s+clean\s+-|killall|pkill|drop\s+table)\b/i
    const forcePush = /\bgit\s+push\b[^\n]*\s--force(?:-with-lease)?\b/i
    if (destructive.test(cmd)) {
      reasons.push('destructive shell command')
      level = 'high'
    }
    if (forcePush.test(cmd)) {
      reasons.push('force push can overwrite shared remote history')
      level = 'high'
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

  const suggestedAction = level === 'high'
    ? 'Require explicit user approval before execution.'
    : level === 'medium'
      ? 'Show risk context and proceed only in auto-safe/manual modes.'
      : 'No additional approval required.'

  return { level, reasons, suggestedAction }
}
