import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getArtifact,
  openFile,
  getFileContent,
  sendArtifactFeedback,
  getRollbackPreview,
  rollbackSession,
  type RollbackResult,
} from '../runtime/client'
import type { ApprovalMode, ApprovalRequest, ArtifactSummary, FileContent, IntentRequest, LineComment, PlanModeState, TodoStateItem } from '../runtime/types'
import { useEnabledTabs } from '../lib/review-tabs'
import { DiffView } from '../components/DiffView'
import { FilePath } from '../components/FilePath'
import { FileViewer } from '../components/FileViewer'
import { Markdown } from '../components/Markdown'
import { PlanPanel } from './PlanPanel'
import { GithubPanel } from './GithubPanel'
import { FileExplorer } from '../components/FileExplorer'
import { ChangesTab } from './ChangesTab'
import { editableKey, previewOf, parseMcpToolName, getApprovalActionProps } from '../lib/approval-preview'
import { isAutonomous } from '../lib/autonomy'
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

type ReviewTab = 'review' | 'plan' | 'task' | 'github' | 'wt' | 'files' | 'canvas'

interface TabDef {
  id: ReviewTab
  label: string
  glyph: string
  badge?: () => number | null
}

// Review panel (P3/Q3) — Codex's third pane. Aggregates the trust-layer surfaces
// of the active thread: pending approvals/intents handled INLINE (no blocking
// modal) + artifacts/diff/screenshots. The tab bar reserves slots for future CVM
// council/sensorium views (not rendered yet).
export function ReviewPanel(props: {
  sessionId: string | null
  artifacts: ArtifactSummary[]
  pendingApproval: ApprovalRequest | null
  pendingIntent: IntentRequest | null
  approvalMode?: ApprovalMode
  planMode?: PlanModeState
  planRev?: number
  latestPlanSlug?: string
  onApproval: (decision: 'approve' | 'reject', editedInput?: Record<string, unknown>) => void
  onIntent: (decision: 'continue' | 'veto' | 'alternative') => void
  onFeedbackSent?: () => void
  /** T2 — active task list for the Task tab. */
  todos?: TodoStateItem[]
  /** Source files touched by file-editing tools. */
  sources?: string[]
  onCollapse?: () => void
}) {
  const { sessionId, artifacts, pendingApproval, pendingIntent, approvalMode, planMode, planRev = 0, latestPlanSlug, onApproval, onIntent, onFeedbackSent, todos = [], sources = [], onCollapse } = props
  const autonomous = isAutonomous(approvalMode)
  const [enabledTabs] = useEnabledTabs()
  const [tab, setTab] = useState<ReviewTab>('review')

  // Auto-focus the plan tab when planning starts or a fresh plan lands, so the
  // reviewable plan surfaces without a manual tab switch (Cursor 3.0 flow).
  const prevSlug = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (planMode === 'planning') setTab('plan')
  }, [planMode])
  useEffect(() => {
    if (latestPlanSlug && latestPlanSlug !== prevSlug.current) {
      prevSlug.current = latestPlanSlug
      setTab('plan')
    }
  }, [latestPlanSlug])
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

  const pendingCount = (pendingApproval ? 1 : 0) + (pendingIntent ? 1 : 0)
  const incompleteTasks = todos.filter((t) => t.status !== 'completed').length

  const tabs = useMemo<TabDef[]>(() => {
    const all: TabDef[] = [
      { id: 'review', label: 'Changes', glyph: '✓', badge: () => pendingCount || null },
      { id: 'plan', label: 'Plan', glyph: '📋', badge: () => (planMode === 'planning' ? -1 : null) },
      { id: 'task', label: 'Tasks', glyph: '☑', badge: () => incompleteTasks || null },
      { id: 'canvas', label: 'Canvas', glyph: '🎨' },
      { id: 'wt', label: 'Diff', glyph: '⟐' },
      { id: 'files', label: 'Files', glyph: '📁' },
      { id: 'github', label: 'PR', glyph: '🔀' },
    ]
    const filtered = all.filter((t) => enabledTabs.includes(t.id))
    return filtered.length > 0 ? filtered : [all[0]!]
  }, [pendingCount, planMode, incompleteTasks, enabledTabs])

  // Fallback active tab if current tab gets disabled
  useEffect(() => {
    const isCurrentTabEnabled = tabs.some((t) => t.id === tab)
    if (!isCurrentTabEnabled && tabs[0]) {
      setTab(tabs[0].id)
    }
  }, [tabs, tab])

  return (
    <div className="review flex flex-col h-full relative">
      <Tabs value={tab} onValueChange={(v) => { if (v) setTab(v as ReviewTab) }}>
        <div className="flex items-center justify-between pr-2">
          <TabsList className="mx-2 mt-2 mb-1 w-auto overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden flex-1">
            {tabs.map((t) => {
              const badge = t.badge?.()
              return (
                <TabsTrigger key={t.id} value={t.id} className="gap-1 px-2 text-xs">
                  <span aria-hidden>{t.glyph}</span>
                  <span>{t.label}</span>
                  {badge != null && badge > 0 && (
                    <span className="ml-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] text-accent-fg">
                      {badge}
                    </span>
                  )}
                  {badge === -1 && (
                    <span className="ml-0.5 inline-block h-1.5 w-1.5 rounded-full bg-accent" aria-label="进行中" />
                  )}
                </TabsTrigger>
              )
            })}
          </TabsList>
          {onCollapse && (
            <button
              onClick={onCollapse}
              className="review-collapse-capsule-btn flex items-center gap-1 text-[10px] text-muted hover:text-text bg-panel-3 hover:bg-panel-2 border border-border rounded-full px-2 py-0.5 transition-all shrink-0 ml-2"
              title="收起审查面板 (Cmd+Shift+B)"
            >
              <span className="text-[9px]">收起</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>
          )}
        </div>

        <TabsContent value="github" className="review-body">
          <GithubPanel />
        </TabsContent>
        <TabsContent value="canvas" className="review-body flex flex-col h-full">
          <div className="canvas-container flex flex-col h-full gap-2 p-2">
            {canvasArtifacts.length === 0 ? (
              <div className="empty sm">没有可预览的 HTML 或 Markdown 工件</div>
            ) : (
              <>
                <div className="canvas-selector flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">选择工件:</span>
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
                          title="重新加载"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                          </svg>
                          刷新
                        </button>
                        <span className="text-border">|</span>
                        <button
                          className="canvas-btn flex items-center gap-1 hover:text-text-strong"
                          onClick={() => setCanvasFullscreen(true)}
                          title="全屏预览（应用内沙箱）"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />
                          </svg>
                          全屏
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
                        <div className="text-xs text-muted-foreground">加载中...</div>
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
                          <button className="canvas-btn" onClick={() => setCanvasKey((k) => k + 1)} title="重新加载">
                            刷新
                          </button>
                          <button className="canvas-btn" onClick={() => setCanvasFullscreen(false)} title="退出全屏 (Esc)">
                            退出全屏
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
        <TabsContent value="wt" className="review-body">
          <ChangesTab sessionId={sessionId} />
        </TabsContent>
        <TabsContent value="files" className="review-body">
          <FileExplorer sessionId={sessionId} />
        </TabsContent>
        <TabsContent value="plan" className="review-body">
          <PlanPanel sessionId={sessionId} planRev={planRev} latestPlanSlug={latestPlanSlug} />
        </TabsContent>
        <TabsContent value="task" className="review-body">
          <section className="review-section">
            <h4>任务清单</h4>
            {todos.length === 0 && <div className="empty sm">还没有任务</div>}
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

          <section className="review-section">
            <h4>工件 · {artifacts.length}</h4>
            {artifacts.length === 0 && <div className="empty sm">还没有工件</div>}
            {artifacts.map((a) => (
              <div key={a.id} className="artifact-card" onClick={() => view(a)}>
                <div className="kind">{a.kind}</div>
                <div className="summary">{a.summary || a.target}</div>
                <div className="meta">{a.lineCount} 行 · {a.charCount} 字符</div>
              </div>
            ))}
          </section>
        </TabsContent>
        <TabsContent value="review" className="review-body">
          {(pendingApproval || pendingIntent) && (
            <section className="review-section">
              <h4>待处理</h4>
              {pendingApproval && (
                <ApprovalReview request={pendingApproval} onDecision={onApproval} />
              )}
              {pendingIntent && (
                <IntentReview request={pendingIntent} onDecision={onIntent} />
              )}
            </section>
          )}

          {autonomous && !pendingApproval && !pendingIntent && (
            <section className="review-section">
              <div className="autonomy-note">
                <span className="ab-glyph" aria-hidden>✦</span>
                自治模式：项目内操作已自动放行，无需逐条审批。下方检查点可随时回滚。
              </div>
            </section>
          )}

          <section className="review-section">
            <h4>Git 变更 · 代码审查</h4>
            {artifacts.filter(a => a.kind === 'diff').length === 0 ? (
              <div className="empty sm">
                <p>还没有 diff 工件。在对话中输入 <code>/review</code> 让 agent 对未提交变更执行代码审查。</p>
              </div>
            ) : (
              artifacts.filter(a => a.kind === 'diff').map((a) => (
                <div key={a.id} className="artifact-card diff" onClick={() => view(a)}>
                  <div className="kind">{a.kind} · {a.target}</div>
                  <div className="summary">{a.summary || a.target}</div>
                  <div className="meta">{a.lineCount} 行 · {a.charCount} 字符</div>
                </div>
              ))
            )}
          </section>

          <section className="review-section">
            <h4>其他工件 · {artifacts.filter(a => a.kind !== 'diff').length}</h4>
            {artifacts.filter(a => a.kind !== 'diff').length === 0 && <div className="empty sm">还没有其他工件</div>}
            {artifacts.filter(a => a.kind !== 'diff').map((a) => (
              <div key={a.id} className="artifact-card" onClick={() => view(a)}>
                <div className="kind">{a.kind}</div>
                <div className="summary">{a.summary || a.target}</div>
                <div className="meta">{a.lineCount} 行 · {a.charCount} 字符</div>
              </div>
            ))}
          </section>

          {sessionId && (
            <section className="review-section">
              <h4>检查点 · 回滚</h4>
              <RollbackSection sessionId={sessionId} />
            </section>
          )}
        </TabsContent>
      </Tabs>

      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(null)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{open.artifact.kind} · {open.artifact.target}</h3>
              {(open.artifact.kind === 'markdown' || open.artifact.kind === 'html') && (
                <div className="segmented">
                  <button className={viewMode === 'rendered' ? 'active' : ''} onClick={() => setViewMode('rendered')}>渲染</button>
                  <button className={viewMode === 'raw' ? 'active' : ''} onClick={() => setViewMode('raw')}>源码</button>
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
              在工件上反馈（回灌为下一轮上下文）
              {lineComments.some((l) => l.comment.trim()) && (
                <span className="meta-badge">已标注 {lineComments.filter((l) => l.comment.trim()).length} 行评论</span>
              )}
            </label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="例如：这个改动漏了错误处理，请补上 try/catch 并加测试（行级评论可在 diff 上直接标）"
            />
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setOpen(null)}>关闭</button>
              <button
                className="btn"
                disabled={(!comment.trim() && !lineComments.some((l) => l.comment.trim())) || sending}
                onClick={sendFeedback}
              >
                {sending ? '发送中…' : '发送反馈'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Inline approval (Q3) — replaces the blocking ApprovalModal. Diff/JSON preview +
// approve/reject, with optional edit-before-approve for edit tools.
function ApprovalReview(props: {
  request: ApprovalRequest
  onDecision: (decision: 'approve' | 'reject', editedInput?: Record<string, unknown>) => void
}) {
  const { request, onDecision } = props
  const mcp = parseMcpToolName(request.toolName)
  const preview = previewOf(request)
  const editKey = editableKey(request)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(
    editKey ? String((request.input as Record<string, unknown>)[editKey] ?? '') : '',
  )

  const approve = () => {
    if (editing && editKey) onDecision('approve', { ...request.input, [editKey]: draft })
    else onDecision('approve')
  }

  const rejectProps = getApprovalActionProps('reject')
  const approveProps = getApprovalActionProps('approve', editing)
  const editProps = getApprovalActionProps('edit', editing)

  // MCP connector opt-in card — never silently use a connector the user didn't
  // choose. Surfaces the connector identity + the tool/input, and frames the
  // approval as authorizing the connector (read-only tools won't re-prompt).
  if (mcp) {
    return (
      <div className="review-pending approval mcp-consent">
        <div className="rp-head">
          <span className="kind mcp">MCP 连接器</span>
          <span className="rp-tool">{mcp.serverId}</span>
        </div>
        <div className="mcp-consent-note">
          调用工具 <code>{mcp.toolName}</code>。授权即允许此次调用；只读工具在首次授权后将不再逐次询问。
        </div>
        <pre className="rp-preview">{preview.text}</pre>
        <div className="rp-actions">
          <button className={rejectProps.variant} onClick={() => onDecision('reject')}>{rejectProps.label}</button>
          <button className={approveProps.variant} onClick={() => onDecision('approve')}>
            {approveProps.label}
            <span className="rp-default-mark" aria-hidden>●</span>
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="review-pending approval">
      <div className="rp-head">
        <span className="kind">需批准</span>
        <span className="rp-tool">{request.toolName}</span>
      </div>
      {editing && editKey ? (
        <textarea className="edit-input" value={draft} onChange={(e) => setDraft(e.target.value)} />
      ) : preview.isDiff ? (
        <DiffView raw={preview.text} />
      ) : (
        <pre className="rp-preview">{preview.text}</pre>
      )}
      <div className="rp-actions">
        {editKey && (
          <button className={editProps.variant} onClick={() => setEditing((v) => !v)}>{editProps.label}</button>
        )}
        <button className={rejectProps.variant} onClick={() => onDecision('reject')}>{rejectProps.label}</button>
        <button className={approveProps.variant} onClick={approve}>
          {approveProps.label}
          <span className="rp-default-mark" aria-hidden>●</span>
        </button>
      </div>
    </div>
  )
}

// Rollback entry (R3) — preview the agent-owned files a checkpoint would
// restore, INCLUDING irreversible bash side effects that file rollback cannot
// undo, then confirm execution. Contested files (owned by another live session)
// are skipped and surfaced, never blanket-reverted.
function RollbackSection(props: { sessionId: string }) {
  const { sessionId } = props
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
          {state === 'loading' ? '加载预览…' : '回滚到此检查点'}
        </button>
      )}
      {state === 'none' && <div className="empty sm">当前没有可回滚的检查点</div>}
      {state === 'previewed' && preview && (
        <div className="review-pending rollback-preview">
          <div className="rp-head">
            <span className="kind warn">确认回滚</span>
          </div>
          <pre className="rp-preview">{preview.text}</pre>
          <div className="rp-actions">
            <button className="btn ghost sm" onClick={() => setState('idle')}>取消</button>
            <button className="btn sm danger" onClick={() => setShowConfirm(true)}>确认回滚</button>
          </div>

          <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
            <AlertDialogContent className="max-w-lg sm:max-w-lg">
              <AlertDialogHeader>
                <AlertDialogTitle>确认回滚？</AlertDialogTitle>
                <AlertDialogDescription>
                  此操作会将当前会话恢复到上一个检查点。部分副作用（如已执行的 bash 命令）可能无法撤销。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <pre className="max-h-48 overflow-auto rounded-md bg-panel-2 p-2 text-xs">{preview.text}</pre>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={() => setShowConfirm(false)}>取消</AlertDialogCancel>
                <AlertDialogAction className="bg-destructive/10 text-destructive hover:bg-destructive/20" onClick={execute}>
                  确认回滚
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}
      {result && (
        <div className={`rollback-result ${result.success ? 'ok' : 'fail'}`}>
          <div className="meta">{result.success ? `已回滚（${result.hash ?? ''}）` : (result.error ?? '回滚未执行')}</div>
          {result.skipped && result.skipped.length > 0 && (
            <div className="meta">跳过（被其它会话占用）：{result.skipped.join(', ')}</div>
          )}
          {result.unrevertable && result.unrevertable.length > 0 && (
            <div className="meta warn">⚠️ 无法回滚的副作用：{result.unrevertable.join('; ')}</div>
          )}
        </div>
      )}
    </div>
  )
}

// Inline intent preview (Q3) — replaces IntentModal.
function IntentReview(props: {
  request: IntentRequest
  onDecision: (decision: 'continue' | 'veto' | 'alternative') => void
}) {
  const { request, onDecision } = props
  return (
    <div className="review-pending intent">
      <div className="rp-head">
        <span className="kind">意图预览 · {(request.confidence * 100).toFixed(0)}%</span>
      </div>
      <p className="rp-summary">{request.summary}</p>
      {request.alternatives.length > 0 && (
        <>
          <label className="meta">备选</label>
          <ul>{request.alternatives.map((a, i) => <li key={i}>{a}</li>)}</ul>
        </>
      )}
      {request.warnings.length > 0 && (
        <>
          <label className="meta">警告</label>
          <ul>{request.warnings.map((w, i) => <li key={i} className="warn">{w}</li>)}</ul>
        </>
      )}
      <div className="rp-actions">
        <button className="btn ghost sm" onClick={() => onDecision('veto')}>否决</button>
        <button className="btn ghost sm" onClick={() => onDecision('alternative')}>换方案</button>
        <button className="btn sm" onClick={() => onDecision('continue')}>继续</button>
      </div>
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
  const [expanded, setExpanded] = useState(false)
  const PREVIEW_LIMIT = 8
  const needsCollapse = sources.length > PREVIEW_LIMIT
  const visible = expanded || !needsCollapse ? sources : sources.slice(0, PREVIEW_LIMIT)
  const remaining = sources.length - PREVIEW_LIMIT

  return (
    <section className="review-section">
      <h4>涉及文件 · {sources.length}</h4>
      {sources.length === 0 && <div className="empty sm">还没有文件变更</div>}
      {visible.map((path) => (
        <div
          key={path}
          className="source-item"
          title={`查看 ${path}`}
          onClick={() => onView(path)}
        >
          <span className="source-icon" aria-hidden>📄</span>
          <FilePath path={path} className="source-path" />
        </div>
      ))}
      {needsCollapse && (
        <button className="source-more" onClick={() => setExpanded((v) => !v)}>
          {expanded ? '收起' : `展开剩余 ${remaining} 个文件`}
        </button>
      )}
      {fileLoading && <div className="empty sm">加载文件…</div>}
      {fileContent && (
        <div className="review-file-viewer">
          <div className="review-file-header">
            <FilePath path={fileContent.path} />
            <button className="btn ghost sm" onClick={onOpen}>
              在编辑器中打开
            </button>
            <button className="btn ghost sm" onClick={onClose}>关闭</button>
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
