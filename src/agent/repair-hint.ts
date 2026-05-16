const HINT_THRESHOLD = 2
const EXHAUSTION_LIMIT = 4

const HINT_TEMPLATES: Record<string, string> = {
  type_error: 'Ensure all parameters match the expected types exactly.',
  assertion: 'Verify the target content exists before attempting modification.',
  timeout: 'Use shorter commands or break into smaller operations.',
  missing_dep: 'Check that required imports and dependencies are available.',
}

export class RepairHintTracker {
  private failures = new Map<string, { type: string; count: number }>()

  recordFailure(toolName: string, failureType: string): void {
    const prev = this.failures.get(toolName)
    if (prev && prev.type === failureType) {
      prev.count++
    } else {
      this.failures.set(toolName, { type: failureType, count: 1 })
    }
  }

  recordSuccess(toolName: string): void {
    this.failures.delete(toolName)
  }

  getHint(): string | null {
    for (const [toolName, { type, count }] of this.failures) {
      if (count >= EXHAUSTION_LIMIT) return null
      if (count >= HINT_THRESHOLD) {
        const template = HINT_TEMPLATES[type] ?? `Avoid repeating the same ${type} error.`
        return `<repair-hint tool="${toolName}">${template}</repair-hint>`
      }
    }
    return null
  }

  reset(): void {
    this.failures.clear()
  }
}
