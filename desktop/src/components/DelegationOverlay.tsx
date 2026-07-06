import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { DelegationNode } from '../runtime/types'
import { DelegationTree, summarizeDelegation } from './DelegationTree'

// Right-side slide-in drawer hosting the full DelegationTree. Opened on demand
// from the DelegationPill (Codex-style background panel you can open/close at
// will). Esc or backdrop click closes it; closing never stops workers.

interface DelegationOverlayProps {
  nodes: Record<string, DelegationNode>
  onClose: () => void
  /** Adopt a finished worker's summary into the composer (user-dispatched flow). */
  onAdopt?: (text: string) => void
}

export function DelegationOverlay({ nodes, onClose, onAdopt }: DelegationOverlayProps) {
  const { t } = useTranslation('delegation')
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const { total, done, running, attention } = summarizeDelegation(nodes)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="delegation-overlay" onClick={(e) => e.stopPropagation()}>
        <div className="delegation-overlay-header">
          <span className="do-title">{t('overlay.title')}</span>
          <span className="do-counts">
            {t('overlay.progress', { done, total })}
            {running > 0 && <span className="do-running">{t('overlay.running', { running })}</span>}
            {attention > 0 && <span className="do-attention"> · {t('needAttention', { n: attention })}</span>}
          </span>
          <button className="do-close" onClick={onClose} aria-label={t('close')} title={t('overlay.closeHint')}>✕</button>
        </div>
        <div className="delegation-overlay-body">
          <DelegationTree nodes={nodes} onAdopt={onAdopt} />
        </div>
      </div>
    </div>
  )
}
