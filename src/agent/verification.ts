import type { VerificationMetadata } from '../tools/types.js'

export interface VerificationState {
  runs: VerificationMetadata[]
}

export function emptyVerificationState(): VerificationState {
  return { runs: [] }
}

export function addVerificationRun(state: VerificationState, run: VerificationMetadata): VerificationState {
  return { runs: [...state.runs, run] }
}

export function summarizeVerification(state: VerificationState): string {
  if (state.runs.length === 0) return 'Tests not run'
  const last = state.runs[state.runs.length - 1]!
  if (last.status === 'blocked') return `Tests blocked: ${last.command}`
  const scope = last.scope === 'targeted' ? 'targeted' : 'full'
  return `${scope} tests ${last.status}: ${last.passed} passed, ${last.failed} failed`
}

export interface FinalVerificationInput {
  modifiedFiles: string[]
  verification: VerificationState
}

export function buildFinalVerificationReport(input: FinalVerificationInput): string {
  const changed = input.modifiedFiles.length > 0
  const last = input.verification.runs[input.verification.runs.length - 1]
  const lines: string[] = ['## Verification']

  if (!last) {
    lines.push('- Verified: none')
    if (changed) lines.push('- Not verified: tests not run after modifications')
    return lines.join('\n')
  }

  if (last.status === 'blocked') {
    lines.push('- Verified: none')
    lines.push(`- Not verified: tests blocked while running ${last.command}`)
    return lines.join('\n')
  }

  lines.push(`- Verified: ${last.scope} tests ${last.status}: ${last.passed} passed, ${last.failed} failed`)
  if (last.scope === 'targeted') {
    lines.push('- Not verified: full suite not run')
  }
  if (last.status === 'failed') {
    lines.push('- Risks: tests are failing')
  }
  return lines.join('\n')
}
