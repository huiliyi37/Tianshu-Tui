import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getArtifact,
  openFile,
  getFileContent,
  sendArtifactFeedback,
  getRollbackPreview,
  rollbackSession,
  type RollbackResult,
} from '../runtime/client'
import type { ApprovalMode, ApprovalRequest, ArtifactSummary, FileContent, IntentRequest, PlanModeState, TodoStateItem } from '../runtime/types'
import { DiffView } from '../components/DiffView'
import { FilePath } from '../components/FilePath'
import { FileViewer } from '../components/FileViewer'
import { PlanPanel } from './PlanPanel'
import { GithubPanel } from './GithubPanel'
import { editableKey, previewOf, parseMcpToolName } from '../lib/approval-preview'
import { isAutonomous } from '../lib/autonomy'

type ReviewTab = 'review' | 'plan' | 'task' | 'github'

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
}) {
  const { sessionId, artifacts, pendingApproval, pendingIntent, approvalMode, planMode, planRev = 0, latestPlanSlug, onApproval, onIntent, onFeedbackSent, todos = [], sources = [] } = props
  const autonomous = isAutonomous(approvalMode)
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
  const [comment, setComment] = useState('')
  const [sending, setSending] = useState(false)
  const [fileContent, setFileContent] = useState<FileContent | null>(null)
  const [fileLoading, setFileLoading] = useState(false)

  const view = useCallback(async (a: ArtifactSummary) => {
    if (!sessionId) return
    try {
      setOpen(await getArtifact(sessionId, a.id))
      setComment('')
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
    if (!sessionId || !open || !comment.trim()) return
    setSending(true)
    try {
      await sendArtifactFeedback(sessionId, open.artifact.id, comment.trim())
      setOpen(null)
      setComment('')
      onFeedbackSent?.()
    } finally {
      setSending(false)
    }
  }, [sessionId, open, comment, onFeedbackSent])

  const pendingCount = (pendingApproval ? 1 : 0) + (pendingIntent ? 1 : 0)

  return (
    <div className="review">
      <div className="review-tabs">
        <button className={`review-tab ${tab === 'review' ? 'active' : ''}`} onClick={() => setTab('review')}>
          审查{pendingCount > 0 && <span className="tab-badge">{pendingCount}</span>}
        </button>
        <button className={`review-tab ${tab === 'plan' ? 'active' : ''}`} onClick={() => setTab('plan')}>
          方案{planMode === 'planning' && <span className="tab-badge dot" aria-label="规划中" />}
        </button>
        <button className={`review-tab ${tab === 'task' ? 'active' : ''}`} onClick={() => setTab('task')}>
          任务{todos.length > 0 && <span className="tab-badge">{todos.filter(t => t.status !== 'completed').length || ''}</span>}
        </button>
        <button className={`review-tab ${tab === 'github' ? 'active' : ''}`} onClick={() => setTab('github')}>
          PR
        </button>
      </div>

      {tab === 'github' ? (
        <div className="review-body">
          <GithubPanel />
        </div>
      ) : tab === 'plan' ? (
        <div className="review-body">
          <PlanPanel sessionId={sessionId} planRev={planRev} latestPlanSlug={latestPlanSlug} />
        </div>
      ) : tab === 'task' ? (
        <div className="review-body">
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

          <section className="review-section">
            <h4>涉及文件 · {sources.length}</h4>
            {sources.length === 0 && <div className="empty sm">还没有文件变更</div>}
            {sources.map((path) => (
              <div
                key={path}
                className="source-item"
                title={`查看 ${path}`}
                onClick={() => viewFile(path)}
              >
                <span className="source-icon" aria-hidden>📄</span>
                <FilePath path={path} className="source-path" />
              </div>
            ))}
            {fileLoading && <div className="empty sm">加载文件…</div>}
            {fileContent && (
              <div className="review-file-viewer">
                <div className="review-file-header">
                  <FilePath path={fileContent.path} />
                  <button className="btn ghost sm" onClick={() => openFile(fileContent.path).catch(() => {})}>
                    在编辑器中打开
                  </button>
                  <button className="btn ghost sm" onClick={() => setFileContent(null)}>关闭</button>
                </div>
                <FileViewer
                  content={fileContent.content}
                  language={fileContent.language}
                  startLine={fileContent.startLine}
                />
              </div>
            )}
          </section>

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
        </div>
      ) : (
      <div className="review-body">
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
      </div>
      )}

      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(null)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <h3>{open.artifact.kind} · {open.artifact.target}</h3>
            {open.artifact.kind === 'screenshot' ? (
              <img className="screenshot" src={`data:image/png;base64,${open.raw}`} alt={open.artifact.summary} />
            ) : open.artifact.kind === 'diff' ? (
              <DiffView raw={open.raw} />
            ) : (
              <pre>{open.raw}</pre>
            )}
            <label className="meta">在工件上反馈（回灌为下一轮上下文）</label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="例如：这个改动漏了错误处理，请补上 try/catch 并加测试"
            />
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setOpen(null)}>关闭</button>
              <button className="btn" disabled={!comment.trim() || sending} onClick={sendFeedback}>
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
          <button className="btn ghost sm" onClick={() => onDecision('reject')}>拒绝</button>
          <button className="btn sm" onClick={() => onDecision('approve')}>授权连接器</button>
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
          <button className="btn ghost sm" onClick={() => setEditing((v) => !v)}>
            {editing ? '取消编辑' : '编辑'}
          </button>
        )}
        <button className="btn ghost sm" onClick={() => onDecision('reject')}>拒绝</button>
        <button className="btn sm" onClick={approve}>{editing ? '应用并批准' : '批准'}</button>
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
            <button className="btn sm danger" onClick={execute}>确认回滚</button>
          </div>
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
