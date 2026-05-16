import type { EvidenceState, DeliveryVerificationStatus } from './evidence.js'

export type DeliveryGateSeverity = 'ok' | 'warn' | 'error'

export interface DeliveryGateResult {
  status: DeliveryVerificationStatus
  severity: DeliveryGateSeverity
  canClaimComplete: boolean
  message: string
  blockingReason?: string
  nextAction?: string
}

export function buildDeliveryGate(state: EvidenceState): DeliveryGateResult {
  const modified = [...state.filesModified].sort()

  if (modified.length === 0) {
    return {
      status: 'verified',
      severity: 'ok',
      canClaimComplete: true,
      message: 'No file modifications require verification.',
    }
  }

  if (state.deliveryStatus === 'failed') {
    const failed = state.verifications.find(v => v.status === 'failed')
    return {
      status: 'failed',
      severity: 'error',
      canClaimComplete: false,
      message: `Verification failed${failed ? `: ${failed.command}` : ''}.`,
      blockingReason: failed ? `Verification command failed: ${failed.command}` : 'Verification failed.',
      nextAction: 'Fix the failing verification or report the failure before claiming completion.',
    }
  }

  if (state.deliveryStatus === 'blocked') {
    const blocked = state.verifications.find(v => v.status === 'blocked')
    return {
      status: 'blocked',
      severity: 'error',
      canClaimComplete: false,
      message: `Verification blocked${blocked ? `: ${blocked.command}` : ''}.`,
      blockingReason: blocked ? `Verification command blocked: ${blocked.command}` : 'Verification is blocked.',
      nextAction: 'Explain the blocker and request the missing environment, dependency, or permission.',
    }
  }

  if (state.deliveryStatus === 'verified') {
    return {
      status: 'verified',
      severity: 'ok',
      canClaimComplete: true,
      message: 'Modified files have passing verification evidence.',
    }
  }

  return {
    status: 'unverified',
    severity: 'warn',
    canClaimComplete: false,
    message: `Unverified changes: ${modified.join(', ')}.`,
    blockingReason: 'Files were modified without passing verification evidence.',
    nextAction: 'Run relevant targeted tests, typecheck, or build before claiming completion.',
  }
}
