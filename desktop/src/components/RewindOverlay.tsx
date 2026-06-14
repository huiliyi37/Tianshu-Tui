import { useEffect, useState } from 'react'
import { getRewindPoints, rewindSession, type RewindPoint } from '../runtime/client'

interface RewindOverlayProps {
  sessionId: string
  onClose: () => void
  onRewound: (prompt: string) => void
}

export function RewindOverlay({ sessionId, onClose, onRewound }: RewindOverlayProps) {
  const [points, setPoints] = useState<RewindPoint[]>([])
  const [idx, setIdx] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getRewindPoints(sessionId)
      .then(({ points }) => {
        setPoints(points)
        setLoading(false)
      })
      .catch((e) => {
        setError(String(e.message ?? e))
        setLoading(false)
      })
  }, [sessionId])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setIdx((i) => Math.min(i + 1, points.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setIdx((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter' && points.length > 0) {
        e.preventDefault()
        handleRewind(points[idx]!)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [points, idx])

  const handleRewind = async (point: RewindPoint) => {
    try {
      await rewindSession(sessionId, point.index)
      onRewound(point.content)
      onClose()
    } catch (e) {
      setError(String((e as Error).message ?? e))
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="rewind-panel" onClick={(e) => e.stopPropagation()}>
        <div className="rewind-header">⏪ Rewind — select a message to restore</div>
        {loading && <div className="rewind-empty">Loading…</div>}
        {error && <div className="rewind-error">{error}</div>}
        {!loading && !error && points.length === 0 && (
          <div className="rewind-empty">No messages to rewind.</div>
        )}
        {!loading && !error && points.length > 0 && (
          <div className="rewind-list">
            {points.map((p, i) => (
              <div
                key={p.index}
                className={`rewind-item ${i === idx ? 'selected' : ''}`}
                onClick={() => setIdx(i)}
                onDoubleClick={() => handleRewind(p)}
              >
                <span className="rewind-marker">{i === idx ? '▸' : ' '}</span>
                <span className="rewind-text">
                  {p.content.length > 70 ? p.content.slice(0, 69) + '…' : p.content}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="rewind-hint">↑↓ select · Enter confirm · Esc cancel</div>
      </div>
    </div>
  )
}
