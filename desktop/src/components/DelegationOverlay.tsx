import { useEffect } from 'react'
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
          <span className="do-title">子代理面板</span>
          <span className="do-counts">
            {done}/{total} 完成
            {running > 0 && <span className="do-running"> · {running} 运行中</span>}
            {attention > 0 && <span className="do-attention"> · {attention} 需关注</span>}
          </span>
          <button className="do-close" onClick={onClose} aria-label="关闭" title="关闭 (Esc)">✕</button>
        </div>
        <div className="delegation-overlay-body">
          <DelegationTree nodes={nodes} onAdopt={onAdopt} />
        </div>
      </div>
    </div>
  )
}
