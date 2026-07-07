import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pin, PinOff } from 'lucide-react'
import { useAbortSession, useSendPrompt, useSessions, useSetPlanMode } from '../state/queries'
import { useSessionEvents } from '../state/use-session-events'
import { answerApproval, setApprovalMode, steerSession } from '../runtime/client'
import type { ApprovalMode, PlanModeState } from '../runtime/types'
import { ThreadView } from './ThreadView'
import { isApprovalConsent } from '../lib/consent'
import { ApprovalInline } from '../components/ApprovalInline'

/**
 * Slim root for a popped-out thread window (Codex-style floating thread).
 * Renders ONLY the thread + composer — no project sidebar, no ReviewPanel,
 * no surface routing. Each pop-out window keeps its own SSE subscription via
 * useSessionEvents/session-event-hub, so multiple windows stream independently.
 * Closing the thread closes the window (the main window keeps the session).
 */
export function PopoutThreadRoot({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation('shell')
  const sessions = useSessions()
  const view = useSessionEvents(sessionId)
  const sendPrompt = useSendPrompt()
  const abortSession = useAbortSession()
  const setPlanMode = useSetPlanMode()

  const session = sessions.data?.find((s) => s.id === sessionId) ?? null
  const [pinned, setPinned] = useState(false)

  // Window title follows the thread title (falls back to the short id).
  const sessionTitle = session?.title?.trim() || sessionId.slice(0, 8)
  useEffect(() => {
    void import('@tauri-apps/api/window')
      .then((m) => m.getCurrentWindow().setTitle(t('popout.windowTitle', { title: sessionTitle })))
      .catch(() => { /* browser dev mode — no Tauri window */ })
  }, [sessionTitle, t])

  const togglePin = useCallback(() => {
    const next = !pinned
    void import('@tauri-apps/api/window')
      .then((m) => m.getCurrentWindow().setAlwaysOnTop(next))
      .then(() => setPinned(next))
      .catch(() => { /* browser dev mode — no Tauri window */ })
  }, [pinned])

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

  const handleApproval = useCallback(
    (decision: 'approve' | 'reject', editedInput?: Record<string, unknown>, remember?: boolean) => {
      if (!view.pendingApproval) return
      void answerApproval(sessionId, view.pendingApproval.requestId, decision, editedInput, remember)
    },
    [sessionId, view.pendingApproval],
  )

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
    return <div className="popout-root"><div className="empty">{t('common:loading')}</div></div>
  }
  if (!session) {
    return (
      <div className="popout-root">
        <div className="empty thread-empty">
          <p>{t('popout.sessionGone')}</p>
          <button className="btn sm" onClick={closeWindow}>{t('popout.closeWindow')}</button>
        </div>
      </div>
    )
  }

  return (
    <div className="popout-root">
      <div className="popout-toolbar" data-tauri-drag-region>
        <span className="popout-toolbar-title" data-tauri-drag-region>{sessionTitle}</span>
        <button
          className={`btn ghost sm popout-pin ${pinned ? 'active' : ''}`}
          onClick={togglePin}
          title={pinned ? t('popout.unpin') : t('popout.pin')}
          aria-pressed={pinned}
        >
          {pinned ? <PinOff size={13} aria-hidden /> : <Pin size={13} aria-hidden />}
        </button>
      </div>
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
      {view.pendingApproval && (
        <ApprovalInline
          request={view.pendingApproval}
          onDecision={handleApproval}
        />
      )}
    </div>
  )
}
