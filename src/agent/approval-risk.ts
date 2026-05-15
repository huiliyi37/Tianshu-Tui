export type RiskLevel = 'none' | 'low' | 'medium' | 'high'

export interface RiskAssessment {
  level: RiskLevel
  reasons: string[]
}

export function assessToolRisk(
  toolName: string,
  input: Record<string, unknown>,
  doomLoopLevel: 'none' | 'warn' | 'blocked',
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
    reasons.push('Path traversal risk')
    level = level === 'high' ? 'high' : 'medium'
  }

  // Destructive commands
  if (toolName === 'bash') {
    const cmd = typeof input.command === 'string' ? input.command : ''
    const destructive = /\b(rm\s+-|git\s+reset\s+--hard|git\s+clean\s+-|push\s+--force|killall|pkill|drop\s+table)\b/i
    if (destructive.test(cmd)) {
      reasons.push('Destructive command detected')
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

  // Rollback is always high risk
  if (toolName === 'rollback') {
    reasons.push('Rollback operation')
    level = 'high'
  }

  return { level, reasons }
}
