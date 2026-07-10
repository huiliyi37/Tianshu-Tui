import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'
import type { SessionRecord } from '../runtime/types'
import { useSessionEventsSelector, type StreamStatus } from '../state/use-session-events'
import { useAbortSession } from '../state/queries'
import { answerApproval } from '../runtime/client'
import { MiniStream, miniTail, miniLinesEqual, type MiniLineData } from './MiniStream'

interface AgentCardProps {
  session: SessionRecord
  /** When true, render the live variant (subscribes to the SSE stream). */
  live: boolean
  onOpen: (session: SessionRecord) => void
}

/** Selects the live or snapshot variant. Each variant calls its hooks
 *  unconditionally, so the `live` boolean never changes a hook's call order
 *  within a single component (Rules of Hooks). */
export function AgentCardWrapper({ session, live, onOpen }: AgentCardProps) {
  return live
    ? <LiveAgentCard session={session} onOpen={onOpen} />
    : <SnapshotAgentCard session={session} onOpen={onOpen} />
}

function shortId(id: string): string {
  return id.slice(0, 8)
}

/** Shared frame: header (title + status + model + stream dot), body slot,
 *  footer metrics, and the open/approve/abort actions. */
function AgentCardChrome({
  session,
  streamStatus,
  tokens,
  edits,
  pendingApprovals,
  body,
  onOpen,
  onApprove,
}: {
  session: SessionRecord
  streamStatus?: StreamStatus
  tokens?: number
  edits?: number
  pendingApprovals: number
  body: ReactNode
  onOpen: (session: SessionRecord) => void
  /** Present only when a live pending approval (with a requestId) is known. */
  onApprove?: () => void
}) {
  const { t } = useTranslation('mission')
  const abort = useAbortSession()
  const title = session.title?.trim() || shortId(session.id)
  const glyph = session.domainGlyph || '✹'
  const isRunning = session.status === 'running'

  return (
    <div
      className={`mission-card status-${session.status}`}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(session)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(session)
        }
      }}
    >
      <div className="mission-card-head">
        <span className="mission-glyph" aria-hidden>{glyph}</span>
        <span className="mission-title" title={title}>{title}</span>
        <span className={`status-dot status-${session.status}`} title={session.status} />
        {session.model && <span className="mission-chip" title={session.model}>{session.model}</span>}
        {streamStatus && (streamStatus === 'reconnecting' || streamStatus === 'offline') && (
          <span
            className={`mission-stream-dot ${streamStatus}`}
            title={streamStatus === 'reconnecting' ? t('card.reconnecting') : t('card.offline')}
          />
        )}
      </div>

      <div className="mission-card-body">{body}</div>

      <div className="mission-card-foot" onClick={(e) => e.stopPropagation()}>
        <div className="mission-metrics">
          {typeof tokens === 'number' && tokens > 0 && (
            <span className="mission-metric" title={t('card.contextTokensHint')}>{formatTokens(tokens)} tok</span>
          )}
          {typeof edits === 'number' && edits > 0 && (
            <span className="mission-metric" title={t('card.editsHint')}>{edits} edits</span>
          )}
          {pendingApprovals > 0 && (
            <span className="mission-badge approval" title={t('card.approvalHint')}>{t('card.pendingApprovals', { n: pendingApprovals })}</span>
          )}
        </div>
        <div className="mission-actions">
          {pendingApprovals > 0 && onApprove && (
            <button
              className="mission-btn approve"
              onClick={() => onApprove()}
              title={t('card.approveHint')}
            >
              {t('card.approve')}
            </button>
          )}
          {isRunning && (
            <button
              className="mission-btn abort"
              disabled={abort.isPending}
              onClick={() => abort.mutate(session.id)}
              title={t('card.abortHint')}
            >
              {t('card.abort')}
            </button>
          )}
          <button className="mission-btn open" onClick={() => onOpen(session)}>{t('card.open')}</button>
        </div>
      </div>
    </div>
  )
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/** The glance slice a live card actually renders — streaming deltas that don't
 *  change any of these fields skip the card re-render entirely (Wave 3). */
interface LiveCardSlice {
  approvalRequestId: string | null
  phase?: string
  streamStatus: StreamStatus
  tokens: number
  edits: number
  mini: MiniLineData[]
}

function liveCardSliceEqual(a: LiveCardSlice, b: LiveCardSlice): boolean {
  return (
    a.approvalRequestId === b.approvalRequestId &&
    a.phase === b.phase &&
    a.streamStatus === b.streamStatus &&
    a.tokens === b.tokens &&
    a.edits === b.edits &&
    miniLinesEqual(a.mini, b.mini)
  )
}

/** Live variant — subscribes to the session's SSE stream for tail blocks,
 *  live phase, token delta and edit count. Sliced subscription: only the
 *  visible glance data wakes this card, not every text delta. */
function LiveAgentCard({ session, onOpen }: { session: SessionRecord; onOpen: (s: SessionRecord) => void }) {
  const { t } = useTranslation('mission')
  const view = useSessionEventsSelector<LiveCardSlice>(
    session.id,
    (v) => ({
      approvalRequestId: v.pendingApproval?.requestId ?? null,
      phase: v.phase,
      streamStatus: v.streamStatus,
      tokens: v.lastTotalTokens,
      edits: v.sources.length,
      mini: miniTail(v.blocks),
    }),
    liveCardSliceEqual,
  )
  const [answering, setAnswering] = useState(false)
  const pendingRequestId = view.approvalRequestId

  const onApprove = pendingRequestId
    ? () => {
        if (answering) return
        setAnswering(true)
        answerApproval(session.id, pendingRequestId, 'approve').finally(() => setAnswering(false))
      }
    : undefined

  const body = (
    <>
      {view.phase && <div className="mission-phase" title={t('card.phaseHint')}>{view.phase}</div>}
      <MiniStream lines={view.mini} />
    </>
  )

  return (
    <AgentCardChrome
      session={session}
      streamStatus={view.streamStatus}
      tokens={view.tokens || session.contextTokens}
      edits={view.edits}
      pendingApprovals={pendingRequestId ? Math.max(session.pendingApprovals, 1) : session.pendingApprovals}
      body={body}
      onOpen={onOpen}
      onApprove={onApprove}
    />
  )
}

/** Snapshot variant — poll-only; no SSE. Shows the last-known phase + status. */
function SnapshotAgentCard({ session, onOpen }: { session: SessionRecord; onOpen: (s: SessionRecord) => void }) {
  const { t } = useTranslation('mission')
  const body = (
    <>
      {session.currentPhase && <div className="mission-phase" title={t('card.phaseHint')}>{session.currentPhase}</div>}
      <div className="mission-snapshot">
        <span className={`mission-snapshot-status status-text-${session.status}`}>{t(`card.status.${statusKey(session.status)}`)}</span>
      </div>
    </>
  )

  return (
    <AgentCardChrome
      session={session}
      tokens={session.contextTokens}
      pendingApprovals={session.pendingApprovals}
      body={body}
      onOpen={onOpen}
    />
  )
}

function statusKey(status: SessionRecord['status']): string {
  switch (status) {
    case 'running': return 'running'
    case 'completed': return 'completed'
    case 'failed': return 'failed'
    case 'aborted': return 'aborted'
    default: return 'idle'
  }
}
