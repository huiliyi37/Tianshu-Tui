import { useCallback, useState } from 'react'
import { getArtifact, sendArtifactFeedback } from '../runtime/client'
import type { ApprovalRequest, ArtifactSummary, IntentRequest } from '../runtime/types'
import { DiffView } from '../components/DiffView'
import { editableKey, previewOf } from '../lib/approval-preview'

type ReviewTab = 'review' | 'council' | 'cognition'

// Review panel (P3/Q3) — Codex's third pane. Aggregates the trust-layer surfaces
// of the active thread: pending approvals/intents handled INLINE (no blocking
// modal) + artifacts/diff/screenshots. The tab bar reserves slots for future CVM
// council/sensorium views (not rendered yet).
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
              <ApprovalReview request={pendingApproval} onDecision={onApproval} />
            )}
            {pendingIntent && (
              <IntentReview request={pendingIntent} onDecision={onIntent} />
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
    </div>
  )
}

// Inline approval (Q3) — replaces the blocking ApprovalModal. Diff/JSON preview +
// approve/reject, with optional edit-before-approve for edit tools.
function ApprovalReview(props: {
  request: ApprovalRequest
  onDecision: (decision: 'approve' | 'reject', editedInput?: Record<string, unknown>) => void
}) {
  const { request, onDecision } = props
  const preview = previewOf(request)
  const editKey = editableKey(request)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(
    editKey ? String((request.input as Record<string, unknown>)[editKey] ?? '') : '',
  )

  const approve = () => {
    if (editing && editKey) onDecision('approve', { ...request.input, [editKey]: draft })
    else onDecision('approve')
  }

  return (
    <div className="review-pending approval">
      <div className="rp-head">
        <span className="kind">需批准</span>
        <span className="rp-tool">{request.toolName}</span>
      </div>
      {editing && editKey ? (
        <textarea className="edit-input" value={draft} onChange={(e) => setDraft(e.target.value)} />
      ) : preview.isDiff ? (
        <DiffView raw={preview.text} />
      ) : (
        <pre className="rp-preview">{preview.text}</pre>
      )}
      <div className="rp-actions">
        {editKey && (
          <button className="btn ghost sm" onClick={() => setEditing((v) => !v)}>
            {editing ? '取消编辑' : '编辑'}
          </button>
        )}
        <button className="btn ghost sm" onClick={() => onDecision('reject')}>拒绝</button>
        <button className="btn sm" onClick={approve}>{editing ? '应用并批准' : '批准'}</button>
      </div>
    </div>
  )
}

// Inline intent preview (Q3) — replaces IntentModal.
function IntentReview(props: {
  request: IntentRequest
  onDecision: (decision: 'continue' | 'veto' | 'alternative') => void
}) {
  const { request, onDecision } = props
  return (
    <div className="review-pending intent">
      <div className="rp-head">
        <span className="kind">意图预览 · {(request.confidence * 100).toFixed(0)}%</span>
      </div>
      <p className="rp-summary">{request.summary}</p>
      {request.alternatives.length > 0 && (
        <>
          <label className="meta">备选</label>
          <ul>{request.alternatives.map((a, i) => <li key={i}>{a}</li>)}</ul>
        </>
      )}
      {request.warnings.length > 0 && (
        <>
          <label className="meta">警告</label>
          <ul>{request.warnings.map((w, i) => <li key={i} className="warn">{w}</li>)}</ul>
        </>
      )}
      <div className="rp-actions">
        <button className="btn ghost sm" onClick={() => onDecision('veto')}>否决</button>
        <button className="btn ghost sm" onClick={() => onDecision('alternative')}>换方案</button>
        <button className="btn sm" onClick={() => onDecision('continue')}>继续</button>
      </div>
    </div>
  )
}
