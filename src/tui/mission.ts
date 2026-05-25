import type { CognitivePhaseSnapshot } from '../context/cognitive-ledger.js'

const STATUS_LABELS: Record<string, string> = {
  exploring: '探',
  planning: '策',
  executing: '行',
  verifying: '验',
  ready_to_deliver: '成',
  blocked: '阻',
}

const DELIVERY_LABELS: Record<string, string> = {
  verified: '已验',
  unverified: '未验',
  failed: '失败',
  blocked: '受阻',
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.slice(0, Math.max(0, maxLength - 1)).trimEnd() + '…'
}

export function formatMissionStrip(snapshot?: CognitivePhaseSnapshot): string | null {
  if (!snapshot?.isActionableTask) return null
  if (!snapshot.objective) return null

  const status = snapshot.contractStatus ? STATUS_LABELS[snapshot.contractStatus] ?? snapshot.contractStatus : '任'
  const objective = truncateText(snapshot.objective, 48)
  const scope = snapshot.scopeFileCount > 0 ? `${snapshot.scopeFileCount} file${snapshot.scopeFileCount === 1 ? '' : 's'}` : 'scope —'
  const delivery = snapshot.hasVerificationGap
    ? '未验'
    : DELIVERY_LABELS[snapshot.deliveryStatus] ?? snapshot.deliveryStatus

  return `天契 ${status} · ${objective} · ${scope} · ${delivery}`
}
