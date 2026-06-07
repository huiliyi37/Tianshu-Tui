/**
 * SessionState — ephemeral per-session awareness tracker.
 *
 * NOT canonical memory. NOT persisted across sessions.
 * Lives in the dynamic appendix of the volatile block (changes every turn).
 *
 * Design goals:
 * - Give the model cross-turn awareness of what files it touched
 * - Track verification status without re-reading context
 * - Keep renderForVolatile() output under 500 chars for cache efficiency
 */

export interface FileEntry {
  lastRead: number
  artifactId: string
  modifiedByMe: boolean
}

export interface DecisionEntry {
  decision: string
  reason: string
  turn: number
}

export interface VerificationEntry {
  target: string
  status: 'passed' | 'failed' | 'not-run'
  verifiedAt: number
}

export interface FactEntry {
  fact: string
  evidence: string
  verifiedAt: number
}

export interface SessionState {
  version: 1
  sessionId: string
  updatedAt: number
  task: {
    objective: string
    status: 'exploring' | 'planning' | 'executing' | 'verifying' | 'delivered' | 'blocked'
    plan?: string[]
    currentStep?: number
  }
  knownFacts: FactEntry[]
  decisions: DecisionEntry[]
  fileIndex: Record<string, FileEntry>
  verification: VerificationEntry[]
}

const MAX_DECISIONS = 20
const MAX_VERIFICATIONS = 30
const MAX_FACTS = 15
const VOLATILE_MAX_CHARS = 500

export class SessionStateManager {
  private state: SessionState

  constructor(sessionId: string) {
    this.state = {
      version: 1,
      sessionId,
      updatedAt: Date.now(),
      task: { objective: '', status: 'exploring' },
      knownFacts: [],
      decisions: [],
      fileIndex: {},
      verification: [],
    }
  }

  getSnapshot(): Readonly<SessionState> {
    // Return a frozen deep copy so callers cannot accidentally mutate
    // internal state (violates immutability invariant for snapshots).
    return JSON.parse(JSON.stringify(this.state)) as SessionState
  }

  // ---------------------------------------------------------------------------
  // Mutators
  // ---------------------------------------------------------------------------

  updateTask(
    objective: string,
    status: SessionState['task']['status'],
    plan?: string[],
    currentStep?: number,
  ): void {
    this.state.task = { objective, status, plan, currentStep }
    this.state.updatedAt = Date.now()
  }

  trackFileRead(path: string, artifactId: string): void {
    this.state.fileIndex[path] = {
      lastRead: Date.now(),
      artifactId,
      modifiedByMe: this.state.fileIndex[path]?.modifiedByMe ?? false,
    }
    this.state.updatedAt = Date.now()
  }

  trackFileModified(path: string): void {
    const existing = this.state.fileIndex[path]
    this.state.fileIndex[path] = {
      lastRead: existing?.lastRead ?? Date.now(),
      artifactId: existing?.artifactId ?? '',
      modifiedByMe: true,
    }
    this.state.updatedAt = Date.now()
  }

  recordDecision(decision: string, reason: string, turn: number): void {
    this.state.decisions.push({ decision, reason, turn })
    if (this.state.decisions.length > MAX_DECISIONS) {
      this.state.decisions = this.state.decisions.slice(-MAX_DECISIONS)
    }
    this.state.updatedAt = Date.now()
  }

  recordVerification(target: string, status: 'passed' | 'failed' | 'not-run'): void {
    const idx = this.state.verification.findIndex(v => v.target === target)
    const entry: VerificationEntry = { target, status, verifiedAt: Date.now() }
    if (idx >= 0) {
      this.state.verification[idx] = entry
    } else {
      this.state.verification.push(entry)
    }
    if (this.state.verification.length > MAX_VERIFICATIONS) {
      this.state.verification = this.state.verification.slice(-MAX_VERIFICATIONS)
    }
    this.state.updatedAt = Date.now()
  }

  recordFact(fact: string, evidence: string): void {
    this.state.knownFacts.push({ fact, evidence, verifiedAt: Date.now() })
    if (this.state.knownFacts.length > MAX_FACTS) {
      this.state.knownFacts = this.state.knownFacts.slice(-MAX_FACTS)
    }
    this.state.updatedAt = Date.now()
  }

  // ---------------------------------------------------------------------------
  // Rendering — compact text for dynamic appendix injection
  // ---------------------------------------------------------------------------

  /** Render compact XML block for volatile block injection. Target: <500 chars. */
  renderForVolatile(): string {
    const s = this.state
    const lines: string[] = ['<session-state>']

    if (s.task.objective) {
      lines.push(`Task: ${s.task.objective} [${s.task.status}]`)
      if (s.task.plan && s.task.currentStep !== undefined) {
        lines.push(
          `Plan: step ${s.task.currentStep + 1}/${s.task.plan.length} — ${s.task.plan[s.task.currentStep] ?? ''}`,
        )
      }
    }

    const modifiedFiles = Object.entries(s.fileIndex)
      .filter(([, v]) => v.modifiedByMe)
      .map(([k]) => k)
    if (modifiedFiles.length > 0) {
      lines.push(`Modified: ${modifiedFiles.slice(0, 10).join(', ')}`)
    }

    if (s.decisions.length > 0) {
      lines.push('Decisions:')
      for (const d of s.decisions.slice(-5)) {
        lines.push(`  - ${d.decision}`)
      }
    }

    const failedTests = s.verification.filter(v => v.status === 'failed')
    if (failedTests.length > 0) {
      lines.push(`Failed: ${failedTests.map(v => v.target).join(', ')}`)
    }

    lines.push('</session-state>')
    let result = lines.join('\n')

    // Diffusion-aware truncation: keep under VOLATILE_MAX_CHARS
    if (result.length > VOLATILE_MAX_CHARS) {
      // Trim decision list first
      const closing = '\n</session-state>'
      const header = result.slice(0, result.indexOf('Decisions:'))
      if (header) {
        result = header.trimEnd() + closing
      }
      // If still too long, truncate with ellipsis
      if (result.length > VOLATILE_MAX_CHARS) {
        const maxContent = VOLATILE_MAX_CHARS - closing.length - 3 // '...'
        result = result.slice(0, maxContent) + '...' + closing
      }
    }

    return result
  }
}
