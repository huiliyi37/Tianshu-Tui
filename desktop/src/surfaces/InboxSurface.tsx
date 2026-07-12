import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { qk, useSessions, useTasks } from '../state/queries'
import { useUiDispatch, useUiState } from '../state/store'
import { deriveReviewQueue, type ReviewItem } from '../lib/attention'
import { projectId } from '../lib/projects'
import { answerApproval, fetchEvents } from '../runtime/client'
import type { ApprovalRequest, SessionRecord } from '../runtime/types'

// Review Queue（Wave 4 — Codex 范式）：sessions 的待审批/失败/完成 + automation
// 运行结果合并为一个可逐条 triage 的队列。单条 dismiss、跳转会话、待审批条目
// 内联展示审批摘要并可直接批准/拒绝（不强制跳走）。
export function InboxSurface() {
  const { t } = useTranslation('inbox')
  const sessions = useSessions()
  const tasks = useTasks()
  const ui = useUiState()
  const dispatch = useUiDispatch()
  const queue = deriveReviewQueue(sessions.data ?? [], tasks.data ?? [], new Set(ui.attentionSeen), ui.activeSessionId)

  const open = (it: ReviewItem) => {
    if (!it.sessionId) return
    if (it.cwd) dispatch({ type: 'setProject', projectId: projectId(it.cwd) })
    dispatch({ type: 'setActive', id: it.sessionId })
    dispatch({ type: 'setSurface', surface: 'workspace' })
    dispatch({ type: 'markSeen', sigs: [it.sig] })
  }

  const dismiss = (it: ReviewItem) => dispatch({ type: 'markSeen', sigs: [it.sig] })
  const clearAll = () => dispatch({ type: 'markSeen', sigs: queue.items.map((i) => i.sig) })

  return (
    <div className="single-pane attention review-queue">
      <div className="panel-header">
        <span>Review Queue{queue.unseenCount > 0 ? ` · ${queue.unseenCount}` : ''}</span>
        {queue.items.length > 0 && (
          <button className="btn ghost sm" onClick={clearAll}>{t('clearAll')}</button>
        )}
      </div>

      {queue.items.length === 0 && <div className="empty">{t('emptyQueue')}</div>}

      {queue.sections.map((sec) => (
        <div key={sec.id} className="attn-group">
          <div className="attn-group-name">
            {sec.label}
            <span className="rq-count">{sec.items.length}</span>
          </div>
          {sec.items.map((it) => (
            <ReviewCard
              key={it.sig}
              item={it}
              unseen={!ui.attentionSeen.includes(it.sig)}
              session={sessions.data?.find((s) => s.id === it.sessionId)}
              onOpen={() => open(it)}
              onDismiss={() => dismiss(it)}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

function ReviewCard(props: {
  item: ReviewItem
  unseen: boolean
  session: SessionRecord | undefined
  onOpen: () => void
  onDismiss: () => void
}) {
  const { item, unseen, session, onOpen, onDismiss } = props
  const { t } = useTranslation('inbox')
  const [expanded, setExpanded] = useState(false)
  const isApproval = item.section === 'approval'

  return (
    <div className={`attn-card rq-card reason-${item.section} ${unseen ? 'unseen' : ''}`}>
      <div className="rq-card-row" onClick={onOpen} role="button">
        <span className={`status-dot reason-${item.section === 'automation' ? (item.taskStatus === 'completed' ? 'completed' : 'failed') : item.section}`} />
        <div className="attn-body">
          <div className="title">
            {item.kind === 'automation' && <span className="rq-badge">automation</span>}
            {item.title}
          </div>
          <div className="meta">{item.detail}</div>
        </div>
        <div className="rq-actions" onClick={(e) => e.stopPropagation()}>
          {isApproval && item.sessionId && (
            <button
              className="btn ghost sm"
              onClick={() => setExpanded((v) => !v)}
              title={t('card.inlineApprovalHint')}
            >
              {expanded ? t('card.collapse') : t('card.review')}
            </button>
          )}
          {item.sessionId && (
            <button className="btn ghost sm" onClick={onOpen} title={t('card.jumpToSession')}>{t('card.open')}</button>
          )}
          <button className="rq-dismiss" onClick={onDismiss} title={t('card.dismiss')} aria-label={t('card.dismiss')}>×</button>
        </div>
      </div>
      {expanded && isApproval && item.sessionId && session && (
        <InlineApprovalTriage sessionId={item.sessionId} lastSeq={session.lastSeq} onDone={onDismiss} />
      )}
    </div>
  )
}

/** Inline approval triage — pulls the tail of the session's event log to find
 *  unresolved approval_required events, shows a compact summary, and resolves
 *  them in place via answerApproval (no forced navigation). */
function InlineApprovalTriage(props: { sessionId: string; lastSeq: number; onDone: () => void }) {
  const { sessionId, lastSeq, onDone } = props
  const { t } = useTranslation('inbox')
  const queryClient = useQueryClient()
  const [pendings, setPendings] = useState<ApprovalRequest[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [answering, setAnswering] = useState<string | null>(null)

  // Load once on mount (component only exists while expanded).
  useEffect(() => {
    let cancelled = false
    const since = Math.max(0, lastSeq - 300)
    fetchEvents(sessionId, since)
      .then(({ events }) => {
        if (cancelled) return
        const open = new Map<string, ApprovalRequest>()
        for (const ev of events) {
          if (ev.type === 'approval_required') {
            const d = ev.data as { requestId?: string; toolName?: string; input?: Record<string, unknown> }
            if (d.requestId) open.set(d.requestId, { requestId: d.requestId, toolName: d.toolName ?? '?', input: d.input ?? {} })
          } else if (ev.type === 'approval_resolved') {
            const d = ev.data as { requestId?: string }
            if (d.requestId) open.delete(d.requestId)
          }
        }
        setPendings([...open.values()])
      })
      .catch((e) => { if (!cancelled) setError(String((e as Error).message ?? e)) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const answer = async (requestId: string, decision: 'approve' | 'reject') => {
    setAnswering(requestId)
    try {
      await answerApproval(sessionId, requestId, decision)
      toast.success(decision === 'approve' ? t('toast.approved') : t('toast.rejected'))
      setPendings((prev) => {
        const next = (prev ?? []).filter((p) => p.requestId !== requestId)
        if (next.length === 0) onDone()
        return next
      })
      void queryClient.invalidateQueries({ queryKey: qk.sessions })
    } catch (e) {
      toast.error(t('toast.failed', { message: String((e as Error).message ?? e) }))
    } finally {
      setAnswering(null)
    }
  }

  if (error) return <div className="rq-triage"><div className="empty sm">{t('triage.loadFailed', { error })}</div></div>
  if (pendings === null) return <div className="rq-triage"><div className="empty sm">{t('triage.loading')}</div></div>
  if (pendings.length === 0) {
    return <div className="rq-triage"><div className="empty sm">{t('triage.noPending')}</div></div>
  }

  return (
    <div className="rq-triage">
      {pendings.map((p) => {
        const inputPreview = JSON.stringify(p.input, null, 1)
        return (
          <div key={p.requestId} className="rq-approval">
            <div className="rq-approval-head">
              <span className="rq-approval-tool">{p.toolName}</span>
            </div>
            <pre className="rq-approval-preview font-mono">
              {inputPreview.length > 400 ? `${inputPreview.slice(0, 400)}…` : inputPreview}
            </pre>
            <div className="rq-approval-actions">
              <button
                className="btn ghost sm"
                disabled={answering !== null}
                onClick={() => void answer(p.requestId, 'reject')}
              >
                {t('triage.reject')}
              </button>
              <button
                className="btn sm"
                disabled={answering !== null}
                onClick={() => void answer(p.requestId, 'approve')}
              >
                {answering === p.requestId ? '…' : t('triage.approve')}
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
