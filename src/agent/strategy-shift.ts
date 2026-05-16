export interface TrajectorySummary {
  tool: string
  target: string
  status: string
  errorClass?: string
}

export function suggestStrategyShift(trajectory: TrajectorySummary[], doomLevel: 'none' | 'warn' | 'blocked'): string | null {
  if (doomLevel === 'none') return null

  const recent = trajectory.slice(-10)

  // Pattern 1: repeated same tool+target failure
  const failCounts = new Map<string, number>()
  for (const e of recent) {
    if (e.status === 'failed') {
      const key = `${e.tool}:${e.target}`
      failCounts.set(key, (failCounts.get(key) ?? 0) + 1)
    }
  }
  for (const [key, count] of failCounts) {
    if (count >= 3) {
      const [tool, ...rest] = key.split(':')
      const target = rest.join(':')
      if (tool === 'edit_file' || tool === 'write_file') {
        return `Strategy shift: ${tool} on ${target} has failed ${count} times. Read the error output carefully, consider whether the edit is targeting the right location, or try a different approach (e.g., read the surrounding code first).`
      }
      return `Strategy shift: ${tool} on ${target} has failed ${count} times. Consider an alternative approach or ask the user for guidance.`
    }
  }

  // Pattern 2: multiple writes without verification
  const writes = recent.filter(e => e.tool === 'edit_file' || e.tool === 'write_file')
  const verifies = recent.filter(e => e.tool === 'bash' || e.tool === 'run_tests')
  if (writes.length >= 4 && verifies.length === 0) {
    return `Strategy shift: ${writes.length} file modifications without any verification. Run tests or read the changed files to validate before continuing.`
  }

  // Pattern 3: transient failures (timeout/network)
  const transients = recent.filter(e => e.status === 'failed' && (e.errorClass === 'timeout' || e.errorClass === 'flaky'))
  if (transients.length >= 2) {
    return `Strategy shift: ${transients[0]!.errorClass} failures detected. Try a different command, reduce scope, or increase timeout instead of repeating the same operation.`
  }

  // Pattern 4: repeated same tool calls (any status)
  const toolCounts = new Map<string, number>()
  for (const e of recent) {
    const key = `${e.tool}:${e.target}`
    toolCounts.set(key, (toolCounts.get(key) ?? 0) + 1)
  }
  for (const [key, count] of toolCounts) {
    if (count >= 3) {
      const [tool, ...rest] = key.split(':')
      const target = rest.join(':')
      return `Strategy shift: Repeated ${tool} on ${target} (${count} times). The current approach may not be working. Step back, re-read the relevant code, and consider a different strategy.`
    }
  }

  // Generic fallback when doom-loop is active but no specific pattern matched
  if (doomLevel === 'blocked') {
    return 'Strategy shift: Doom loop detected. Stop repeating the same actions. Re-read the error output, reconsider the approach, or ask the user for clarification.'
  }

  return null
}
