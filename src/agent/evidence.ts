import type { VerificationMetadata } from '../tools/types.js'
import { buildDeliveryGate } from './delivery-gate.js'

export type DeliveryVerificationStatus = 'verified' | 'failed' | 'blocked' | 'unverified'
export type VerificationLevel = 'tested' | 'typed' | 'linted' | 'pending'

/**
 * Gate state for the TDD gate. Consumed by evaluateTddGate to decide whether
 * an edit should be allowed, suggested-against, or blocked.
 */
export interface TddGateState {
  /** Count of distinct files modified by edit/write tools since last reset. */
  filesModified: number
  /** Number of test-command verifications recorded since last reset. */
  verifications: number
  /** Edits since the most recent test run (resets to 0 on any trackVerification). */
  editsSinceLastTest: number
  /** Whether any verification ended in failure. */
  hasFailedTests: boolean
  /** Whether any of the modified files is a code file (vs. docs/config only).
   *  When false, the TDD gate skips entirely — no constraint on doc-only edits. */
  hasCodeEdits: boolean
  /** Whether the agent has read any test files (.test./.spec./__tests__).
   *  Used by skipIfNoTests: if no test files exist in the project, don't block. */
  hasReadTestFiles: boolean
}

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

export interface EvidenceSummary {
  filesRead: string[]
  filesModified: string[]
  verificationStatus: DeliveryVerificationStatus
  verifications: VerificationMetadata[]
  gate: {
    state: 'GREEN' | 'YELLOW' | 'RED' | 'ok' | 'warn' | 'error'
    label: string
    reason?: string
    blockingReason?: string
    nextAction?: string
  }
  impactedFiles: string[]
  impactedTests: string[]
}

export type EvidenceLocale = 'zh-CN' | 'en'

const MAX_VERIFICATIONS = 50

/** Code file extensions whose edits should count toward the TDD gate.
 *  Config files (.yml/.yaml/.toml/.json/.ini/.env) are excluded — they don't
 *  need test coverage and counting them caused false gate triggers. */
const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rs', '.go', '.java', '.kt', '.scala',
  '.c', '.cpp', '.cc', '.h', '.hpp',
  '.rb', '.swift', '.vue', '.svelte',
  '.sh', '.bash', '.zsh',
  '.sql', '.graphql',
  '.css', '.scss', '.less',
])

function isCodeFile(path: string): boolean {
  const ext = path.slice(path.lastIndexOf('.'))
  return CODE_EXTENSIONS.has(ext)
}

export interface EvidenceTrackerPublic {
  trackFileRead(path: string): void
  trackFileModified(path: string): void
  trackImpact(files: string[], tests: string[]): void
  trackVerification(result: VerificationMetadata): void
  getState(): EvidenceState
  getVerificationSummary(): VerificationSummary
  getGateState(): TddGateState
  buildSummary(gateV2?: AuthoritativeGateView): EvidenceSummary
  buildBadge(options?: { locale?: EvidenceLocale; gateV2?: AuthoritativeGateView }): string | null
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

const UI_LABELS: Record<EvidenceLocale, {
  evidence: string
  filesRead: string
  filesModified: string
  deliveryGate: string
  blocking: string
  nextAction: string
  impactedFiles: string
  testsToVerify: string
  verification: string
  verified: string
  failed: string
  blocked: string
  unverified: string
  verificationFailed: string
  verificationBlocked: string
  unverifiedChanges: string
  testsNotRun: string
  targeted: string
  full: string
  passed: string
}> = {
  'zh-CN': {
    evidence: '任务完成总结',
    filesRead: '读取文件',
    filesModified: '改动文件',
    deliveryGate: '交付门禁',
    blocking: '阻塞原因',
    nextAction: '建议下一步',
    impactedFiles: '影响文件',
    testsToVerify: '待验证测试',
    verification: '验证结果',
    verified: '已通过',
    failed: '失败',
    blocked: '被阻塞',
    unverified: '未验证',
    verificationFailed: '验证失败',
    verificationBlocked: '验证被阻塞',
    unverifiedChanges: '未经验证的改动',
    testsNotRun: '未运行测试',
    targeted: '定向',
    full: '全量',
    passed: '通过',
  },
  en: {
    evidence: 'Evidence',
    filesRead: 'Files read',
    filesModified: 'Files modified',
    deliveryGate: 'Delivery gate',
    blocking: 'Blocking',
    nextAction: 'Next action',
    impactedFiles: 'Impacted files',
    testsToVerify: 'Tests to verify',
    verification: 'Verification',
    verified: 'verified',
    failed: 'failed',
    blocked: 'blocked',
    unverified: 'unverified',
    verificationFailed: 'Verification failed',
    verificationBlocked: 'Verification blocked',
    unverifiedChanges: 'Unverified changes',
    testsNotRun: 'Tests not run',
    targeted: 'targeted',
    full: 'full',
    passed: 'passed',
  },
}

export class EvidenceTracker implements EvidenceTrackerPublic {
  private state: EvidenceState
  /**
   * Consecutive edits since the most recent test run. Incremented on every
   * trackFileModified of a code file; skipped for docs/config/etc.
   * Reset to 0 on trackVerification. Drives the TDD gate (evaluateTddGate) —
   * after 3 unverified edits, the gate hard-blocks.
   */
  #editsSinceLastTest = 0
  /** Whether any modified file is a code file (vs. docs/config only). */
  #hasCodeEdits = false

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
    // Only code-file edits drive the TDD gate counter. Docs, configs, plans,
    // and other non-code files are excluded so the gate doesn't block pure
    // documentation work (which has no tests to run).
    if (isCodeFile(path)) {
      this.#editsSinceLastTest++
      this.#hasCodeEdits = true
    }
    this.refreshDeliveryStatus()
  }

  trackVerification(result: VerificationMetadata): void {
    this.state.verifications.push(result)
    if (this.state.verifications.length > MAX_VERIFICATIONS) {
      this.state.verifications = this.state.verifications.slice(-MAX_VERIFICATIONS)
    }
    // TDD gate: any test run (pass, fail, or blocked) resets the consecutive-edit counter.
    // The gate targets zero-verification editing, not test-pass enforcement.
    this.#editsSinceLastTest = 0
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

  /** Gate state for the TDD gate — pure-values snapshot, no Set refs. */
  getGateState(): TddGateState {
    return {
      filesModified: this.state.filesModified.size,
      verifications: this.state.verifications.length,
      editsSinceLastTest: this.#editsSinceLastTest,
      hasFailedTests: this.state.verifications.some(v => v.status === 'failed'),
      hasCodeEdits: this.#hasCodeEdits,
      hasReadTestFiles: [...this.state.filesRead].some(p => /\.test\.|\.spec\.|__tests__|_test\.|test_/.test(p)),
    }
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

  buildSummary(gateV2?: AuthoritativeGateView): EvidenceSummary {
    const read = [...this.state.filesRead].sort()
    const modified = [...this.state.filesModified].sort()

    let gateState: EvidenceSummary['gate']['state']
    let gateLabel: string
    let gateReason: string | undefined
    let gateBlockingReason: string | undefined
    let gateNextAction: string | undefined

    if (gateV2) {
      gateState = gateV2.state
      gateLabel = gateV2.state
      gateReason = gateV2.reason
      gateBlockingReason = gateV2.blockingReason
      gateNextAction = gateV2.shortestNextStep
    } else {
      const gate = buildDeliveryGate(this.state)
      gateState = gate.severity
      gateLabel = gate.message
      gateBlockingReason = gate.blockingReason
      gateNextAction = gate.nextAction
    }

    return {
      filesRead: read,
      filesModified: modified,
      verificationStatus: this.state.deliveryStatus,
      verifications: [...this.state.verifications],
      gate: {
        state: gateState,
        label: gateLabel,
        reason: gateReason,
        blockingReason: gateBlockingReason,
        nextAction: gateNextAction,
      },
      impactedFiles: [...this.state.impactedFiles].sort(),
      impactedTests: [...this.state.impactedTests].sort(),
    }
  }

  buildBadge(options?: { locale?: EvidenceLocale; gateV2?: AuthoritativeGateView }): string | null {
    const locale = options?.locale ?? 'en'
    const gateV2 = options?.gateV2
    const summary = this.buildSummary(gateV2)
    const L = UI_LABELS[locale]

    if (summary.filesRead.length + summary.filesModified.length === 0 && summary.verifications.length === 0) {
      return null
    }

    const parts: string[] = ['---', `## ${L.evidence}`]

    if (summary.filesRead.length > 0) {
      parts.push(`- ${L.filesRead}：${summary.filesRead.length}`)
    }
    if (summary.filesModified.length > 0) {
      parts.push(`- ${L.filesModified}：${summary.filesModified.length}`)
      for (const f of summary.filesModified) parts.push(`  - ${f}`)
    }

    if (gateV2) {
      if (summary.filesModified.length > 0 || gateV2.state !== 'GREEN') {
        parts.push(`- **${L.deliveryGate}**：${gateV2.state}${gateV2.reason ? ` — ${gateV2.reason}` : ''}`)
        if (gateV2.state === 'RED' && gateV2.blockingReason) {
          parts.push(`- **${L.blocking}**：${gateV2.blockingReason}`)
        }
        if (gateV2.shortestNextStep) {
          parts.push(`- **${L.nextAction}**：${gateV2.shortestNextStep}`)
        }
      }
    } else {
      const status = summary.verificationStatus
      if (status === 'failed') {
        const failedRun = summary.verifications.find(r => r.status === 'failed')
        parts.push(`- **${L.verificationFailed}**：${failedRun?.command ?? ''}`)
      } else if (status === 'blocked') {
        parts.push(`- **${L.verificationBlocked}**`)
      } else if (status === 'unverified' && summary.filesModified.length > 0) {
        parts.push(`- **${L.unverifiedChanges}**：${summary.filesModified.join(', ')}`)
      }

      if (summary.filesModified.length > 0) {
        parts.push(`- **${L.deliveryGate}**：${summary.gate.label}`)
        if (summary.gate.nextAction) parts.push(`- **${L.nextAction}**：${summary.gate.nextAction}`)
      }
    }

    if (summary.verifications.length > 0 || summary.filesModified.length > 0) {
      parts.push(`## ${L.verification}`)
      const last = summary.verifications[summary.verifications.length - 1]
      if (!last) {
        parts.push(`- ${L.testsNotRun}`)
      } else if (last.status === 'blocked') {
        parts.push(`- ${L.testsNotRun}：${last.command}`)
      } else {
        const scope = last.scope === 'targeted' ? L.targeted : L.full
        parts.push(`- ${scope}${L.verification}：${last.passed} ${L.passed} / ${last.failed} ${L.failed}`)
      }
    }

    if (summary.impactedFiles.length > 0) {
      parts.push(`- **${L.impactedFiles}**：${summary.impactedFiles.join(', ')}`)
    }
    if (summary.impactedTests.length > 0) {
      parts.push(`- **${L.testsToVerify}**：${summary.impactedTests.join(', ')}`)
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
    this.#editsSinceLastTest = 0
    this.#hasCodeEdits = false
  }

  getState(): EvidenceState { return this.state }
}
