import type { VerificationMetadata } from '../tools/types.js'
import { buildFinalVerificationReport, type VerificationState } from './verification.js'

export interface EvidenceState {
  filesRead: Set<string>
  filesModified: Set<string>
  verifications: VerificationMetadata[]
}

export class EvidenceTracker {
  private state: EvidenceState

  constructor() {
    this.state = {
      filesRead: new Set(),
      filesModified: new Set(),
      verifications: [],
    }
  }

  trackFileRead(path: string): void {
    this.state.filesRead.add(path)
  }

  trackFileModified(path: string): void {
    this.state.filesModified.add(path)
  }

  trackVerification(result: VerificationMetadata): void {
    this.state.verifications.push(result)
  }

  buildBadge(): string | null {
    const read = [...this.state.filesRead].sort()
    const modified = [...this.state.filesModified].sort()

    if (read.length + modified.length === 0 && this.state.verifications.length === 0) {
      return null
    }

    const parts: string[] = ['---', '## Evidence']

    if (read.length > 0) {
      parts.push(`- Files read: ${read.length}`)
    }
    if (modified.length > 0) {
      parts.push(`- Files modified: ${modified.length}`)
    }

    if (this.state.verifications.length > 0 || modified.length > 0) {
      const verification: VerificationState = { runs: this.state.verifications }
      const report = buildFinalVerificationReport({
        modifiedFiles: modified,
        verification,
      })
      parts.push(report)
    }

    return parts.join('\n')
  }

  reset(): void {
    this.state.filesRead.clear()
    this.state.filesModified.clear()
    this.state.verifications = []
  }
}
