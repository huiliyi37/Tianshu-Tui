import type { VerificationMetadata } from '../tools/types.js'
import { buildFinalVerificationReport, type VerificationState } from './verification.js'

export type DeliveryVerificationStatus = 'verified' | 'failed' | 'blocked' | 'unverified'

export interface EvidenceState {
  filesRead: Set<string>
  filesModified: Set<string>
  verifications: VerificationMetadata[]
  deliveryStatus: DeliveryVerificationStatus
  impactedFiles: Set<string>
  impactedTests: Set<string>
}

export class EvidenceTracker {
  private state: EvidenceState

  constructor() {
    this.state = {
      filesRead: new Set(),
      filesModified: new Set(),
      verifications: [],
      deliveryStatus: 'unverified',
      impactedFiles: new Set(),
      impactedTests: new Set(),
    }
  }

  trackFileRead(path: string): void {
    this.state.filesRead.add(path)
  }

  trackFileModified(path: string): void {
    this.state.filesModified.add(path)
    this.refreshDeliveryStatus()
  }

  trackVerification(result: VerificationMetadata): void {
    this.state.verifications.push(result)
    this.refreshDeliveryStatus()
  }

  trackImpact(files: string[], tests: string[]): void {
    for (const f of files) this.state.impactedFiles.add(f)
    for (const t of tests) this.state.impactedTests.add(t)
  }

  private refreshDeliveryStatus(): void {
    if (this.state.verifications.some(r => r.status === 'failed')) {
      this.state.deliveryStatus = 'failed'
    } else if (this.state.verifications.some(r => r.status === 'blocked')) {
      this.state.deliveryStatus = 'blocked'
    } else if (this.state.filesModified.size > 0 && this.state.verifications.length === 0) {
      this.state.deliveryStatus = 'unverified'
    } else if (this.state.verifications.some(r => r.status === 'passed')) {
      this.state.deliveryStatus = 'verified'
    } else {
      this.state.deliveryStatus = 'unverified'
    }
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
      for (const f of modified) parts.push(`  - ${f}`)
    }

    const status = this.state.deliveryStatus
    if (status === 'failed') {
      const failedRun = this.state.verifications.find(r => r.status === 'failed')
      parts.push(`- **Verification failed**: ${failedRun?.command ?? ''}`)
    } else if (status === 'blocked') {
      parts.push('- **Verification blocked**')
    } else if (status === 'unverified' && modified.length > 0) {
      parts.push(`- **Unverified changes**: ${modified.join(', ')}`)
    }

    if (this.state.verifications.length > 0 || modified.length > 0) {
      const verification: VerificationState = { runs: this.state.verifications }
      const report = buildFinalVerificationReport({
        modifiedFiles: modified,
        verification,
      })
      parts.push(report)
    }

    if (this.state.impactedFiles.size > 0) {
      parts.push(`- **Impacted files**: ${[...this.state.impactedFiles].join(', ')}`)
    }
    if (this.state.impactedTests.size > 0) {
      parts.push(`- **Tests to verify**: ${[...this.state.impactedTests].join(', ')}`)
    }

    return parts.join('\n')
  }

  reset(): void {
    this.state.filesRead.clear()
    this.state.filesModified.clear()
    this.state.verifications = []
    this.state.deliveryStatus = 'unverified'
    this.state.impactedFiles.clear()
    this.state.impactedTests.clear()
  }

  getState(): EvidenceState { return this.state }
}
