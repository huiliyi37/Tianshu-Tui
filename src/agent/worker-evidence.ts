import type { WorkerResult } from './work-order.js'

function addRisk(risks: string[], risk: string): string[] {
  return risks.includes(risk) ? risks : [...risks, risk]
}

export function verifyWorkerEvidence(result: WorkerResult): WorkerResult {
  if (result.changedFiles.length === 0) return result

  const unverifiedRisk = `unverified: ${result.changedFiles.length} file(s) changed without verified evidence`

  if (result.evidenceStatus !== 'verified') {
    return {
      ...result,
      status: 'blocked',
      evidenceStatus: 'blocked',
      risks: addRisk(result.risks, unverifiedRisk),
    }
  }

  if (!result.verification) {
    return {
      ...result,
      status: 'blocked',
      evidenceStatus: 'blocked',
      risks: addRisk(result.risks, 'verified worker result is missing verification metadata'),
    }
  }

  if (result.verification.status === 'failed') {
    return {
      ...result,
      status: 'failed',
      evidenceStatus: 'failed',
      risks: addRisk(result.risks, `worker verification failed: ${result.verification.command}`),
    }
  }

  if (result.verification.status === 'blocked') {
    return {
      ...result,
      status: 'blocked',
      evidenceStatus: 'blocked',
      risks: addRisk(result.risks, `worker verification blocked: ${result.verification.command}`),
    }
  }

  return result
}
