import { useCallback, useEffect, useRef } from 'react'
import { useAbortSession, useArtifacts, useCloseSession, useSendPrompt, useSessions, useSetPlanMode } from '../state/queries'
import { useUiDispatch, useUiState } from '../state/store'
import { useSessionEvents } from '../state/use-session-events'
import { answerApproval, answerIntent, setApprovalMode, steerSession } from '../runtime/client'
import type { ApprovalMode, PlanModeState } from '../runtime/types'
import { ProjectSidebar } from './ProjectSidebar'
import { ThreadView } from './ThreadView'
import { ReviewPanel } from './ReviewPanel'
import { TerminalPanel } from '../components/TerminalPanel'
import { ThreadTabs } from '../components/ThreadTabs'
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels'

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

  // Responsive: auto-collapse review panel when workspace < 1200px.
  // Uses ResizeObserver — only fires when the element actually resizes.
  // A `reviewManuallyToggled` flag prevents the observer from fighting the
  // user: if the user pressed Cmd+Shift+B to open the panel, we don't
  // auto-close it. The flag resets when width recovers above threshold.
  const wsRef = useRef<HTMLDivElement>(null)
  const reviewVisibleRef = useRef(ui.reviewVisible)
  reviewVisibleRef.current = ui.reviewVisible
  const reviewManualRef = useRef(ui.reviewManuallyToggled)
  reviewManualRef.current = ui.reviewManuallyToggled

  useEffect(() => {
    const el = wsRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return
      const w = entry.contentRect.width
      if (w < 1200) {
        if (reviewVisibleRef.current && !reviewManualRef.current) {
          dispatch({ type: 'setReview', visible: false })
        }
      } else {
        // Width recovered — reset manual flag so auto-collapse works again
        // next time the window shrinks.
        if (reviewManualRef.current) {
          dispatch({ type: 'setReviewManual', on: false })
        }
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [dispatch])

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
    dispatch({ type: 'closeTab', id: activeId })
  }, [activeId, closeSession, dispatch])
  const sidebarRef = usePanelRef()
  const reviewRef = usePanelRef()

  // Sync panel collapse/expand with the ui state (Cmd+\, Cmd+Shift+B).
  useEffect(() => {
    const p = sidebarRef.current
    if (!p) return
    if (ui.sidebarVisible) p.expand()
    else p.collapse()
  }, [ui.sidebarVisible])
  useEffect(() => {
    const p = reviewRef.current
    if (!p) return
    if (ui.reviewVisible) p.expand()
    else p.collapse()
  }, [ui.reviewVisible])

  const sidebarSize = parseInt(localStorage.getItem('rivet:sidebar-w') ?? '18', 10)
  const reviewSize = parseInt(localStorage.getItem('rivet:review-w') ?? '27', 10)
  return (
    <div ref={wsRef} className="workspace-resizable">
      <Group orientation="horizontal" style={{ height: '100%' }}>
        <Panel
          panelRef={sidebarRef}
          collapsible
          defaultSize={`${sidebarSize}%`}
          minSize="12%"
          maxSize="35%"
          onResize={({ asPercentage }) => localStorage.setItem('rivet:sidebar-w', String(Math.round(asPercentage)))}
        >
          <ProjectSidebar />
        </Panel>
        <Separator className="panel-resize-handle" />
        <Panel minSize="30%">
          <div className="conversation">
            <div className="conversation-body">
              <ThreadTabs />
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
            {ui.terminalVisible && <TerminalPanel cwd={ui.activeProject ?? ''} />}
          </div>
        </Panel>
        <Separator className="panel-resize-handle" />
        <Panel
          panelRef={reviewRef}
          collapsible
          defaultSize={`${reviewSize}%`}
          minSize="15%"
          maxSize="45%"
          onResize={({ asPercentage }) => localStorage.setItem('rivet:review-w', String(Math.round(asPercentage)))}
        >
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
        </Panel>
      </Group>

      {!ui.reviewVisible && (
        <button
          className="review-expand-hint"
          title="展开审查面板 (Cmd+Shift+B)"
          onClick={() => {
            dispatch({ type: 'setReview', visible: true })
            dispatch({ type: 'setReviewManual', on: true })
          }}
          aria-label="展开审查面板"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M11 17l-5-5 5-5M18 17l-5-5 5-5" />
          </svg>
        </button>
      )}
    </div>
  )
}
