import { useCallback } from 'react'
import { useAbortSession, useArtifacts, useCloseSession, useSendPrompt, useSessions, useSetPlanMode } from '../state/queries'
import { useUiDispatch, useUiState } from '../state/store'
import { useSessionEvents } from '../state/use-session-events'
import { answerApproval, answerIntent, setApprovalMode, steerSession } from '../runtime/client'
import type { ApprovalMode, PlanModeState } from '../runtime/types'
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
  const closeSession = useCloseSession()
  const setPlanMode = useSetPlanMode()

  const active = sessions.data?.find((s) => s.id === activeId) ?? null

  // Desktop notifications now fire globally for ANY session (Q2) via
  // useGlobalNotifications mounted in App — no per-active-session effects here.

  const handleSend = useCallback((prompt: string, images?: string[]) => {
    if (!activeId) return
    sendPrompt.mutate({ id: activeId, prompt, images })
  }, [activeId, sendPrompt])

  // T3 — queue mid-run guidance. If the run already finished between render and
  // submit (idle), fall back to starting a fresh turn so input is never lost.
  const handleSteer = useCallback((text: string) => {
    if (!activeId) return
    void steerSession(activeId, text).then((r) => {
      if (r === 'idle') sendPrompt.mutate({ id: activeId, prompt: text })
    })
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

  const handleSetApprovalMode = useCallback((mode: ApprovalMode) => {
    if (!activeId) return
    void setApprovalMode(activeId, mode).then(() => sessions.refetch())
  }, [activeId, sessions])

  const handleSetPlanMode = useCallback((state: PlanModeState) => {
    if (!activeId) return
    setPlanMode.mutate({ id: activeId, state })
  }, [activeId, setPlanMode])

  const handleClose = useCallback(() => {
    if (!activeId) return
    closeSession.mutate(activeId)
    dispatch({ type: 'setActive', id: '' })
  }, [activeId, closeSession, dispatch])

  return (
    <div className="workspace">
      <ProjectSidebar />

      <div className="conversation">
        {active ? (
          <ThreadView
            session={active}
            view={view}
            onSend={handleSend}
            onSteer={handleSteer}
            onAbort={() => abortSession.mutate(active.id)}
            onSetApprovalMode={handleSetApprovalMode}
            onSetPlanMode={handleSetPlanMode}
            onClose={handleClose}
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
        approvalMode={active?.approvalMode}
        planMode={view.planMode}
        planRev={view.planRev}
        latestPlanSlug={view.latestPlanSlug}
        onApproval={handleApproval}
        onIntent={handleIntent}
        onFeedbackSent={() => sessions.refetch()}
        todos={view.todos}
        sources={view.sources}
      />
    </div>
  )
}
