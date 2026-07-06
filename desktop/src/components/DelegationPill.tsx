import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import type { DelegationNode } from '../runtime/types'
import { summarizeDelegation } from './DelegationTree'

// Collapsed, one-line stand-in for the subagent fleet panel. Lives inline in the
// main conversation flow; clicking it toggles the DelegationOverlay drawer.
// Worker execution is backend-driven (delegation events) and unaffected by the
// drawer being open or closed — this pill is pure display.

interface DelegationPillProps {
  nodes: Record<string, DelegationNode>
  open: boolean
  onToggle: () => void
}

function DelegationPillImpl({ nodes, open, onToggle }: DelegationPillProps) {
  const { t } = useTranslation('delegation')
  const { total, done, running, attention } = summarizeDelegation(nodes)
  if (total === 0) return null
  const hasUser = Object.values(nodes).some((n) => n.origin === 'user')

  return (
    <button
      className={`delegation-pill${attention > 0 ? ' attention' : ''}${open ? ' open' : ''}`}
      onClick={onToggle}
      aria-expanded={open}
      title={t('pill.hint')}
    >
      <span className={`dp-dot${running > 0 ? ' pulse' : ''}`} aria-hidden />
      <span className="dp-label">{t('subAgents')}</span>
      {hasUser && <span className="dp-origin">{t('dispatchedByYou')}</span>}
      <span className="dp-progress">{done}/{total}</span>
      {attention > 0 && <span className="dp-attention">{t('needAttention', { n: attention })}</span>}
      <span className="dp-chevron" aria-hidden>{open ? '▾' : '▸'}</span>
    </button>
  )
}

export const DelegationPill = memo(DelegationPillImpl, (a, b) =>
  a.nodes === b.nodes && a.open === b.open
)
