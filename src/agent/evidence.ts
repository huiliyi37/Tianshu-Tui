import type { VerificationMetadata } from '../tools/types.js'
import { buildDeliveryGate } from './delivery-gate.js'
import { buildFinalVerificationReport, type VerificationState } from './verification.js'

export type DeliveryVerificationStatus = 'verified' | 'failed' | 'blocked' | 'unverified'
export type VerificationLevel = 'tested' | 'typed' | 'linted' | 'pending'

export interface EvidenceState {
  filesRead: Set<string>
  filesModified: Set<string>
  verifications: VerificationMetadata[]
  deliveryStatus: DeliveryVerificationStatus
  impactedFiles: Set<string>
  impactedTests: Set<string>
  fileVerificationLevels?: Map<string, VerificationLevel>
}

export interface VerificationSummary {
  total: number
  verified: number
  pending: number
  files: Array<{ path: string; level: VerificationLevel }>
}

const MAX_VERIFICATIONS = 50

export interface EvidenceTrackerPublic {
  trackFileRead(path: string): void
  trackFileModified(path: string): void
  trackImpact(files: string[], tests: string[]): void
  trackVerification(result: VerificationMetadata): void
  getState(): EvidenceState
  getVerificationSummary(): VerificationSummary
  buildBadge(gateV2?: AuthoritativeGateView): string | null
  reset(): void
}

/** Track 3: 权威门禁视图（delivery-gate-v2 的最小投影）。注入时 badge 的
 *  门禁行以 v2 GREEN/YELLOW/RED 为准，替代 v1 的 EvidenceState 推导。 */
export interface AuthoritativeGateView {
  state: 'GREEN' | 'YELLOW' | 'RED'
  reason?: string
  blockingReason?: string
  shortestNextStep?: string
}

export class EvidenceTracker implements EvidenceTrackerPublic {
  private state: EvidenceState

  constructor() {
    this.state = {
      filesRead: new Set(),
      filesModified: new Set(),
      verifications: [],
      deliveryStatus: 'unverified',
      impactedFiles: new Set(),
      impactedTests: new Set(),
      fileVerificationLevels: new Map(),
    }
  }

  trackFileRead(path: string): void {
    this.state.filesRead.add(path)
  }

  trackFileModified(path: string): void {
    this.state.filesModified.add(path)
    this.state.fileVerificationLevels?.set(path, 'pending')
    this.refreshDeliveryStatus()
  }

  trackVerification(result: VerificationMetadata): void {
    this.state.verifications.push(result)
    if (this.state.verifications.length > MAX_VERIFICATIONS) {
      this.state.verifications = this.state.verifications.slice(-MAX_VERIFICATIONS)
    }
    this.applyVerificationLevels(result)
    this.refreshDeliveryStatus()
  }

  trackImpact(files: string[], tests: string[]): void {
    for (const f of files) this.state.impactedFiles.add(f)
    for (const t of tests) this.state.impactedTests.add(t)
  }

  getVerificationSummary(): VerificationSummary {
    const files = [...this.state.filesModified]
      .sort((a, b) => a.localeCompare(b))
      .map(path => ({ path, level: this.state.fileVerificationLevels?.get(path) ?? 'pending' }))
    const verified = files.filter(f => f.level !== 'pending').length
    return { total: files.length, verified, pending: files.length - verified, files }
  }

  private applyVerificationLevels(result: VerificationMetadata): void {
    if (result.status !== 'passed') return
    const level = this.inferVerificationLevel(result.command)
    const targets = this.inferVerifiedFiles(result.command, level)
    for (const file of targets) {
      if (this.state.filesModified.has(file)) {
        this.state.fileVerificationLevels?.set(file, level)
      }
    }
  }

  private inferVerificationLevel(command: string): VerificationLevel {
    if (/\\btsc\\b|typecheck|--noEmit/.test(command)) return 'typed'
    if (/\\blint\\b|eslint/.test(command)) return 'linted'
    return 'tested'
  }

  private inferVerifiedFiles(command: string, level: VerificationLevel): string[] {
    const modified = [...this.state.filesModified]
    if (level === 'typed') return modified.filter(f => /\.tsx?$/.test(f))
    if (level === 'linted') return modified
    if (command.includes('src/**/__tests__') || command.includes('npm test') || command.includes('run_tests')) return modified
    const normalizedCommand = command.replaceAll('\\\\', '/')
    return modified.filter(file => {
      const normalizedFile = file.replaceAll('\\\\', '/')
      const base = normalizedFile.split('/').pop() ?? normalizedFile
      const stem = base.replace(/\.[^.]+$/, '')
      return normalizedCommand.includes(normalizedFile) || normalizedCommand.includes(base) || normalizedCommand.includes(stem)
    })
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

  buildBadge(gateV2?: AuthoritativeGateView): string | null {
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

    if (gateV2) {
      // Track 3 合一：v2 为权威 — 门禁行直接呈现 GREEN/YELLOW/RED。
      if (modified.length > 0 || gateV2.state !== 'GREEN') {
        parts.push(`- **Delivery gate**: ${gateV2.state}${gateV2.reason ? ` — ${gateV2.reason}` : ''}`)
        if (gateV2.state === 'RED' && gateV2.blockingReason) {
          parts.push(`- **Blocking**: ${gateV2.blockingReason}`)
        }
        if (gateV2.shortestNextStep) {
          parts.push(`- **Next action**: ${gateV2.shortestNextStep}`)
        }
      }
    } else {
      const gate = buildDeliveryGate(this.state)
      const status = gate.status
      if (status === 'failed') {
        const failedRun = this.state.verifications.find(r => r.status === 'failed')
        parts.push(`- **Verification failed**: ${failedRun?.command ?? ''}`)
      } else if (status === 'blocked') {
        parts.push('- **Verification blocked**')
      } else if (status === 'unverified' && modified.length > 0) {
        parts.push(`- **Unverified changes**: ${modified.join(', ')}`)
      }

      if (modified.length > 0) {
        parts.push(`- **Delivery gate**: ${gate.message}`)
        if (gate.nextAction) parts.push(`- **Next action**: ${gate.nextAction}`)
      }
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
    this.state.fileVerificationLevels?.clear()
  }

  getState(): EvidenceState { return this.state }
}
