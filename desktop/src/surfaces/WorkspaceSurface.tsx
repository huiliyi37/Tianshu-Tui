import { useCallback, useEffect, useRef } from 'react'
import { useAbortSession, useArtifacts, useSendPrompt, useSessions } from '../state/queries'
import { useUiDispatch, useUiState } from '../state/store'
import { useSessionEvents } from '../state/use-session-events'
import { answerApproval, answerIntent } from '../runtime/client'
import { notify } from '../lib/notify'
import { ProjectSidebar } from './ProjectSidebar'
import { ThreadView } from './ThreadView'
import { ReviewPanel } from './ReviewPanel'

export function WorkspaceSurface() {
  const ui = useUiState()
  const dispatch = useUiDispatch()
  const sessions = useSessions()
  const activeId = ui.activeSessionId

  const view = useSessionEvents(activeId)
  const artifacts = useArtifacts(activeId, view.artifactRev)
  const sendPrompt = useSendPrompt()
  const abortSession = useAbortSession()

  const active = sessions.data?.find((s) => s.id === activeId) ?? null

  // Async desktop notifications (N2): nudge on approval / completion when unfocused.
  const lastApprovalRef = useRef<string | null>(null)
  useEffect(() => {
    const reqId = view.pendingApproval?.requestId ?? null
    if (reqId && reqId !== lastApprovalRef.current) {
      void notify('需要批准', `${view.pendingApproval!.toolName} 等待你的确认`)
    }
    lastApprovalRef.current = reqId
  }, [view.pendingApproval])

  const lastStatusRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const status = active?.status
    if (status && status !== lastStatusRef.current && (status === 'completed' || status === 'failed')) {
      const label = active!.title ?? active!.id.slice(0, 8)
      void notify('会话结束', `${label} ${status === 'completed' ? '已完成' : '失败'}`)
    }
    lastStatusRef.current = status
  }, [active?.status, active])

  const handleSend = useCallback((prompt: string) => {
    if (!activeId) return
    sendPrompt.mutate({ id: activeId, prompt })
  }, [activeId, sendPrompt])

  const handleApproval = useCallback(
    (decision: 'approve' | 'reject', editedInput?: Record<string, unknown>) => {
      if (!activeId || !view.pendingApproval) return
      void answerApproval(activeId, view.pendingApproval.requestId, decision, editedInput)
    },
    [activeId, view.pendingApproval],
  )

  const handleIntent = useCallback((decision: 'continue' | 'veto' | 'alternative') => {
    if (!activeId || !view.pendingIntent) return
    void answerIntent(activeId, view.pendingIntent.requestId, decision)
  }, [activeId, view.pendingIntent])

  return (
    <div className="workspace">
      <ProjectSidebar />

      <div className="conversation">
        {active ? (
          <ThreadView
            session={active}
            view={view}
            onSend={handleSend}
            onAbort={() => abortSession.mutate(active.id)}
          />
        ) : (
          <div className="empty thread-empty">
            <p>选择左侧线程，或在当前项目新建一个线程开始对话。</p>
            <button className="btn" onClick={() => dispatch({ type: 'openNew', open: true })}>
              + 新线程
            </button>
          </div>
        )}
      </div>

      <ReviewPanel
        sessionId={activeId}
        artifacts={artifacts.data ?? []}
        pendingApproval={view.pendingApproval}
        pendingIntent={view.pendingIntent}
        onApproval={handleApproval}
        onIntent={handleIntent}
        onFeedbackSent={() => sessions.refetch()}
      />
    </div>
  )
}
