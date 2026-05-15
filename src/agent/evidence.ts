export interface EvidenceState {
  filesRead: Set<string>
  filesModified: Set<string>
  testResults: Array<{ passed: number; failed: number }>
}

export class EvidenceTracker {
  private state: EvidenceState

  constructor() {
    this.state = {
      filesRead: new Set(),
      filesModified: new Set(),
      testResults: [],
    }
  }

  trackFileRead(path: string): void {
    this.state.filesRead.add(path)
  }

  trackFileModified(path: string): void {
    this.state.filesModified.add(path)
  }

  trackTestResult(passed: number, failed: number): void {
    this.state.testResults.push({ passed, failed })
  }

  buildBadge(): string | null {
    const read = [...this.state.filesRead].sort()
    const modified = [...this.state.filesModified].sort()
    const totalPassed = this.state.testResults.reduce((s, r) => s + r.passed, 0)
    const totalFailed = this.state.testResults.reduce((s, r) => s + r.failed, 0)

    if (read.length + modified.length === 0 && totalPassed + totalFailed === 0) {
      return null
    }

    const parts: string[] = ['---', '## Evidence']

    if (read.length > 0) {
      parts.push(`- Files read: ${read.length}`)
    }
    if (modified.length > 0) {
      parts.push(`- Files modified: ${modified.length}`)
    }
    if (totalPassed + totalFailed > 0) {
      const icon = totalFailed === 0 ? '✅' : '❌'
      parts.push(`- Tests: ${icon} ${totalPassed} passed, ${totalFailed} failed`)
    }

    const unverified: string[] = []
    if (modified.length > 0 && totalPassed + totalFailed === 0) {
      unverified.push('tests not run after modifications')
    }
    if (unverified.length > 0) {
      parts.push(`- Unverified: ${unverified.join(', ')}`)
    }

    return parts.join('\n')
  }

  reset(): void {
    this.state.filesRead.clear()
    this.state.filesModified.clear()
    this.state.testResults = []
  }
}
