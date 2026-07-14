import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  getArtifact,
  openFile,
  getFileContent,
  sendArtifactFeedback,
  getRollbackPreview,
  rollbackSession,
  type RollbackResult,
} from '../runtime/client'
import type { ApprovalMode, ApprovalRequest, ArtifactSummary, FileContent, LineComment, PlanModeState, TodoStateItem, SessionRecord } from '../runtime/types'
import { useEnabledTabs } from '../lib/review-tabs'
import { useSessions } from '../state/queries'
import { DiffView } from '../components/DiffView'
import { FilePath } from '../components/FilePath'
import { FileViewer } from '../components/FileViewer'
import { Markdown } from '../components/Markdown'
import { PlanPanel } from './PlanPanel'
import { TodoDock } from '../components/TodoDock'
import { GithubPanel } from './GithubPanel'
import { BrowserPanel } from './BrowserPanel'
import { FileExplorer } from '../components/FileExplorer'
import { ChangesTab } from './ChangesTab'
import { WalkthroughViewer } from '../components/WalkthroughViewer'
import { useProLicense } from '../lib/use-activation-gate'
import { isAutonomous } from '../lib/autonomy'
import { useUiDispatch, useUiState } from '../state/store'
import { Folder, Globe, Terminal as TerminalIcon, ChevronRight as ChevronRightIcon } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

import type { ReviewTab } from '../lib/review-tabs'

interface TabDef {
  id: ReviewTab
  label: string
  glyph: string
  badge?: () => number | null
}

// Review panel (P3/Q3) — Codex's third pane. Aggregates the trust-layer surfaces
// of the active thread: pending approvals handled INLINE (no blocking modal) +
// artifacts/diff/screenshots. Intent direction notes are non-blocking timeline
// cards (rendered in ThreadView), not handled here. The tab bar reserves slots
// for future CVM council/sensorium views (not rendered yet).
export function ReviewPanel(props: {
  sessionId: string | null
  cwd?: string
  artifacts: ArtifactSummary[]
  pendingApproval: ApprovalRequest | null
  approvalMode?: ApprovalMode
  planMode?: PlanModeState
  planRev?: number
  latestPlanSlug?: string
  draftLive?: { path: string; title: string | null; content: string; size: number } | null
  onFeedbackSent?: () => void
  /** T2 — active task list for the Task tab. */
  todos?: TodoStateItem[]
  /** Source files touched by file-editing tools. */
  sources?: string[]
  onCollapse?: () => void
  /** P1-3 — Changes tab line comments send through the thread's prompt channel. */
  onSendPrompt?: (text: string) => void
  /** Plan Build requires an idle session — disables the button with a hint. */
  sessionRunning?: boolean
}) {
  const { sessionId, cwd, artifacts, pendingApproval, approvalMode, planMode, planRev = 0, latestPlanSlug, draftLive = null, onFeedbackSent, todos = [], sources = [], onCollapse, onSendPrompt, sessionRunning } = props
  const { t } = useTranslation('review')
  const autonomous = isAutonomous(approvalMode)
  const [enabledTabs] = useEnabledTabs()
  const [tab, setTab] = useState<ReviewTab>('files')
  const dispatch = useUiDispatch()

  // Codex 对标（Wave 4）：右栏默认渲染资源启动器（文件 ⌘P / 浏览器 ⌘T /
  // 终端 ⌘J），任何显式导航（tab 请求 / 规划开始 / 新计划落地）都会解除。
  // 换会话时回到启动器空态。
  const [launcher, setLauncher] = useState(true)
  useEffect(() => {
    setLauncher(true)
  }, [sessionId])

  // External tab-focus requests (e.g. ArtifactCard "Review" in the thread).
  const { reviewTabRequest } = useUiState()
  const seenTabReq = useRef(0)
  useEffect(() => {
    if (!reviewTabRequest || reviewTabRequest.rev === seenTabReq.current) return
    seenTabReq.current = reviewTabRequest.rev
    let requested = reviewTabRequest.tab as any
    if (requested === 'review' || requested === 'wt') {
      requested = 'changes'
    } else if (requested === 'plan' || requested === 'task') {
      requested = 'tasks'
    }
    if (['changes', 'tasks', 'files', 'canvas', 'github', 'browser'].includes(requested)) {
      setTab(requested as ReviewTab)
      setLauncher(false)
    }
  }, [reviewTabRequest])

  // Tabs scroll & overflow detection
  const tabsListRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  const checkScroll = useCallback(() => {
    const el = tabsListRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 1)
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1)
  }, [])

  useEffect(() => {
    const el = tabsListRef.current
    if (!el) return
    checkScroll()
    window.addEventListener('resize', checkScroll)
    const t1 = setTimeout(checkScroll, 200)
    const t2 = setTimeout(checkScroll, 600)

    const ro = new ResizeObserver(checkScroll)
    ro.observe(el)

    return () => {
      window.removeEventListener('resize', checkScroll)
      clearTimeout(t1)
      clearTimeout(t2)
      ro.disconnect()
    }
  }, [checkScroll])

  // Re-check after the active tab changes: base-ui may auto-scroll the list to
  // keep the selected tab in view, which can leave scrollLeft in the middle and
  // hide the left arrow if our state hasn't caught up.
  useEffect(() => {
    const t = setTimeout(checkScroll, 50)
    return () => clearTimeout(t)
  }, [tab, checkScroll])

  const scrollTabs = (direction: 'left' | 'right') => {
    const el = tabsListRef.current
    if (!el) return
    const amount = 120
    el.scrollBy({
      left: direction === 'left' ? -amount : amount,
      behavior: 'smooth',
    })
  }

  const onWheelTabs = (e: React.WheelEvent<HTMLDivElement>) => {
    const el = tabsListRef.current
    if (!el) return
    const dx = e.deltaY !== 0 ? e.deltaY : e.deltaX
    if (Math.abs(dx) < 1) return
    e.preventDefault()
    el.scrollBy({ left: dx, behavior: 'smooth' })
  }

  // Auto-focus the tasks tab when planning starts or a fresh plan lands, so the
  // reviewable plan surfaces without a manual tab switch (Cursor 3.0 flow).
  const prevSlug = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (planMode === 'planning') {
      setTab('tasks')
      setLauncher(false)
    }
  }, [planMode])
  useEffect(() => {
    if (latestPlanSlug && latestPlanSlug !== prevSlug.current) {
      prevSlug.current = latestPlanSlug
      setTab('tasks')
      setLauncher(false)
    }
  }, [latestPlanSlug])
  // 有待审批时资源启动器让位给审查视图（badge 在 Changes tab 上）。
  useEffect(() => {
    if (pendingApproval) setLauncher(false)
  }, [pendingApproval])
  const [open, setOpen] = useState<{ artifact: ArtifactSummary; raw: string } | null>(null)
  const [viewMode, setViewMode] = useState<'rendered' | 'raw'>('rendered')
  const [comment, setComment] = useState('')
  // 行级评论：在 diff 弹窗里逐行累积，随 artifact 级 comment 一起回灌
  const [lineComments, setLineComments] = useState<LineComment[]>([])

  // Live Canvas state
  const [selectedCanvasArtifact, setSelectedCanvasArtifact] = useState<ArtifactSummary | null>(null)
  const [canvasContent, setCanvasContent] = useState<string>('')
  const [canvasLoading, setCanvasLoading] = useState<boolean>(false)
  const [canvasWidth, setCanvasWidth] = useState<'100%' | '768px' | '375px'>('100%')
  // 自增触发「刷新」：进 content effect 依赖 → 重新从盘上拉取，同时作为 iframe key 强制重挂。
  const [canvasKey, setCanvasKey] = useState<number>(0)
  // 全屏预览：复用同一沙箱 iframe 做 app 内全屏覆盖层，取代未沙箱化的 blob
  // window.open（后者在本 Tauri 配置下既是脚本逃逸入口、又打不开真正的外部浏览器）。
  const [canvasFullscreen, setCanvasFullscreen] = useState<boolean>(false)

  const canvasArtifacts = useMemo(() => {
    return artifacts.filter((a) => a.kind === 'html' || a.kind === 'markdown' || a.target.endsWith('.html') || a.target.endsWith('.md') || a.target.endsWith('.css'))
  }, [artifacts])

  // 付费版 v1 · T1 — 走查工件（walkthrough-recorder 落的运行回放）。取最新一份。
  const walkthroughArtifact = useMemo(() => {
    const list = artifacts.filter((a) => a.tool === 'walkthrough')
    return list.length > 0 ? list[list.length - 1]! : null
  }, [artifacts])
  const { isPro } = useProLicense()

  // Esc 退出全屏预览。
  useEffect(() => {
    if (!canvasFullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCanvasFullscreen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canvasFullscreen])

  // 切会话或工件被移除时，当前选中项可能已不在列表里：回落到首个，避免拿旧会话的
  // artifactId 去取（404）以及 <select> 显示一个不在选项中的越界值。
  useEffect(() => {
    if (canvasArtifacts.length === 0) {
      if (selectedCanvasArtifact) setSelectedCanvasArtifact(null)
      return
    }
    const stillPresent = selectedCanvasArtifact && canvasArtifacts.some((a) => a.id === selectedCanvasArtifact.id)
    if (!stillPresent) setSelectedCanvasArtifact(canvasArtifacts[0]!)
  }, [canvasArtifacts, selectedCanvasArtifact])

  useEffect(() => {
    if (selectedCanvasArtifact && sessionId) {
      setCanvasLoading(true)
      getArtifact(sessionId, selectedCanvasArtifact.id)
        .then((res) => {
          setCanvasContent(res.raw)
        })
        .catch((err) => {
          console.error(err)
        })
        .finally(() => {
          setCanvasLoading(false)
        })
    } else {
      setCanvasContent('')
    }
    // canvasKey 进依赖：点「刷新」重新拉取盘上最新内容（而非仅重挂 iframe）。
  }, [selectedCanvasArtifact, sessionId, canvasKey])
  const [sending, setSending] = useState(false)
  const [fileContent, setFileContent] = useState<FileContent | null>(null)
  const [fileLoading, setFileLoading] = useState(false)

  const view = useCallback(async (a: ArtifactSummary) => {
    if (!sessionId) return
    try {
      setOpen(await getArtifact(sessionId, a.id))
      setViewMode(a.kind === 'markdown' || a.kind === 'html' ? 'rendered' : 'raw')
      setComment('')
      setLineComments([])
    } catch {
      // ignore
    }
  }, [sessionId])

  const viewFile = useCallback(async (path: string) => {
    if (!sessionId) return
    setFileLoading(true)
    try {
      const content = await getFileContent(sessionId, path)
      setFileContent(content)
    } catch {
      // Fall back to external editor
      openFile(path).catch(() => {})
    } finally {
      setFileLoading(false)
    }
  }, [sessionId])

  const sendFeedback = useCallback(async () => {
    if (!sessionId || !open) return
    // artifact 级 comment 与行级评论至少一个非空才可提交
    const hasArtifactComment = comment.trim().length > 0
    const hasLineComments = lineComments.some((l) => l.comment.trim())
    if (!hasArtifactComment && !hasLineComments) return
    setSending(true)
    try {
      await sendArtifactFeedback(
        sessionId,
        open.artifact.id,
        comment.trim(),
        hasLineComments ? lineComments : undefined,
      )
      setOpen(null)
      setComment('')
      setLineComments([])
      onFeedbackSent?.()
    } finally {
      setSending(false)
    }
  }, [sessionId, open, comment, lineComments, onFeedbackSent])

  const pendingCount = pendingApproval ? 1 : 0
  const incompleteTasks = todos.filter((t) => t.status !== 'completed').length

  const sessions = useSessions()
  const session = sessions.data?.find((s: SessionRecord) => s.id === sessionId)

  const tabs = useMemo<TabDef[]>(() => {
    const hasCanvas = canvasArtifacts.length > 0
    const hasGithub = Boolean(session?.worktreeBranch)

    // Codex 对标（Wave 4）：资源为中心——Files/Browser 前置且恒可用，
    // 审查类 Changes/Tasks 降为次级；Canvas/PR 仍按内容出现。
    const all: TabDef[] = [
      { id: 'files', label: 'Files', glyph: '📁' },
      { id: 'browser', label: 'Browser', glyph: '🌐' },
      { id: 'changes', label: 'Changes', glyph: '✓', badge: () => pendingCount || null },
      { id: 'tasks', label: 'Tasks', glyph: '📋', badge: () => (planMode === 'planning' ? -1 : (incompleteTasks || null)) },
    ]

    if (hasCanvas) {
      all.push({ id: 'canvas', label: 'Canvas', glyph: '🎨' })
    }
    if (hasGithub) {
      all.push({ id: 'github', label: 'PR', glyph: '🔀' })
    }

    const filtered = all.filter((t) => enabledTabs.includes(t.id) || tab === t.id)
    // 走查 tab 不受用户 tab 偏好过滤（陈旧的 localStorage 偏好里没有它）：
    // 只要会话有 walkthrough 工件就展示。
    if (walkthroughArtifact) {
      filtered.push({ id: 'walkthrough', label: 'Walkthrough', glyph: '🎬' })
    }
    return filtered.length > 0 ? filtered : [all[0]!]
  }, [pendingCount, planMode, incompleteTasks, enabledTabs, canvasArtifacts.length, artifacts, session, walkthroughArtifact, tab])

  // Fallback active tab if current tab gets disabled
  useEffect(() => {
    const isCurrentTabEnabled = tabs.some((t) => t.id === tab)
    if (!isCurrentTabEnabled && tabs[0]) {
      setTab(tabs[0].id)
    }
  }, [tabs, tab])

  // Codex 对标（Wave 4）：空态资源启动器——文件 / 浏览器 / 终端 三主入口，
  // 变更 / 任务 作为次级链接。选择后进入正常 tab 视图。
  if (launcher) {
    const openTab = (id: ReviewTab) => {
      setTab(id)
      setLauncher(false)
    }
    return (
      <div className="review flex flex-col h-full relative">
        <div className="review-launcher">
          {onCollapse && (
            <button
              onClick={onCollapse}
              className="review-collapse-capsule-btn review-launcher-collapse"
              title={t('collapseTitle')}
            >
              <span>{t('collapse')}</span>
              <ChevronRightIcon size={11} strokeWidth={2.5} aria-hidden />
            </button>
          )}
          <div className="review-launcher-menu" role="menu">
            <button className="review-launcher-item" role="menuitem" onClick={() => openTab('files')}>
              <Folder size={15} strokeWidth={1.7} aria-hidden />
              <span className="rl-label">{t('launcher.files')}</span>
              <kbd>⌘P</kbd>
            </button>
            <button className="review-launcher-item" role="menuitem" onClick={() => openTab('browser')}>
              <Globe size={15} strokeWidth={1.7} aria-hidden />
              <span className="rl-label">{t('launcher.browser')}</span>
              <kbd>⌘T</kbd>
            </button>
            <button
              className="review-launcher-item"
              role="menuitem"
              onClick={() => dispatch({ type: 'setTerminal', visible: true })}
            >
              <TerminalIcon size={15} strokeWidth={1.7} aria-hidden />
              <span className="rl-label">{t('launcher.terminal')}</span>
              <kbd>⌘J</kbd>
            </button>
          </div>
          <div className="review-launcher-secondary">
            <button onClick={() => openTab('changes')}>{t('launcher.changes')}</button>
            <span aria-hidden>·</span>
            <button onClick={() => openTab('tasks')}>{t('launcher.tasks')}</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="review flex flex-col h-full relative">
      <Tabs value={tab} onValueChange={(v) => { if (v) setTab(v as ReviewTab) }} className="flex-1 min-h-0">
        <div className="flex items-center justify-between pr-2">
          <div className="relative flex items-center flex-1 min-w-0 overflow-hidden">
            {canScrollLeft && (
              <button
                type="button"
                className="tabs-scroll-btn left"
                onClick={() => scrollTabs('left')}
                title={t('tabs.scrollLeft')}
              >
                ‹
              </button>
            )}
            <TabsList
              ref={tabsListRef}
              className="mx-2 mt-2 mb-1 w-auto overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden flex-1"
              onScroll={checkScroll}
              onWheel={onWheelTabs}
            >
              {tabs.map((tabDef) => {
                const badge = tabDef.badge?.()
                return (
                  <TabsTrigger key={tabDef.id} value={tabDef.id} className="gap-1 px-2 text-xs flex-none">
                    <span aria-hidden>{tabDef.glyph}</span>
                    <span>{tabDef.label}</span>
                    {badge != null && badge > 0 && (
                      <span className="ml-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] text-accent-fg">
                        {badge}
                      </span>
                    )}
                    {badge === -1 && (
                      <span className="ml-0.5 inline-block h-1.5 w-1.5 rounded-full bg-accent" aria-label={t('tabs.inProgress')} />
                    )}
                  </TabsTrigger>
                )
              })}
            </TabsList>
            {canScrollRight && (
              <button
                type="button"
                className="tabs-scroll-btn right"
                onClick={() => scrollTabs('right')}
                title={t('tabs.scrollRight')}
              >
                ›
              </button>
            )}
          </div>
          {onCollapse && (
            <button
              onClick={onCollapse}
              className="review-collapse-capsule-btn flex items-center gap-1 text-[10px] text-muted hover:text-text bg-panel-3 hover:bg-panel-2 border border-border rounded-full px-2 py-0.5 transition-all shrink-0 ml-2"
              title={t('collapseTitle')}
            >
              <span className="text-[9px]">{t('collapse')}</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>
          )}
        </div>

        <TabsContent value="github" className="review-body">
          <GithubPanel />
        </TabsContent>
        <TabsContent value="browser" className="review-body">
          <BrowserPanel sessionId={sessionId} onSendPrompt={onSendPrompt} />
        </TabsContent>
        <TabsContent value="walkthrough" className="review-body">
          {sessionId && walkthroughArtifact ? (
            <WalkthroughViewer
              sessionId={sessionId}
              artifact={walkthroughArtifact}
              isPro={isPro}
              onSteer={onSendPrompt}
              sessionRunning={sessionRunning}
            />
          ) : (
            <div className="empty sm">{t('walkthrough.empty')}</div>
          )}
        </TabsContent>
        <TabsContent value="canvas" className="review-body flex flex-col h-full">
          <div className="canvas-container flex flex-col h-full gap-2 p-2">
            {canvasArtifacts.length === 0 ? (
              <div className="empty sm">{t('canvas.empty')}</div>
            ) : (
              <>
                <div className="canvas-selector flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{t('canvas.selectArtifact')}</span>
                  <select
                    className="canvas-select bg-panel-2 border border-border rounded px-2 py-1 text-xs text-text flex-1"
                    value={selectedCanvasArtifact?.id || ''}
                    onChange={(e) => {
                      const found = canvasArtifacts.find((a) => a.id === e.target.value)
                      if (found) setSelectedCanvasArtifact(found)
                    }}
                  >
                    {canvasArtifacts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.target} ({a.kind})
                      </option>
                    ))}
                  </select>
                </div>

                {selectedCanvasArtifact && (
                  <>
                  <div className="canvas-preview-wrapper flex-1 flex flex-col border border-border rounded overflow-hidden bg-panel">
                    <div className="canvas-toolbar flex items-center justify-between bg-panel-2 border-b border-border px-3 py-1.5 text-xs">
                      <div className="flex items-center gap-2">
                        <button
                          className="canvas-btn flex items-center gap-1 hover:text-text-strong"
                          onClick={() => setCanvasKey((k) => k + 1)}
                          title={t('canvas.reloadTitle')}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                          </svg>
                          {t('canvas.refresh')}
                        </button>
                        <span className="text-border">|</span>
                        <button
                          className="canvas-btn flex items-center gap-1 hover:text-text-strong"
                          onClick={() => setCanvasFullscreen(true)}
                          title={t('canvas.fullscreenTitle')}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />
                          </svg>
                          {t('canvas.fullscreen')}
                        </button>
                      </div>

                      <div className="flex items-center gap-1 bg-panel-3 rounded p-0.5 border border-border">
                        <button
                          className={`px-2 py-0.5 rounded text-[10px] transition-colors ${canvasWidth === '100%' ? 'bg-accent text-accent-fg' : 'text-muted hover:text-text'}`}
                          onClick={() => setCanvasWidth('100%')}
                        >
                          Desktop
                        </button>
                        <button
                          className={`px-2 py-0.5 rounded text-[10px] transition-colors ${canvasWidth === '768px' ? 'bg-accent text-accent-fg' : 'text-muted hover:text-text'}`}
                          onClick={() => setCanvasWidth('768px')}
                        >
                          Tablet
                        </button>
                        <button
                          className={`px-2 py-0.5 rounded text-[10px] transition-colors ${canvasWidth === '375px' ? 'bg-accent text-accent-fg' : 'text-muted hover:text-text'}`}
                          onClick={() => setCanvasWidth('375px')}
                        >
                          Mobile
                        </button>
                      </div>
                    </div>

                    <div className="canvas-viewport flex-1 bg-white flex items-center justify-center overflow-auto p-4">
                      {canvasLoading ? (
                        <div className="text-xs text-muted-foreground">{t('canvas.loading')}</div>
                      ) : selectedCanvasArtifact.kind === 'markdown' ? (
                        <div
                          style={{ width: canvasWidth, transition: 'width 0.2s' }}
                          className="canvas-content-box h-full bg-panel text-text p-4 rounded overflow-auto border border-border"
                        >
                          <Markdown source={canvasContent} />
                        </div>
                      ) : (
                        <iframe
                          key={canvasKey}
                          style={{ width: canvasWidth, transition: 'width 0.2s' }}
                          className="canvas-content-box h-full bg-white rounded shadow-sm border border-border"
                          srcDoc={canvasContent}
                          sandbox="allow-scripts"
                          title={selectedCanvasArtifact.target}
                        />
                      )}
                    </div>
                  </div>

                  {canvasFullscreen && (
                    <div className="canvas-fullscreen-overlay" role="dialog" aria-modal="true">
                      <div className="canvas-fs-toolbar">
                        <span className="canvas-fs-title truncate" title={selectedCanvasArtifact.target}>
                          {selectedCanvasArtifact.target} ({selectedCanvasArtifact.kind})
                        </span>
                        <div className="canvas-fs-actions">
                          <button className="canvas-btn" onClick={() => setCanvasKey((k) => k + 1)} title={t('canvas.reloadTitle')}>
                            {t('canvas.refresh')}
                          </button>
                          <button className="canvas-btn" onClick={() => setCanvasFullscreen(false)} title={t('canvas.exitFullscreenTitle')}>
                            {t('canvas.exitFullscreen')}
                          </button>
                        </div>
                      </div>
                      <div className="canvas-fs-body">
                        {selectedCanvasArtifact.kind === 'markdown' ? (
                          <div className="canvas-fs-content markdown">
                            <Markdown source={canvasContent} />
                          </div>
                        ) : (
                          <iframe
                            key={`fs-${canvasKey}`}
                            className="canvas-fs-content"
                            srcDoc={canvasContent}
                            sandbox="allow-scripts"
                            title={selectedCanvasArtifact.target}
                          />
                        )}
                      </div>
                    </div>
                  )}
                  </>
                )}
              </>
            )}
          </div>
        </TabsContent>
        <TabsContent value="changes" className="review-body">
          <ChangesTab sessionId={sessionId} onSendPrompt={onSendPrompt} />

          {autonomous && !pendingApproval && (
            <section className="review-section mt-4 border-t border-border pt-4">
              <div className="autonomy-note">
                <span className="ab-glyph" aria-hidden>✦</span>
                {t('autonomyNote')}
              </div>
            </section>
          )}

          {artifacts.filter(a => a.kind === 'diff').length > 0 && (
            <section className="review-section mt-4 border-t border-border pt-4">
              <h4>{t('gitChangesHeading')}</h4>
              {artifacts.filter(a => a.kind === 'diff').map((a) => (
                <div key={a.id} className="artifact-card diff" onClick={() => view(a)}>
                  <div className="kind">{a.kind} · {a.target}</div>
                  <div className="summary">{a.summary || a.target}</div>
                  <div className="meta">{t('artifactMeta', { lines: a.lineCount, chars: a.charCount })}</div>
                </div>
              ))}
            </section>
          )}

          {sessionId && (
            <section className="review-section mt-4 border-t border-border pt-4">
              <h4>{t('checkpointHeading')}</h4>
              <RollbackSection sessionId={sessionId} />
            </section>
          )}
        </TabsContent>
        <TabsContent value="files" className="review-body">
          <FileExplorer sessionId={sessionId} cwd={cwd} />
        </TabsContent>
        <TabsContent value="tasks" className="review-body">
          <PlanPanel sessionId={sessionId} planRev={planRev} latestPlanSlug={latestPlanSlug} todos={todos} planMode={planMode} sessionRunning={sessionRunning} draftLive={draftLive} />
          
          <section className="review-section mt-4 border-t border-border pt-4">
            <h4>{t('tasksHeading')}</h4>
            {todos.length === 0 && <div className="empty sm">{t('noTasks')}</div>}
            {todos.map((t) => (
              <div key={t.id} className={`task-item st-${t.status}`}>
                <span className="task-check">{t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◴' : '○'}</span>
                <span className="task-text">{t.content}</span>
              </div>
            ))}
          </section>

          <SourceListSection
            sources={sources}
            fileContent={fileContent}
            fileLoading={fileLoading}
            onView={viewFile}
            onOpen={() => fileContent && openFile(fileContent.path).catch(() => {})}
            onClose={() => setFileContent(null)}
          />

          <section className="review-section mt-4 border-t border-border pt-4">
            <h4>{t('artifactsHeading', { n: artifacts.length })}</h4>
            {artifacts.length === 0 && <div className="empty sm">{t('noArtifacts')}</div>}
            {artifacts.map((a) => (
              <div key={a.id} className="artifact-card" onClick={() => view(a)}>
                <div className="kind">{a.kind}</div>
                <div className="summary">{a.summary || a.target}</div>
                <div className="meta">{t('artifactMeta', { lines: a.lineCount, chars: a.charCount })}</div>
              </div>
            ))}
          </section>
        </TabsContent>
      </Tabs>

      <TodoDock items={todos} collapsedList={tab === 'tasks'} onOpenFull={() => setTab('tasks')} />

      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(null)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{open.artifact.kind} · {open.artifact.target}</h3>
              {(open.artifact.kind === 'markdown' || open.artifact.kind === 'html') && (
                <div className="segmented">
                  <button className={viewMode === 'rendered' ? 'active' : ''} onClick={() => setViewMode('rendered')}>{t('modal.rendered')}</button>
                  <button className={viewMode === 'raw' ? 'active' : ''} onClick={() => setViewMode('raw')}>{t('modal.raw')}</button>
                </div>
              )}
            </div>
            {open.artifact.kind === 'screenshot' ? (
              <img className="screenshot" src={`data:image/png;base64,${open.raw}`} alt={open.artifact.summary} />
            ) : open.artifact.kind === 'diff' ? (
              <DiffView
                raw={open.raw}
                comments={lineComments}
                onLineComment={(anchor, text) =>
                  setLineComments((prev) => [
                    ...prev,
                    {
                      file: anchor.file,
                      oldLine: anchor.oldLine,
                      newLine: anchor.newLine,
                      comment: text,
                    },
                  ])
                }
              />
            ) : open.artifact.kind === 'markdown' && viewMode === 'rendered' ? (
              <div className="artifact-rendered"><Markdown source={open.raw} /></div>
            ) : open.artifact.kind === 'html' && viewMode === 'rendered' ? (
              <iframe
                className="artifact-html-frame"
                srcDoc={open.raw}
                sandbox=""
                title={open.artifact.target}
              />
            ) : (
              <pre>{open.raw}</pre>
            )}
            <label className="meta">
              {t('modal.feedbackLabel')}
              {lineComments.some((l) => l.comment.trim()) && (
                <span className="meta-badge">{t('modal.annotatedLines', { n: lineComments.filter((l) => l.comment.trim()).length })}</span>
              )}
            </label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={t('modal.feedbackPlaceholder')}
            />
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setOpen(null)}>{t('modal.close')}</button>
              <button
                className="btn"
                disabled={(!comment.trim() && !lineComments.some((l) => l.comment.trim())) || sending}
                onClick={sendFeedback}
              >
                {sending ? t('modal.sending') : t('modal.send')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Rollback entry (R3) — preview the agent-owned files a checkpoint would
// restore, INCLUDING irreversible bash side effects that file rollback cannot
// undo, then confirm execution. Contested files (owned by another live session)
// are skipped and surfaced, never blanket-reverted.
function RollbackSection(props: { sessionId: string }) {
  const { sessionId } = props
  const { t } = useTranslation('review')
  const [preview, setPreview] = useState<{ text: string; confirmationToken: string } | null>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'previewed' | 'running' | 'none'>('idle')
  const [result, setResult] = useState<RollbackResult | null>(null)
  const [showConfirm, setShowConfirm] = useState(false)

  const loadPreview = useCallback(async () => {
    setState('loading')
    setResult(null)
    try {
      const p = await getRollbackPreview(sessionId)
      if (!p.available || !p.text || !p.confirmationToken) {
        setPreview(null)
        setState('none')
        return
      }
      setPreview({ text: p.text, confirmationToken: p.confirmationToken })
      setState('previewed')
    } catch {
      setState('none')
    }
  }, [sessionId])

  const execute = useCallback(async () => {
    if (!preview) return
    setState('running')
    try {
      const r = await rollbackSession(sessionId, preview.confirmationToken)
      setResult(r)
    } finally {
      setPreview(null)
      setState('idle')
    }
  }, [sessionId, preview])

  return (
    <div className="rollback">
      {state !== 'previewed' && (
        <button className="btn ghost sm" disabled={state === 'loading' || state === 'running'} onClick={loadPreview}>
          {state === 'loading' ? t('rollback.loadingPreview') : t('rollback.trigger')}
        </button>
      )}
      {state === 'none' && <div className="empty sm">{t('rollback.none')}</div>}
      {state === 'previewed' && preview && (
        <div className="review-pending rollback-preview">
          <div className="rp-head">
            <span className="kind warn">{t('rollback.confirmBadge')}</span>
          </div>
          <pre className="rp-preview">{preview.text}</pre>
          <div className="rp-actions">
            <button className="btn ghost sm" onClick={() => setState('idle')}>{t('rollback.cancel')}</button>
            <button className="btn sm danger" onClick={() => setShowConfirm(true)}>{t('rollback.confirm')}</button>
          </div>

          <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
            <AlertDialogContent className="max-w-lg sm:max-w-lg">
              <AlertDialogHeader>
                <AlertDialogTitle>{t('rollback.dialogTitle')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t('rollback.dialogDescription')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <pre className="max-h-48 overflow-auto rounded-md bg-panel-2 p-2 text-xs">{preview.text}</pre>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={() => setShowConfirm(false)}>{t('rollback.cancel')}</AlertDialogCancel>
                <AlertDialogAction className="bg-destructive/10 text-destructive hover:bg-destructive/20" onClick={execute}>
                  {t('rollback.confirm')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}
      {result && (
        <div className={`rollback-result ${result.success ? 'ok' : 'fail'}`}>
          <div className="meta">{result.success ? t('rollback.done', { hash: result.hash ?? '' }) : (result.error ?? t('rollback.notExecuted'))}</div>
          {result.skipped && result.skipped.length > 0 && (
            <div className="meta">{t('rollback.skipped', { files: result.skipped.join(', ') })}</div>
          )}
          {result.unrevertable && result.unrevertable.length > 0 && (
            <div className="meta warn">{t('rollback.unrevertable', { effects: result.unrevertable.join('; ') })}</div>
          )}
        </div>
      )}
    </div>
  )
}

// T2 companion — collapsible source file list so long file rosters don't push
// the rest of the Task tab off-screen.
function SourceListSection(props: {
  sources: string[]
  fileContent: FileContent | null
  fileLoading: boolean
  onView: (path: string) => void
  onOpen: () => void
  onClose: () => void
}) {
  const { sources, fileContent, fileLoading, onView, onOpen, onClose } = props
  const { t } = useTranslation('review')
  const [expanded, setExpanded] = useState(false)
  const PREVIEW_LIMIT = 8
  const needsCollapse = sources.length > PREVIEW_LIMIT
  const visible = expanded || !needsCollapse ? sources : sources.slice(0, PREVIEW_LIMIT)
  const remaining = sources.length - PREVIEW_LIMIT

  return (
    <section className="review-section">
      <h4>{t('sources.heading', { n: sources.length })}</h4>
      {sources.length === 0 && <div className="empty sm">{t('sources.empty')}</div>}
      {visible.map((path) => (
        <div
          key={path}
          className="source-item"
          title={t('sources.viewTitle', { path })}
          onClick={() => onView(path)}
        >
          <span className="source-icon" aria-hidden>📄</span>
          <FilePath path={path} className="source-path" />
        </div>
      ))}
      {needsCollapse && (
        <button className="source-more" onClick={() => setExpanded((v) => !v)}>
          {expanded ? t('sources.collapse') : t('sources.expandRemaining', { n: remaining })}
        </button>
      )}
      {fileLoading && <div className="empty sm">{t('sources.loadingFile')}</div>}
      {fileContent && (
        <div className="review-file-viewer">
          <div className="review-file-header">
            <FilePath path={fileContent.path} />
            <button className="btn ghost sm" onClick={onOpen}>
              {t('sources.openInEditor')}
            </button>
            <button className="btn ghost sm" onClick={onClose}>{t('sources.close')}</button>
          </div>
          <FileViewer
            content={fileContent.content}
            language={fileContent.language}
            startLine={fileContent.startLine}
          />
        </div>
      )}
    </section>
  )
}
