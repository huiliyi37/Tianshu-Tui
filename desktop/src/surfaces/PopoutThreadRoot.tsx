import { useCallback } from 'react'
import { useAbortSession, useSendPrompt, useSessions, useSetPlanMode } from '../state/queries'
import { useSessionEvents } from '../state/use-session-events'
import { answerApproval, setApprovalMode, steerSession } from '../runtime/client'
import type { ApprovalMode, PlanModeState } from '../runtime/types'
import { ThreadView } from './ThreadView'
import { isApprovalConsent } from '../lib/consent'

/**
 * Slim root for a popped-out thread window (Codex-style floating thread).
 * Renders ONLY the thread + composer — no project sidebar, no ReviewPanel,
 * no surface routing. Each pop-out window keeps its own SSE subscription via
 * useSessionEvents/session-event-hub, so multiple windows stream independently.
 * Closing the thread closes the window (the main window keeps the session).
 */
export function PopoutThreadRoot({ sessionId }: { sessionId: string }) {
  const sessions = useSessions()
  const view = useSessionEvents(sessionId)
  const sendPrompt = useSendPrompt()
  const abortSession = useAbortSession()
  const setPlanMode = useSetPlanMode()

  const session = sessions.data?.find((s) => s.id === sessionId) ?? null

  // Same consent bridge as WorkspaceSurface: an unambiguous "同意/approve"
  // typed while a tool waits for approval resolves the approval instead of
  // being sent as prose.
  const tryConsentBridge = useCallback((text: string): boolean => {
    if (!view.pendingApproval) return false
    if (!isApprovalConsent(text)) return false
    void answerApproval(sessionId, view.pendingApproval.requestId, 'approve')
    return true
  }, [sessionId, view.pendingApproval])

  const handleSend = useCallback((prompt: string, images?: string[]) => {
    if (!images?.length && tryConsentBridge(prompt)) return
    sendPrompt.mutate({ id: sessionId, prompt, images })
  }, [sessionId, sendPrompt, tryConsentBridge])

  const handleSteer = useCallback((text: string) => {
    if (tryConsentBridge(text)) return
    void steerSession(sessionId, text).then((r) => {
      if (r === 'idle') sendPrompt.mutate({ id: sessionId, prompt: text })
    })
  }, [sessionId, sendPrompt, tryConsentBridge])

  const handleSetApprovalMode = useCallback((mode: ApprovalMode) => {
    void setApprovalMode(sessionId, mode).then(() => sessions.refetch())
  }, [sessionId, sessions])

  const handleSetPlanMode = useCallback((state: PlanModeState) => {
    setPlanMode.mutate({ id: sessionId, state })
  }, [sessionId, setPlanMode])

  const closeWindow = useCallback(() => {
    void import('@tauri-apps/api/window')
      .then((m) => m.getCurrentWindow().close())
      .catch(() => window.close())
  }, [])

  if (sessions.isLoading) {
    return <div className="popout-root"><div className="empty">加载中…</div></div>
  }
  if (!session) {
    return (
      <div className="popout-root">
        <div className="empty thread-empty">
          <p>会话不存在或已关闭</p>
          <button className="btn sm" onClick={closeWindow}>关闭窗口</button>
        </div>
      </div>
    )
  }

  return (
    <div className="popout-root">
      <ThreadView
        key={session.id}
        session={session}
        view={view}
        onSend={handleSend}
        onSteer={handleSteer}
        onAbort={() => abortSession.mutate(session.id)}
        onSetApprovalMode={handleSetApprovalMode}
        onSetPlanMode={handleSetPlanMode}
        onClose={closeWindow}
        streamStatus={view.streamStatus}
        onRetryStream={view.retryStream}
      />
    </div>
  )
}
