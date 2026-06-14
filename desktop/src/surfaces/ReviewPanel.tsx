import { useCallback, useEffect, useState } from 'react'
import { getArtifact, sendArtifactFeedback } from '../runtime/client'
import type { ApprovalRequest, ArtifactSummary, IntentRequest } from '../runtime/types'
import { DiffView } from '../components/DiffView'
import { ApprovalModal } from '../components/ApprovalModal'
import { IntentModal } from '../components/IntentModal'

type ReviewTab = 'review' | 'council' | 'cognition'

// Review panel (P3) — Codex's third pane. Aggregates the trust-layer surfaces of
// the active thread: pending approvals/intents (decision still flows through the
// existing modals, opened on demand) + artifacts/diff/screenshots. The tab bar
// reserves slots for future CVM council/sensorium views (not rendered yet).
export function ReviewPanel(props: {
  sessionId: string | null
  artifacts: ArtifactSummary[]
  pendingApproval: ApprovalRequest | null
  pendingIntent: IntentRequest | null
  onApproval: (decision: 'approve' | 'reject', editedInput?: Record<string, unknown>) => void
  onIntent: (decision: 'continue' | 'veto' | 'alternative') => void
  onFeedbackSent?: () => void
}) {
  const { sessionId, artifacts, pendingApproval, pendingIntent, onApproval, onIntent, onFeedbackSent } = props
  const [tab, setTab] = useState<ReviewTab>('review')
  const [open, setOpen] = useState<{ artifact: ArtifactSummary; raw: string } | null>(null)
  const [comment, setComment] = useState('')
  const [sending, setSending] = useState(false)
  const [modal, setModal] = useState<'approval' | 'intent' | null>(null)

  // New intervention → auto-open its modal once (preserves blocking-approval feel)
  // while still leaving a card in the panel to reopen if dismissed later.
  useEffect(() => { if (pendingApproval) setModal('approval') }, [pendingApproval?.requestId])
  useEffect(() => { if (pendingIntent) setModal('intent') }, [pendingIntent?.requestId])

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

  const pendingCount = (pendingApproval ? 1 : 0) + (pendingIntent ? 1 : 0)

  return (
    <div className="review">
      <div className="review-tabs">
        <button className={`review-tab ${tab === 'review' ? 'active' : ''}`} onClick={() => setTab('review')}>
          审查{pendingCount > 0 && <span className="tab-badge">{pendingCount}</span>}
        </button>
        <button className="review-tab" disabled title="后续：CVM 议事会">议事会</button>
        <button className="review-tab" disabled title="后续：认知镜像">认知</button>
      </div>

      <div className="review-body">
        {(pendingApproval || pendingIntent) && (
          <section className="review-section">
            <h4>待处理</h4>
            {pendingApproval && (
              <div className="pending-card" onClick={() => setModal('approval')}>
                <div className="kind">需批准</div>
                <div className="summary">{pendingApproval.toolName}</div>
                <button className="btn sm">处理</button>
              </div>
            )}
            {pendingIntent && (
              <div className="pending-card" onClick={() => setModal('intent')}>
                <div className="kind">意图预览 · {(pendingIntent.confidence * 100).toFixed(0)}%</div>
                <div className="summary">{pendingIntent.summary}</div>
                <button className="btn sm">处理</button>
              </div>
            )}
          </section>
        )}

        <section className="review-section">
          <h4>工件 · 信任层</h4>
          {artifacts.length === 0 && <div className="empty sm">还没有工件</div>}
          {artifacts.map((a) => (
            <div key={a.id} className="artifact-card" onClick={() => view(a)}>
              <div className="kind">{a.kind}</div>
              <div className="summary">{a.summary || a.target}</div>
              <div className="meta">{a.lineCount} 行 · {a.charCount} 字符</div>
            </div>
          ))}
        </section>
      </div>

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

      {modal === 'approval' && pendingApproval && (
        <ApprovalModal
          request={pendingApproval}
          onDecision={(d, edited) => { onApproval(d, edited); setModal(null) }}
        />
      )}
      {modal === 'intent' && pendingIntent && (
        <IntentModal
          request={pendingIntent}
          onDecision={(d) => { onIntent(d); setModal(null) }}
        />
      )}
    </div>
  )
}
