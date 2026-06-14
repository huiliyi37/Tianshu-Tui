import { useCallback, useState } from 'react'
import { getArtifact, sendArtifactFeedback } from '../runtime/client'
import type { ArtifactSummary } from '../runtime/types'
import { DiffView } from './DiffView'

export function ArtifactsPanel(props: {
  sessionId: string | null
  artifacts: ArtifactSummary[]
  onFeedbackSent?: () => void
}) {
  const { sessionId, artifacts, onFeedbackSent } = props
  const [open, setOpen] = useState<{ artifact: ArtifactSummary; raw: string } | null>(null)
  const [comment, setComment] = useState('')
  const [sending, setSending] = useState(false)

  const view = useCallback(async (a: ArtifactSummary) => {
    if (!sessionId) return
    try {
      setOpen(await getArtifact(sessionId, a.id))
      setComment('')
    } catch {
      // ignore
    }
  }, [sessionId])

  const sendFeedback = useCallback(async () => {
    if (!sessionId || !open || !comment.trim()) return
    setSending(true)
    try {
      await sendArtifactFeedback(sessionId, open.artifact.id, comment.trim())
      setOpen(null)
      setComment('')
      onFeedbackSent?.()
    } finally {
      setSending(false)
    }
  }, [sessionId, open, comment, onFeedbackSent])

  return (
    <div className="artifacts">
      <div className="panel-header"><span>Artifacts · 信任层</span></div>
      {artifacts.length === 0 && <div className="empty">还没有工件</div>}
      {artifacts.map((a) => (
        <div key={a.id} className="artifact-card" onClick={() => view(a)}>
          <div className="kind">{a.kind}</div>
          <div className="summary">{a.summary || a.target}</div>
          <div className="meta">{a.lineCount} 行 · {a.charCount} 字符</div>
        </div>
      ))}

      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(null)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <h3>{open.artifact.kind} · {open.artifact.target}</h3>
            {open.artifact.kind === 'screenshot' ? (
              <img className="screenshot" src={`data:image/png;base64,${open.raw}`} alt={open.artifact.summary} />
            ) : open.artifact.kind === 'diff' ? (
              <DiffView raw={open.raw} />
            ) : (
              <pre>{open.raw}</pre>
            )}
            <label className="meta">在工件上反馈（回灌为下一轮上下文）</label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="例如：这个改动漏了错误处理，请补上 try/catch 并加测试"
            />
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setOpen(null)}>关闭</button>
              <button className="btn" disabled={!comment.trim() || sending} onClick={sendFeedback}>
                {sending ? '发送中…' : '发送反馈'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
