import { lazy, Suspense, useCallback, useEffect, useRef } from 'react'
import { useAbortSession, useArtifacts, useCloseSession, useSendPrompt, useSessions, useSetPlanMode } from '../state/queries'
import { useUiDispatch, useUiState } from '../state/store'
import { useSessionEvents } from '../state/use-session-events'
import { answerApproval, answerIntent, setApprovalMode, steerSession } from '../runtime/client'
import type { ApprovalMode, PlanModeState } from '../runtime/types'
import { ProjectSidebar } from './ProjectSidebar'
import { ThreadView } from './ThreadView'
import { ReviewPanel } from './ReviewPanel'
import { TerminalTabs } from '../components/TerminalTabs'
import { ThreadTabs } from '../components/ThreadTabs'
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels'
import { loadPanelLayout, saveSidebarWidth, saveReviewWidth, resetPanelLayout } from '../lib/panel-layout'
import { UpdateBanner } from '../components/UpdateBanner'

const SkillsSurface = lazy(() => import('./SkillsSurface').then((m) => ({ default: m.SkillsSurface })))
const GitSurface = lazy(() => import('./GitSurface').then((m) => ({ default: m.GitSurface })))
const InsightsSurface = lazy(() => import('./InsightsSurface').then((m) => ({ default: m.InsightsSurface })))
const DelegationSurface = lazy(() => import('./DelegationSurface').then((m) => ({ default: m.DelegationSurface })))
const CouncilSurface = lazy(() => import('./CouncilSurface').then((m) => ({ default: m.CouncilSurface })))
const HooksSurface = lazy(() => import('./HooksSurface').then((m) => ({ default: m.HooksSurface })))
const AutomationsSurface = lazy(() => import('./AutomationsSurface').then((m) => ({ default: m.AutomationsSurface })))
const InboxSurface = lazy(() => import('./InboxSurface').then((m) => ({ default: m.InboxSurface })))
const SettingsSurface = lazy(() => import('./SettingsSurface').then((m) => ({ default: m.SettingsSurface })))



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

  const layout = loadPanelLayout()

  const handleResetLayout = () => {
    const next = resetPanelLayout()
    sidebarRef.current?.resize(next.sidebar)
    reviewRef.current?.resize(next.review)
  }

  return (
    <div ref={wsRef} className="workspace-resizable">
      <UpdateBanner />
      <button
        className="layout-reset-btn"
        title="重置布局"
        aria-label="重置布局"
        onClick={handleResetLayout}
      >
        ⟲
      </button>
      <Group orientation="horizontal" style={{ height: '100%' }}>
        <Panel
          panelRef={sidebarRef}
          collapsible
          defaultSize={`${layout.sidebar}%`}
          minSize="12%"
          maxSize="35%"
          onResize={({ asPercentage }) => saveSidebarWidth(Math.round(asPercentage))}
        >
          <ProjectSidebar
            onCollapse={() => {
              dispatch({ type: 'setSidebar', visible: false })
            }}
          />
        </Panel>
        <Separator className="panel-resize-handle" />
        <Panel minSize="30%">
          <div className="conversation">
            <div className="conversation-body">
              <ThreadTabs />
              <Suspense fallback={<div className="surface-loading">加载中…</div>}>
                {ui.surface === 'delegation' ? <DelegationSurface /> :
                 ui.surface === 'skills' ? <SkillsSurface /> :
                 ui.surface === 'git' ? <GitSurface /> :
                 ui.surface === 'insights' ? <InsightsSurface /> :
                 ui.surface === 'council' ? <CouncilSurface /> :
                 ui.surface === 'hooks' ? <HooksSurface /> :
                 ui.surface === 'automations' ? <AutomationsSurface /> :
                 ui.surface === 'attention' ? <InboxSurface /> :
                 ui.surface === 'settings' ? <SettingsSurface /> :
                 active ? (
                  <ThreadView
                    key={active.id}
                    session={active}
                    view={view}
                    onSend={handleSend}
                    onSteer={handleSteer}
                    onAbort={() => abortSession.mutate(active.id)}
                    onSetApprovalMode={handleSetApprovalMode}
                    onSetPlanMode={handleSetPlanMode}
                    onClose={handleClose}
                    streamStatus={view.streamStatus}
                    onRetryStream={view.retryStream}
                  />
                ) : (
                   <div className="empty thread-empty onboard">
                     <div className="onboard-glyph" aria-hidden>✦</div>
                     <h2 className="onboard-title">开始你的第一个线程</h2>
                     <p className="onboard-subtitle">天枢会理解你的项目，自主完成编码任务</p>
                     
                     <div className="onboard-templates">
                       <button className="template-card" onClick={() => dispatch({ type: 'openNew', open: true, prompt: '分析并解释当前项目的整体架构' })}>
                         <span className="tc-emoji">🔍</span>
                         <div className="tc-text">
                           <span className="tc-title">代码库诊断</span>
                           <span className="tc-desc">分析项目结构与潜在风险</span>
                         </div>
                       </button>
                       <button className="template-card" onClick={() => dispatch({ type: 'openNew', open: true, prompt: '为当前项目实现一个新功能' })}>
                         <span className="tc-emoji">⚡</span>
                         <div className="tc-text">
                           <span className="tc-title">实现新功能</span>
                           <span className="tc-desc">编写新的模块或 API 接口</span>
                         </div>
                       </button>
                       <button className="template-card" onClick={() => dispatch({ type: 'openNew', open: true, prompt: '查找并修复项目中已知的故障' })}>
                         <span className="tc-emoji">🐛</span>
                         <div className="tc-text">
                           <span className="tc-title">修复故障</span>
                           <span className="tc-desc">定位并消除潜在的代码 Bug</span>
                         </div>
                       </button>
                     </div>

                     <div className="onboard-actions">
                       <button className="btn btn-primary" onClick={() => dispatch({ type: 'openNew', open: true })}>
                         + 自定义新建线程
                       </button>
                     </div>
                     <div className="onboard-hints">
                       <div className="onboard-hint">
                         <kbd>⌘K</kbd>
                         <span>打开命令面板</span>
                       </div>
                       <div className="onboard-hint">
                         <kbd>⌘N</kbd>
                         <span>新建线程</span>
                       </div>
                       <div className="onboard-hint">
                         <kbd>/</kbd>
                         <span>在输入框使用斜杠命令</span>
                       </div>
                     </div>
                   </div>
                )}
              </Suspense>
            </div>
            {ui.terminalVisible && <TerminalTabs cwd={ui.activeProject ?? ''} />}
          </div>
        </Panel>
        <Separator className="panel-resize-handle" />
        <Panel
          panelRef={reviewRef}
          collapsible
          defaultSize={`${layout.review}%`}
          minSize="15%"
          maxSize="45%"
          onResize={({ asPercentage }) => saveReviewWidth(Math.round(asPercentage))}
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
            onCollapse={() => {
              dispatch({ type: 'setReview', visible: false })
            }}
          />
        </Panel>
      </Group>

      {!ui.reviewVisible && (
        <button
          className="review-expand-capsule"
          title="展开审查面板 (Cmd+Shift+B)"
          onClick={() => {
            dispatch({ type: 'setReview', visible: true })
            dispatch({ type: 'setReviewManual', on: true })
          }}
          aria-label="展开审查面板"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M15 18l-6-6 6-6" />
          </svg>
          <span className="capsule-text">审查面板</span>
        </button>
      )}

      {!ui.sidebarVisible && (
        <button
          className="sidebar-expand-capsule"
          title="展开侧边栏 (Cmd+B)"
          onClick={() => {
            dispatch({ type: 'setSidebar', visible: true })
          }}
          aria-label="展开侧边栏"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M9 6l6 6-6 6" />
          </svg>
          <span className="capsule-text">项目侧边栏</span>
        </button>
      )}
    </div>
  )
}
