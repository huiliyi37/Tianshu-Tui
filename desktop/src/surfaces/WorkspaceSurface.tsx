import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { SurfaceSkeleton } from '../components/Skeleton'
import { useAbortSession, useArtifacts, useCloseSession, useSendPrompt, useSessions, useSetPlanMode } from '../state/queries'
import { useUiDispatch, useUiState } from '../state/store'
import { useSessionEvents } from '../state/use-session-events'
import { useJobNotifications } from '../state/use-job-notifications'
import { answerApproval, setApprovalMode, steerSession } from '../runtime/client'
import type { ApprovalMode, PlanModeState, ApprovalRequest } from '../runtime/types'
import { ProjectSidebar } from './ProjectSidebar'
import { ThreadView } from './ThreadView'
import { ReviewPanel } from './ReviewPanel'
import { TerminalTabs } from '../components/TerminalTabs'
import { JobsDock } from '../components/JobsDock'
import { ThreadTabs } from '../components/ThreadTabs'
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels'
import { loadPanelLayout, saveSidebarWidth, saveReviewWidth, resetPanelLayout } from '../lib/panel-layout'
import { UpdateBanner } from '../components/UpdateBanner'
import { parseMcpToolName, previewOf, editableKey } from '../lib/approval-preview'
import { isApprovalConsent } from '../lib/consent'
import { DiffView } from '../components/DiffView'

const HomeSurface = lazy(() => import('./HomeSurface').then((m) => ({ default: m.HomeSurface })))
const SkillsSurface = lazy(() => import('./SkillsSurface').then((m) => ({ default: m.SkillsSurface })))
const GitSurface = lazy(() => import('./GitSurface').then((m) => ({ default: m.GitSurface })))
const InsightsSurface = lazy(() => import('./InsightsSurface').then((m) => ({ default: m.InsightsSurface })))
const DelegationSurface = lazy(() => import('./DelegationSurface').then((m) => ({ default: m.DelegationSurface })))
const CouncilSurface = lazy(() => import('./CouncilSurface').then((m) => ({ default: m.CouncilSurface })))
const HooksSurface = lazy(() => import('./HooksSurface').then((m) => ({ default: m.HooksSurface })))
const AutomationsSurface = lazy(() => import('./AutomationsSurface').then((m) => ({ default: m.AutomationsSurface })))
const InboxSurface = lazy(() => import('./InboxSurface').then((m) => ({ default: m.InboxSurface })))
const SettingsSurface = lazy(() => import('./SettingsSurface').then((m) => ({ default: m.SettingsSurface })))
const MissionControlSurface = lazy(() => import('./MissionControlSurface').then((m) => ({ default: m.MissionControlSurface })))



export function WorkspaceSurface() {
  const ui = useUiState()
  const dispatch = useUiDispatch()
  const sessions = useSessions()
  const activeId = ui.activeSessionId

  const view = useSessionEvents(activeId)
  useJobNotifications(activeId, view.jobs)
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

  // Consent bridge (Q): when a tool is blocked on approval and the user types an
  // unambiguous whole-message consent, resolve the pending approval instead of
  // sending/steering it as prose — otherwise the message never reaches the
  // approval channel and the model keeps re-hitting the same gate. Returns true
  // when it consumed the input. Guarded on both send and steer paths since a
  // pending approval means the session is running (submits route to steer).
  const tryConsentBridge = useCallback((text: string): boolean => {
    if (!activeId || !view.pendingApproval) return false
    if (!isApprovalConsent(text)) return false
    void answerApproval(activeId, view.pendingApproval.requestId, 'approve')
    return true
  }, [activeId, view.pendingApproval])

  const handleSend = useCallback((prompt: string, images?: string[]) => {
    if (!activeId) return
    if (!images?.length && tryConsentBridge(prompt)) return
    sendPrompt.mutate({ id: activeId, prompt, images })
  }, [activeId, sendPrompt, tryConsentBridge])

  // T3 — queue mid-run guidance. If the run already finished between render and
  // submit (idle), fall back to starting a fresh turn so input is never lost.
  const handleSteer = useCallback((text: string) => {
    if (!activeId) return
    if (tryConsentBridge(text)) return
    void steerSession(activeId, text).then((r) => {
      if (r === 'idle') sendPrompt.mutate({ id: activeId, prompt: text })
    })
  }, [activeId, sendPrompt, tryConsentBridge])

  const handleApproval = useCallback(
    (decision: 'approve' | 'reject', editedInput?: Record<string, unknown>) => {
      if (!activeId || !view.pendingApproval) return
      void answerApproval(activeId, view.pendingApproval.requestId, decision, editedInput)
    },
    [activeId, view.pendingApproval],
  )

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
          onResize={(size, _id, prev) => {
            const pct = Math.round(size.asPercentage)
            if (pct > 0) saveSidebarWidth(pct)
            // react-resizable-panels v4 dropped onCollapse/onExpand — derive the
            // collapse transition from size (collapsedSize defaults to 0%).
            const wasCollapsed = prev != null && prev.asPercentage <= 0
            const nowCollapsed = size.asPercentage <= 0
            if (nowCollapsed && !wasCollapsed) dispatch({ type: 'setSidebar', visible: false })
            else if (!nowCollapsed && wasCollapsed) dispatch({ type: 'setSidebar', visible: true })
          }}
        >
          {ui.sidebarVisible ? (
            <ProjectSidebar
              onCollapse={() => {
                dispatch({ type: 'setSidebar', visible: false })
              }}
            />
          ) : (
            <div className="panel-collapsed-placeholder" aria-hidden="true" />
          )}
        </Panel>
        <Separator className={`panel-resize-handle ${!ui.sidebarVisible ? 'collapsed' : ''}`}>
          {ui.sidebarVisible && (
            <button
              className="resize-handle-knob left"
              onClick={(e) => {
                e.stopPropagation()
                dispatch({ type: 'setSidebar', visible: false })
              }}
              title="收起侧边栏"
            >
              ‹
            </button>
          )}
        </Separator>
        <Panel minSize="30%">
          <div className="conversation">
            <div className="conversation-body">
              <ThreadTabs />
              <Suspense fallback={<SurfaceSkeleton />}>
                {ui.surface === 'home' ? <HomeSurface /> :
                 ui.surface === 'mission' ? <MissionControlSurface /> :
                 ui.surface === 'delegation' ? <DelegationSurface /> :
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
        <Separator className={`panel-resize-handle ${!ui.reviewVisible ? 'collapsed' : ''}`}>
          {ui.reviewVisible && (
            <button
              className="resize-handle-knob right"
              onClick={(e) => {
                e.stopPropagation()
                dispatch({ type: 'setReview', visible: false })
              }}
              title="收起审查面板"
            >
              ›
            </button>
          )}
        </Separator>
        <Panel
          panelRef={reviewRef}
          collapsible
          defaultSize={`${layout.review}%`}
          minSize="15%"
          maxSize="45%"
          onResize={(size, _id, prev) => {
            const pct = Math.round(size.asPercentage)
            if (pct > 0) saveReviewWidth(pct)
            const wasCollapsed = prev != null && prev.asPercentage <= 0
            const nowCollapsed = size.asPercentage <= 0
            if (nowCollapsed && !wasCollapsed) dispatch({ type: 'setReview', visible: false })
            else if (!nowCollapsed && wasCollapsed) dispatch({ type: 'setReview', visible: true })
          }}
        >
          {ui.reviewVisible ? (
            <ReviewPanel
              sessionId={activeId}
              cwd={active?.cwd}
              artifacts={artifacts.data ?? []}
              pendingApproval={view.pendingApproval}
              approvalMode={active?.approvalMode}
              planMode={view.planMode}
              planRev={view.planRev}
              latestPlanSlug={view.latestPlanSlug}
              onFeedbackSent={() => sessions.refetch()}
              todos={view.todos}
              sources={view.sources}
              onSendPrompt={handleSteer}
              onCollapse={() => {
                dispatch({ type: 'setReview', visible: false })
              }}
            />
          ) : (
            <div className="panel-collapsed-placeholder" aria-hidden="true" />
          )}
        </Panel>
      </Group>

      {activeId && Object.keys(view.jobs).length > 0 && (
        <JobsDock
          sessionId={activeId}
          jobs={Object.values(view.jobs).sort((a, b) => b.startedAt - a.startedAt)}
          visible={ui.jobsDockVisible}
          onToggle={() => dispatch({ type: 'setJobsDock', visible: !ui.jobsDockVisible })}
          onOpenTerminal={() => dispatch({ type: 'setTerminal', visible: true })}
        />
      )}

      {!ui.reviewVisible && view.todos.length > 0 && (() => {
        const done = view.todos.filter((t) => t.status === 'completed').length
        return (
          <button
            className="todo-mini-capsule"
            title="展开任务清单（审查面板）"
            onClick={() => {
              dispatch({ type: 'setReview', visible: true })
              dispatch({ type: 'setReviewManual', on: true })
            }}
            aria-label="展开任务清单"
          >
            <span className="tmc-glyph" aria-hidden>☑</span>
            <span className="tmc-count">{done}/{view.todos.length}</span>
          </button>
        )
      })()}

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

      {view.pendingApproval && (
        <ApprovalInline
          request={view.pendingApproval}
          onDecision={handleApproval}
        />
      )}
    </div>
  )
}

function getApprovalIntent(toolName: string, input: Record<string, unknown>): { title: string; desc: string; icon: string } {
  const mcp = parseMcpToolName(toolName)
  if (mcp) {
    return {
      title: `调用外部工具: ${mcp.toolName}`,
      desc: `通过 MCP 连接器 [${mcp.serverId}] 执行操作`,
      icon: "🔌"
    }
  }
  
  const path = String(input.path ?? input.file_path ?? input.target ?? "")
  // Windows tool inputs may use backslashes — split on both separators.
  const base = path.split(/[\\/]/).pop()
  switch (toolName) {
    case 'write_file':
    case 'create_file':
      return {
        title: "创建/写入新文件",
        desc: path ? `写入文件: ${base} (${path})` : "在工作区写入新文件",
        icon: "📝"
      }
    case 'edit_file':
    case 'apply_patch':
    case 'hash_edit':
      return {
        title: "修改现有文件",
        desc: path ? `修改文件: ${base} (${path})` : "对工作区文件进行代码修改",
        icon: "⚡"
      }
    case 'read_file':
      return {
        title: "读取文件内容",
        desc: path ? `读取文件: ${base} (${path})` : "读取工作区文件",
        icon: "🔍"
      }
    case 'execute_bash':
      return {
        title: "执行终端命令",
        desc: `在系统终端中运行命令: \`${String(input.command ?? "")}\``,
        icon: "💻"
      }
    default:
      return {
        title: `调用系统工具: ${toolName}`,
        desc: "请求执行系统级或工作区级操作",
        icon: "⚙️"
      }
  }
}

interface ApprovalModalProps {
  request: ApprovalRequest
  onDecision: (decision: 'approve' | 'reject', editedInput?: Record<string, unknown>) => void
}

/** Inline approval card — non-blocking, pinned above the composer.
 *  Replaces the old full-screen backdrop modal (Cursor-style inline diff gutter). */
function ApprovalInline({ request, onDecision }: ApprovalModalProps) {
  const preview = previewOf(request)
  const editKey = editableKey(request)
  const [editing, setEditing] = useState(false)
  const [showDetail, setShowDetail] = useState(false)
  const [draft, setDraft] = useState(
    editKey ? String((request.input as Record<string, unknown>)[editKey] ?? '') : '',
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isCmdEnter = (e.metaKey || e.ctrlKey) && e.key === 'Enter'
      if (isCmdEnter) {
        e.preventDefault()
        if (editing && editKey) onDecision('approve', { ...request.input, [editKey]: draft })
        else onDecision('approve')
      } else if (e.key === 'Escape' && !editing) {
        e.preventDefault()
        onDecision('reject')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editing, draft, request, onDecision, editKey])

  const intent = getApprovalIntent(request.toolName, request.input as Record<string, unknown>)

  const approve = () => {
    if (editing && editKey) onDecision('approve', { ...request.input, [editKey]: draft })
    else onDecision('approve')
  }

  return (
    <div className="approval-inline">
      <div className="approval-inline-header">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-lg shrink-0">{intent.icon}</span>
          <div className="min-w-0">
            <div className="approval-inline-title truncate">{intent.title}</div>
            <div className="approval-inline-subtitle truncate" title={intent.desc}>{intent.desc}</div>
          </div>
        </div>
        <span className="approval-inline-badge shrink-0">需批准</span>
      </div>

      {showDetail && (
        <div className="approval-inline-body">
          {editing && editKey ? (
            <textarea
              className="approval-inline-textarea font-mono"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          ) : preview.isDiff ? (
            <div className="approval-inline-diff overflow-auto max-h-[260px] border border-border rounded">
              <DiffView raw={preview.text} />
            </div>
          ) : (
            <pre className="approval-inline-pre font-mono overflow-auto max-h-[260px] border border-border rounded p-2 bg-panel-2 text-xs">
              {preview.text}
            </pre>
          )}
        </div>
      )}

      <div className="approval-inline-footer">
        {editKey && (
          <button
            className="btn ghost sm"
            onClick={() => { setEditing((v) => !v); if (!editing) setShowDetail(true) }}
          >
            {editing ? '取消编辑' : '编辑代码'}
          </button>
        )}
        {!editing && (
          <button
            className="btn ghost sm"
            onClick={() => setShowDetail((v) => !v)}
          >
            {showDetail ? '收起详情' : '查看详情'}
          </button>
        )}
        <div className="flex items-center gap-2 ml-auto">
          <button
            className="btn ghost sm"
            onClick={() => onDecision('reject')}
          >
            拒绝 (Esc)
          </button>
          <button
            className="btn sm"
            onClick={approve}
            autoFocus
          >
            {editing ? '应用并批准' : '批准 (⌘↵)'}
          </button>
        </div>
      </div>
    </div>
  )
}
