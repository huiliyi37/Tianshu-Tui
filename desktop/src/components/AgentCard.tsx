import { useState } from 'react'
import type { ReactNode } from 'react'
import type { SessionRecord } from '../runtime/types'
import { useSessionEvents, type StreamStatus } from '../state/use-session-events'
import { useAbortSession } from '../state/queries'
import { answerApproval } from '../runtime/client'
import { MiniStream } from './MiniStream'

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
            title={streamStatus === 'reconnecting' ? '重连中…' : '实时流已断开'}
          />
        )}
      </div>

      <div className="mission-card-body">{body}</div>

      <div className="mission-card-foot" onClick={(e) => e.stopPropagation()}>
        <div className="mission-metrics">
          {typeof tokens === 'number' && tokens > 0 && (
            <span className="mission-metric" title="上下文 token">{formatTokens(tokens)} tok</span>
          )}
          {typeof edits === 'number' && edits > 0 && (
            <span className="mission-metric" title="已改动文件数">{edits} edits</span>
          )}
          {pendingApprovals > 0 && (
            <span className="mission-badge approval" title="待审批">{pendingApprovals} 待审批</span>
          )}
        </div>
        <div className="mission-actions">
          {pendingApprovals > 0 && onApprove && (
            <button
              className="mission-btn approve"
              onClick={() => onApprove()}
              title="批准当前请求"
            >
              批准
            </button>
          )}
          {isRunning && (
            <button
              className="mission-btn abort"
              disabled={abort.isPending}
              onClick={() => abort.mutate(session.id)}
              title="中止会话"
            >
              中止
            </button>
          )}
          <button className="mission-btn open" onClick={() => onOpen(session)}>打开</button>
        </div>
      </div>
    </div>
  )
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/** Live variant — subscribes to the session's SSE stream for tail blocks,
 *  live phase, token delta and edit count. */
function LiveAgentCard({ session, onOpen }: { session: SessionRecord; onOpen: (s: SessionRecord) => void }) {
  const view = useSessionEvents(session.id)
  const [answering, setAnswering] = useState(false)
  const pending = view.pendingApproval

  const onApprove = pending
    ? () => {
        if (answering) return
        setAnswering(true)
        answerApproval(session.id, pending.requestId, 'approve').finally(() => setAnswering(false))
      }
    : undefined

  const body = (
    <>
      {view.phase && <div className="mission-phase" title="当前阶段">{view.phase}</div>}
      <MiniStream blocks={view.blocks} rev={view.blocksRev} />
    </>
  )

  return (
    <AgentCardChrome
      session={session}
      streamStatus={view.streamStatus}
      tokens={view.lastTotalTokens || session.contextTokens}
      edits={view.sources.length}
      pendingApprovals={pending ? Math.max(session.pendingApprovals, 1) : session.pendingApprovals}
      body={body}
      onOpen={onOpen}
      onApprove={onApprove}
    />
  )
}

/** Snapshot variant — poll-only; no SSE. Shows the last-known phase + status. */
function SnapshotAgentCard({ session, onOpen }: { session: SessionRecord; onOpen: (s: SessionRecord) => void }) {
  const body = (
    <>
      {session.currentPhase && <div className="mission-phase" title="当前阶段">{session.currentPhase}</div>}
      <div className="mission-snapshot">
        <span className={`mission-snapshot-status status-text-${session.status}`}>{statusLabel(session.status)}</span>
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

function statusLabel(status: SessionRecord['status']): string {
  switch (status) {
    case 'running': return '运行中'
    case 'completed': return '已完成'
    case 'failed': return '失败'
    case 'aborted': return '已中止'
    default: return '空闲'
  }
}
