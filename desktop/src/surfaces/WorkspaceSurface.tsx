import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { SurfaceSkeleton } from '../components/Skeleton'
import { qk, useAbortSession, useArtifacts, useCloseSession, useSendPrompt, useSessions, useSetPlanMode, useWorkingTree } from '../state/queries'
import { useUiDispatch, useUiState } from '../state/store'
import { useSessionEvents } from '../state/use-session-events'
import { useJobNotifications } from '../state/use-job-notifications'
import { answerApproval, commitSessionChanges, createSessionPr, mergeSessionBack, setApprovalMode, steerSession } from '../runtime/client'
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
import { parseMcpToolName, previewOf, editableKey, EDIT_TOOLS } from '../lib/approval-preview'
import { isApprovalConsent } from '../lib/consent'
import { DiffView } from '../components/DiffView'
import { deriveProjects, loadKnownProjects } from '../lib/projects'
import { openExternal } from '../lib/open-external'
import { openThreadPopout } from '../lib/popout'
import { isTauri } from '../lib/pty'

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

  const [isFloatDeckOpen, setIsFloatDeckOpen] = useState(false)
  const deckRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isFloatDeckOpen) return
    const onClickOutside = (e: MouseEvent) => {
      if (deckRef.current && !deckRef.current.contains(e.target as Node)) {
        setIsFloatDeckOpen(false)
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [isFloatDeckOpen])

  const active = sessions.data?.find((s) => s.id === activeId) ?? null

  // Terminal working directory — a REAL path, not the project id. The panel
  // used to receive `ui.activeProject` (a `name-hash` slug), which the PTY then
  // treated as a relative dir that doesn't exist. Resolve like App.tsx's
  // defaultCwd: the active thread's own cwd first, then the active project's
  // first root; empty string lets the PTY inherit its default cwd.
  const terminalCwd = useMemo(() => {
    if (active?.cwd) return active.cwd
    if (ui.activeProject) {
      const p = deriveProjects(sessions.data ?? [], loadKnownProjects()).find((x) => x.id === ui.activeProject)
      if (p?.roots[0]) return p.roots[0]
    }
    return ''
  }, [active, sessions.data, ui.activeProject])

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
    (decision: 'approve' | 'reject', editedInput?: Record<string, unknown>, remember?: boolean) => {
      if (!activeId || !view.pendingApproval) return
      void answerApproval(activeId, view.pendingApproval.requestId, decision, editedInput, remember)
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
            <WorkspaceHeader />
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
            {ui.terminalVisible && <TerminalTabs cwd={terminalCwd} />}
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
              sessionRunning={view.status === 'running' || active?.status === 'running'}
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
          <div className="todo-capsule-wrapper" ref={deckRef}>
            {isFloatDeckOpen && (
              <div className="todo-float-deck" onClick={(e) => e.stopPropagation()}>
                <div className="tfd-header">
                  <span className="tfd-title">任务清单 ({done}/{view.todos.length})</span>
                  <button
                    className="tfd-expand-btn"
                    title="展开为侧边栏"
                    onClick={() => {
                      dispatch({ type: 'setReview', visible: true })
                      dispatch({ type: 'setReviewManual', on: true })
                      setIsFloatDeckOpen(false)
                    }}
                  >
                    展开 ↗
                  </button>
                </div>
                <div className="tfd-body">
                  {view.todos.map((t) => (
                    <div key={t.id} className={`tfd-item st-${t.status}`}>
                      <span className="tfd-check">
                        {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◴' : '○'}
                      </span>
                      <span className="tfd-text" title={t.content}>{t.content}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <button
              className={`todo-mini-capsule ${isFloatDeckOpen ? 'active' : ''}`}
              title="查看任务清单"
              onClick={(e) => {
                e.stopPropagation()
                setIsFloatDeckOpen((o) => !o)
              }}
              aria-label="查看任务清单"
            >
              <span className="tmc-glyph" aria-hidden>☑</span>
              <span className="tmc-count">{done}/{view.todos.length}</span>
            </button>
          </div>
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
    case 'computer_use': {
      const app = String(input.app ?? '')
      const action = String(input.action ?? '')
      const actionLabel: Record<string, string> = {
        list_apps: '枚举可见应用',
        snapshot: '读取界面结构并截图',
        find: '查找界面元素',
        wait_for: '等待界面元素出现',
        set_value: '写入控件值',
        click: '点击界面元素',
        double_click: '双击界面元素',
        right_click: '右键点击界面元素',
        scroll: '滚动视图',
        drag: '拖拽元素',
        wait: '等待界面加载',
        type: '输入文本',
        key: '发送快捷键',
        focus_app: '切换到前台',
        launch_app: '启动应用',
        menu_select: '选择菜单项',
        paste_text: '粘贴文本',
      }
      const what = actionLabel[action] ?? action
      let target = ''
      if (action === 'click' || action === 'double_click' || action === 'right_click') {
        target = typeof input.ref === 'number' ? `（元素 #${input.ref}）` : `（坐标 ${String(input.x)}, ${String(input.y)}）`
      } else if (action === 'scroll') {
        const dirLabel: Record<string, string> = { up: '向上', down: '向下', left: '向左', right: '向右' }
        target = input.direction ? `（${dirLabel[String(input.direction)] ?? String(input.direction)}）` : ''
      } else if (action === 'drag') {
        const from = typeof input.from_ref === 'number' ? `#${input.from_ref}` : `(${String(input.from_x)}, ${String(input.from_y)})`
        const to = typeof input.to_ref === 'number' ? `#${input.to_ref}` : `(${String(input.to_x)}, ${String(input.to_y)})`
        target = `（${from} → ${to}）`
      } else if (action === 'type' || action === 'paste_text' || action === 'set_value') {
        const t = String(input.text ?? '')
        target = t ? `（${t.length > 24 ? `${t.slice(0, 24)}…` : t}）` : ''
      } else if (action === 'key') {
        target = input.combo ? `（${String(input.combo)}）` : ''
      } else if (action === 'menu_select') {
        target = input.menu_path ? `（${String(input.menu_path)}）` : ''
      } else if (action === 'find') {
        target = input.query ? `（${String(input.query)}）` : ''
      } else if (action === 'wait_for') {
        target = input.text ? `（${String(input.text)}）` : ''
      }
      return {
        title: app ? `操作应用: ${app}` : '操作桌面应用',
        desc: `Computer Use — ${what}${target}`,
        icon: "🖥️"
      }
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
  onDecision: (decision: 'approve' | 'reject', editedInput?: Record<string, unknown>, remember?: boolean) => void
}

/** Inline approval card — non-blocking, pinned above the composer.
 *  Replaces the old full-screen backdrop modal (Cursor-style inline diff gutter). */
function ApprovalInline({ request, onDecision }: ApprovalModalProps) {
  const preview = previewOf(request)
  const editKey = editableKey(request)
  const [editing, setEditing] = useState(false)
  const [isDiffEditorOpen, setIsDiffEditorOpen] = useState(false)
  const [showDetail, setShowDetail] = useState(false)
  const [draft, setDraft] = useState(
    editKey ? String((request.input as Record<string, unknown>)[editKey] ?? '') : '',
  )
  // Computer Use "always allow": approve+remember records a per-app grant so
  // future actions on this app skip the prompt (server writes the grant store).
  const computerUseApp = request.toolName === 'computer_use'
    ? String((request.input as Record<string, unknown>).app ?? '').trim()
    : ''
  const [rememberApp, setRememberApp] = useState(false)

  const isCodeTool = EDIT_TOOLS.has(request.toolName)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isCmdEnter = (e.metaKey || e.ctrlKey) && e.key === 'Enter'
      if (isCmdEnter) {
        e.preventDefault()
        if (isDiffEditorOpen && editKey) {
          onDecision('approve', { ...request.input, [editKey]: draft }, rememberApp)
          setIsDiffEditorOpen(false)
        } else if (editing && editKey) {
          onDecision('approve', { ...request.input, [editKey]: draft }, rememberApp)
        } else {
          onDecision('approve', undefined, rememberApp)
        }
      } else if (e.key === 'Escape') {
        if (isDiffEditorOpen) {
          e.preventDefault()
          setIsDiffEditorOpen(false)
        } else if (!editing) {
          e.preventDefault()
          onDecision('reject')
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editing, isDiffEditorOpen, draft, request, onDecision, editKey, rememberApp])

  const intent = getApprovalIntent(request.toolName, request.input as Record<string, unknown>)

  const approve = () => {
    if (editing && editKey) onDecision('approve', { ...request.input, [editKey]: draft }, rememberApp)
    else onDecision('approve', undefined, rememberApp)
  }

  const triggerEdit = () => {
    if (isCodeTool) {
      setIsDiffEditorOpen(true)
    } else {
      setEditing((v) => !v)
      if (!editing) setShowDetail(true)
    }
  }

  const originalContent = typeof (request.input as Record<string, unknown>).old_string === 'string'
    ? String((request.input as Record<string, unknown>).old_string)
    : ''

  return (
    <>
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

        {showDetail && !editing && (
          <div className="approval-inline-body">
            {preview.isDiff ? (
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

        {showDetail && editing && editKey && !isCodeTool && (
          <div className="approval-inline-body">
            <textarea
              className="approval-inline-textarea font-mono"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </div>
        )}

        <div className="approval-inline-footer">
          {editKey && (
            <button
              className="btn ghost sm"
              onClick={triggerEdit}
            >
              {isCodeTool ? '编辑代码' : editing ? '取消编辑' : '编辑配置'}
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
          {computerUseApp && (
            <label className="approval-remember flex items-center gap-1.5 text-xs cursor-pointer select-none" title={`以后允许操作 ${computerUseApp}，不再询问（可在设置中撤销）`}>
              <input
                type="checkbox"
                checked={rememberApp}
                onChange={(e) => setRememberApp(e.target.checked)}
              />
              <span>始终允许 {computerUseApp}</span>
            </label>
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

      {isDiffEditorOpen && (
        <div className="approval-diff-editor-overlay" role="dialog" aria-modal="true" onClick={() => setIsDiffEditorOpen(false)}>
          <div className="approval-diff-editor-modal" onClick={(e) => e.stopPropagation()}>
            <div className="adem-header">
              <div className="adem-title flex items-center gap-2">
                <span>📝</span>
                <span>编辑代码修改: {String((request.input as Record<string, unknown>).path || (request.input as Record<string, unknown>).file_path || '新建文件')}</span>
              </div>
              <div className="adem-subtitle">你可以在右侧直接编辑、微调拟定修改，左侧为只读对比源。</div>
            </div>
            
            <div className="adem-body">
              <div className="adem-pane original-pane">
                <div className="adem-pane-title">原始代码 / 先前内容</div>
                <div className="adem-code-box">
                  {originalContent ? (
                    <pre className="font-mono">{originalContent}</pre>
                  ) : (
                    <div className="empty sm muted font-mono text-center pt-8">（新文件或无先前内容）</div>
                  )}
                </div>
              </div>
              <div className="adem-pane proposed-pane">
                <div className="adem-pane-title">拟定修改 (可直接在此处编辑)</div>
                <textarea
                  className="adem-textarea font-mono"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="在此处对代码做出最终的修改微调..."
                  autoFocus
                />
              </div>
            </div>

            <div className="adem-footer">
              <span className="text-xs text-muted">提示: 可按 Esc 退出编辑，按 ⌘↵ (Ctrl+Enter) 应用修改并批准</span>
              <div className="flex items-center gap-2 ml-auto">
                <button className="btn ghost" onClick={() => setIsDiffEditorOpen(false)}>取消</button>
                <button
                  className="btn"
                  onClick={() => {
                    if (editKey) onDecision('approve', { ...request.input, [editKey]: draft })
                    setIsDiffEditorOpen(false)
                  }}
                >
                  应用并批准 (⌘↵)
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function WorkspaceHeader() {
  const ui = useUiState()
  const dispatch = useUiDispatch()
  const sessions = useSessions()
  const abortSession = useAbortSession()
  const activeSession = sessions.data?.find((s) => s.id === ui.activeSessionId) ?? null

  const known = useMemo(() => loadKnownProjects(), [])
  const projects = useMemo(() => deriveProjects(sessions.data ?? [], known), [sessions.data, known])
  const activeProject = projects.find((p: any) => p.id === ui.activeProject)

  const projectName = activeProject?.name || 'Tianshu'

  const pageName = useMemo(() => {
    if (ui.surface === 'workspace' && activeSession) {
      return activeSession.title || activeSession.id.slice(0, 8)
    }
    const SURFACE_NAMES: Record<string, string> = {
      home: '首页',
      attention: '待处理',
      mission: '任务中控台',
      automations: '自动化',
      skills: '智能体技能',
      git: 'Git 版本控制',
      insights: '仓库图谱与分析',
      delegation: '子智能体协同',
      council: '多智能体议事会',
      hooks: '生命周期 Hook',
      settings: '系统设置',
    }
    return SURFACE_NAMES[ui.surface] || ui.surface
  }, [ui.surface, activeSession])

  // Codex-style toolbar state — Git quick menu + overflow, both close on
  // outside click via a shared container ref.
  const onThread = ui.surface === 'workspace' && activeSession !== null
  const running = activeSession?.status === 'running'
  const tree = useWorkingTree(onThread ? activeSession.id : null)
  const hasChanges = Boolean(tree.data?.isRepo) && (tree.data?.files.length ?? 0) > 0
  const isWorktree = Boolean(activeSession?.worktreeBranch)
  const [gitOpen, setGitOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const actionsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!gitOpen && !moreOpen) return
    const onClickOutside = (e: MouseEvent) => {
      if (actionsRef.current && !actionsRef.current.contains(e.target as Node)) {
        setGitOpen(false)
        setMoreOpen(false)
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [gitOpen, moreOpen])

  return (
    <header className="workspace-header" data-tauri-drag-region>
      <div className="workspace-header-path">
        <span className="project-name">{projectName}</span>
        <span className="path-sep">/</span>
        <span className="page-name">{pageName}</span>
      </div>
      <div className="workspace-header-actions" ref={actionsRef}>
        {onThread && running && (
          <button
            className="header-action-btn header-stop-btn"
            title="停止当前运行"
            onClick={() => abortSession.mutate(activeSession.id)}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
            <span>停止</span>
          </button>
        )}
        {onThread && hasChanges && (
          <div className="header-menu-anchor">
            <button
              className={`header-action-btn ${gitOpen ? 'active' : ''}`}
              title="Git 快捷操作"
              onClick={() => { setGitOpen((v) => !v); setMoreOpen(false) }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="6" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <path d="M6 9v6" />
                <circle cx="18" cy="12" r="3" />
                <path d="M15 12a9 9 0 0 0-9-3" />
              </svg>
              <span>Git · {tree.data?.files.length ?? 0}</span>
            </button>
            {gitOpen && (
              <HeaderGitMenu
                sessionId={activeSession.id}
                busy={Boolean(running)}
                isWorktree={isWorktree}
                onClose={() => setGitOpen(false)}
              />
            )}
          </div>
        )}
        <button
          className={`header-action-btn ${ui.terminalVisible ? 'active' : ''}`}
          title="切换终端 (Cmd+J)"
          onClick={() => dispatch({ type: 'setTerminal', visible: !ui.terminalVisible })}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
        </button>
        {onThread && isTauri() && (
          <button
            className="header-action-btn"
            title="弹出为独立小窗"
            onClick={() => { void openThreadPopout(activeSession.id) }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </button>
        )}
        <div className="header-menu-anchor">
          <button
            className={`header-action-btn ${moreOpen ? 'active' : ''}`}
            title="更多"
            aria-label="更多"
            onClick={() => { setMoreOpen((v) => !v); setGitOpen(false) }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <circle cx="5" cy="12" r="2" />
              <circle cx="12" cy="12" r="2" />
              <circle cx="19" cy="12" r="2" />
            </svg>
          </button>
          {moreOpen && (
            <div className="header-menu">
              <button
                className="header-menu-item"
                onClick={() => {
                  setMoreOpen(false)
                  openExternal('https://github.com/huiliyi37/Tianshu-Tui')
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <polygon points="12 2 2 7 12 12 22 7 12 2" />
                  <polyline points="2 17 12 22 22 17" />
                  <polyline points="2 12 12 17 22 12" />
                </svg>
                <span>Install IDE</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}

/** Git quick menu — dropdown reusing the ChangesTab landing mutations
 *  (commit / merge back / create PR) without leaving the thread. */
function HeaderGitMenu(props: { sessionId: string; busy: boolean; isWorktree: boolean; onClose: () => void }) {
  const { sessionId, busy, isWorktree, onClose } = props
  const queryClient = useQueryClient()
  const [commitMsg, setCommitMsg] = useState('')
  const [pending, setPending] = useState<null | 'commit' | 'merge' | 'pr'>(null)

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: qk.workingTree(sessionId) })
  }

  const runCommit = async () => {
    setPending('commit')
    try {
      const r = await commitSessionChanges(sessionId, commitMsg.trim() || undefined)
      if (r.ok && r.nothingToCommit) toast.info('没有可提交的变更')
      else if (r.ok) toast.success(`已提交 ${r.sha?.slice(0, 8) ?? ''}`)
      else toast.error(`提交失败：${r.error ?? ''}`)
      if (r.ok) { refresh(); onClose() }
    } catch (e) {
      toast.error(`提交失败：${String(e)}`)
    } finally {
      setPending(null)
    }
  }

  const runMerge = async () => {
    setPending('merge')
    try {
      const r = await mergeSessionBack(sessionId)
      if (r.ok && r.nothingToMerge) toast.info('没有可合并的提交')
      else if (r.ok) toast.success(`已合并回主分支 ${r.sha?.slice(0, 8) ?? ''}`)
      else if (r.conflictFiles?.length) toast.error(`合并冲突：${r.conflictFiles.join(', ')}`)
      else toast.error(`合并失败：${r.error ?? ''}`)
      if (r.ok) { refresh(); onClose() }
    } catch (e) {
      toast.error(`合并失败：${String(e)}`)
    } finally {
      setPending(null)
    }
  }

  const runPr = async () => {
    setPending('pr')
    try {
      const r = await createSessionPr(sessionId)
      if (r.ok) {
        toast.success('已创建 PR', { action: r.url ? { label: '打开', onClick: () => openExternal(r.url!) } : undefined })
        onClose()
      } else toast.error(`创建 PR 失败：${r.error ?? ''}`)
    } catch (e) {
      toast.error(`创建 PR 失败：${String(e)}`)
    } finally {
      setPending(null)
    }
  }

  const disabled = busy || pending !== null

  return (
    <div className="header-menu header-git-menu">
      {busy && <div className="header-menu-hint">智能体运行中，直接 git 操作已禁用</div>}
      <div className="header-git-commit">
        <input
          type="text"
          value={commitMsg}
          placeholder="提交信息（留空自动生成）"
          disabled={disabled}
          onChange={(e) => setCommitMsg(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !disabled) void runCommit() }}
          autoFocus
        />
        <button className="btn sm" disabled={disabled} onClick={runCommit}>
          {pending === 'commit' ? '…' : '提交'}
        </button>
      </div>
      {isWorktree && (
        <div className="header-git-actions">
          <button className="btn sm ghost" disabled={disabled} onClick={runMerge}>
            {pending === 'merge' ? '…' : '合并回主分支'}
          </button>
          <button className="btn sm ghost" disabled={disabled} onClick={runPr}>
            {pending === 'pr' ? '…' : '创建 PR'}
          </button>
        </div>
      )}
    </div>
  )
}
