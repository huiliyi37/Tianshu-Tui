import { useMemo, useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { qk, useFileDiff, useSessions, useWorkingTree } from '../state/queries'
import { commitSessionChanges, createSessionPr, mergeSessionBack } from '../runtime/client'
import { DiffView } from '../components/DiffView'
import type { LineComment, WorkingTreeFile, ArtifactSummary } from '../runtime/types'
import { useSessionEventsSelector } from '../state/use-session-events'
import { summarizeDelegation } from '../components/DelegationTree'
import {
  ChevronRight,
  ChevronDown,
  Users,
  FileCode,
  FileText,
  Play,
  Terminal,
  Eye,
  ArrowLeft
} from 'lucide-react'

const STATUS_LABEL: Record<WorkingTreeFile['status'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: '?',
}

const STATUS_CLASS: Record<WorkingTreeFile['status'], string> = {
  modified: 'st-modified',
  added: 'st-added',
  deleted: 'st-deleted',
  renamed: 'st-renamed',
  untracked: 'st-untracked',
}

const formatArtifactTime = (timestamp: number) => {
  const date = new Date(timestamp)
  const isToday = new Date().toDateString() === date.toDateString()
  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true })
  if (isToday) {
    return `Today ${timeStr}`
  }
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  if (yesterday.toDateString() === date.toDateString()) {
    return `Yesterday ${timeStr}`
  }
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${timeStr}`
}

const getFileIcon = (filePath: string) => {
  const ext = filePath.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'tsx':
    case 'ts':
    case 'jsx':
    case 'js':
      return <FileCode size={16} className="text-accent" />
    case 'css':
    case 'scss':
      return <FileCode size={16} className="text-warning" />
    case 'md':
      return <FileText size={16} className="text-success" />
    case 'json':
      return <FileText size={16} className="text-info" />
    default:
      return <FileText size={16} className="text-muted" />
  }
}

const getArtifactIcon = (a: ArtifactSummary) => {
  if (a.tool === 'walkthrough') {
    return <Play size={16} className="text-success" />
  }
  if (a.target.endsWith('task.md') || a.tool === 'task') {
    return <FileText size={16} className="text-warning" />
  }
  if (a.kind === 'screenshot' || a.kind === 'image') {
    return <Eye size={16} className="text-info" />
  }
  return <FileText size={16} className="text-muted" />
}

function DashboardGroup(props: {
  title: string
  count: number
  icon: React.ReactNode
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? false)
  return (
    <div className={`dashboard-group ${open ? 'open' : ''}`}>
      <button className="dashboard-group-header" onClick={() => setOpen(!open)}>
        <span className="group-title-wrap">
          {props.icon}
          <span className="group-title">{props.title}</span>
          <span className="group-count">{props.count}</span>
        </span>
        <span className="group-chevron">
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
      </button>
      {open && (
        <div className="dashboard-group-body">
          {props.children}
        </div>
      )}
    </div>
  )
}

export function ChangesTab(props: {
  sessionId: string | null
  artifacts: ArtifactSummary[]
  onViewArtifact?: (a: ArtifactSummary) => void
  onSendPrompt?: (text: string) => void
}) {
  const { t } = useTranslation('git')
  const enabled = props.sessionId !== null
  const tree = useWorkingTree(props.sessionId)
  const [sideBySide, setSideBySide] = useState(false)
  const [lineComments, setLineComments] = useState<LineComment[]>([])
  
  const [subTab, setSubTab] = useState<'overview' | 'review'>('overview')
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)

  const addComment = (anchor: { file: string; oldLine?: number; newLine?: number }, text: string) => {
    setLineComments((prev) => [
      ...prev,
      { file: anchor.file, oldLine: anchor.oldLine, newLine: anchor.newLine, comment: text },
    ])
  }

  const sendComments = () => {
    if (!props.onSendPrompt || lineComments.length === 0) return
    const lines = lineComments.map(
      (c) => `- ${c.file}:${c.newLine ?? c.oldLine ?? '?'} — ${c.comment}`,
    )
    props.onSendPrompt(t('changes.commentsPrompt', { comments: lines.join('\n') }))
    setLineComments([])
  }

  const sessions = useSessions()
  const session = sessions.data?.find((s) => s.id === props.sessionId)
  const busy = session?.status === 'running'
  const isWorktree = Boolean(session?.worktreeBranch)

  const files = tree.data?.files ?? []
  const totals = useMemo(
    () =>
      files.reduce(
        (acc, f) => {
          acc.add += f.additions
          acc.del += f.deletions
          return acc
        },
        { add: 0, del: 0 },
      ),
    [files],
  )

  const delegation = useSessionEventsSelector(props.sessionId, (v) => v.delegation ?? {})
  const subagents = useMemo(() => {
    return Object.values(delegation).sort((a, b) => b.updatedAt - a.updatedAt)
  }, [delegation])
  const { total: totalWorkers } = summarizeDelegation(delegation)

  const jobs = useSessionEventsSelector(props.sessionId, (v) => v.jobs ?? {})
  const jobList = useMemo(() => {
    return Object.values(jobs).sort((a, b) => b.startedAt - a.startedAt)
  }, [jobs])
  const totalJobs = jobList.length

  const sortedArtifacts = useMemo(() => {
    return [...props.artifacts].sort((a, b) => b.createdAt - a.createdAt)
  }, [props.artifacts])

  useEffect(() => {
    if (subTab === 'review' && !selectedFilePath && files.length > 0) {
      setSelectedFilePath(files[0]!.path)
    }
  }, [subTab, selectedFilePath, files])

  const handleSelectFile = (path: string) => {
    setSelectedFilePath(path)
    setSubTab('review')
  }

  if (!enabled) {
    return <div className="empty sm">{t('changes.noSession')}</div>
  }
  if (tree.isLoading) {
    return <div className="empty sm">{t('changes.loading')}</div>
  }
  if (tree.isError) {
    return <div className="empty sm">{t('changes.treeFailed')}</div>
  }
  if (tree.data && !tree.data.isRepo) {
    return <div className="empty sm">{t('changes.notRepo')}</div>
  }

  return (
    <div className="changes-overview">
      <div className="changes-tab-header">
        <div className="changes-tabs-capsule">
          <button 
            className={`changes-tab-btn ${subTab === 'overview' ? 'active' : ''}`}
            onClick={() => setSubTab('overview')}
          >
            概览 Overview
          </button>
          <button 
            className={`changes-tab-btn ${subTab === 'review' ? 'active' : ''}`}
            onClick={() => setSubTab('review')}
            disabled={files.length === 0}
          >
            评审 Review
          </button>
        </div>
      </div>

      {subTab === 'overview' ? (
        <div className="changes-overview-content">
          <div className="changes-summary">
            <span className="changes-summary-count">{t('changes.filesChanged', { n: files.length })}</span>
            <span className="changes-summary-delta">
              {totals.add > 0 && <span className="add">+{totals.add}</span>}
              {totals.del > 0 && <span className="del">-{totals.del}</span>}
            </span>
          </div>

          {files.length === 0 ? (
            <div className="empty sm">{t('changes.empty')}</div>
          ) : (
            <div className="dashboard-groups">
              <DashboardGroup 
                title="Subagents" 
                count={totalWorkers} 
                icon={<Users size={16} className="text-accent" />}
              >
                {totalWorkers === 0 ? (
                  <div className="empty sm muted">No active subagents</div>
                ) : (
                  <div className="dashboard-list">
                    {subagents.map((s) => (
                      <div key={s.workerId} className="dashboard-subagent-row">
                        <div className="dashboard-subagent-info">
                          <span className="dashboard-subagent-profile">{s.profile || 'subagent'}</span>
                          <span className="dashboard-subagent-objective" title={s.objective}>{s.objective}</span>
                        </div>
                        <div className="dashboard-subagent-meta">
                          <span className={`status-badge ${s.status}`}>{s.status}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </DashboardGroup>

              <DashboardGroup 
                title="Files Changed" 
                count={files.length} 
                icon={<FileCode size={16} className="text-accent" />}
                defaultOpen={true}
              >
                <div className="dashboard-list">
                  {files.map((f) => {
                    const parts = f.path.split('/')
                    const fileName = parts.pop() || f.path
                    const dirPath = parts.join('/')
                    return (
                      <div 
                        key={f.path} 
                        className="dashboard-file-row"
                        onClick={() => handleSelectFile(f.path)}
                      >
                        <div className="dashboard-file-info">
                          {getFileIcon(f.path)}
                          <span className="dashboard-file-name">{fileName}</span>
                          {dirPath && <span className="dashboard-file-dir">{dirPath}</span>}
                        </div>
                        <div className="dashboard-file-delta">
                          {f.additions > 0 && <span className="add">+{f.additions}</span>}
                          {f.deletions > 0 && <span className="del">-{f.deletions}</span>}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </DashboardGroup>

              <DashboardGroup 
                title="Artifacts" 
                count={props.artifacts.length} 
                icon={<FileText size={16} className="text-accent" />}
                defaultOpen={true}
              >
                {props.artifacts.length === 0 ? (
                  <div className="empty sm muted">No artifacts generated</div>
                ) : (
                  <div className="dashboard-list">
                    {sortedArtifacts.map((a) => {
                      let label = a.summary || a.target
                      if (a.tool === 'walkthrough') label = 'Walkthrough'
                      else if (a.target.endsWith('task.md') || a.tool === 'task') label = 'Task'
                      else if (a.kind === 'screenshot') label = `Media (Today ${new Date(a.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`
                      
                      return (
                        <div 
                          key={a.id} 
                          className="dashboard-artifact-row"
                          onClick={() => props.onViewArtifact?.(a)}
                        >
                          <div className="dashboard-artifact-info">
                            {getArtifactIcon(a)}
                            <span className="dashboard-artifact-label">{label}</span>
                          </div>
                          <div className="dashboard-artifact-meta">
                            {formatArtifactTime(a.createdAt)}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </DashboardGroup>

              <DashboardGroup 
                title="Background Tasks" 
                count={totalJobs} 
                icon={<Terminal size={16} className="text-accent" />}
              >
                {totalJobs === 0 ? (
                  <div className="empty sm muted">No running jobs</div>
                ) : (
                  <div className="dashboard-list">
                    {jobList.map((j) => (
                      <div key={j.id || j.startedAt} className="dashboard-job-row">
                        <div className="dashboard-job-info">
                          <Terminal size={14} className="dashboard-job-icon" />
                          <span className="dashboard-job-cmd" title={j.command}>{j.command}</span>
                        </div>
                        <div className="dashboard-job-meta">
                          <span className={`status-badge ${j.status}`}>{j.status}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </DashboardGroup>
            </div>
          )}

          {props.sessionId && (
            <LandingBar
              sessionId={props.sessionId}
              busy={busy}
              isWorktree={isWorktree}
              onSendPrompt={props.onSendPrompt}
            />
          )}
        </div>
      ) : (
        <div className="changes-review-content">
          <div className="review-nav-bar">
            <button className="review-back-btn" onClick={() => setSubTab('overview')}>
              <ArrowLeft size={14} />
              <span>概览 Overview</span>
            </button>

            <div className="review-file-nav">
              <select
                className="review-file-select"
                value={selectedFilePath ?? ''}
                onChange={(e) => setSelectedFilePath(e.target.value)}
              >
                {files.map((f) => (
                  <option key={f.path} value={f.path}>
                    {f.path}
                  </option>
                ))}
              </select>

              <div className="review-nav-buttons">
                <button
                  className="review-nav-arrow"
                  disabled={files.findIndex((f) => f.path === selectedFilePath) <= 0}
                  onClick={() => {
                    const idx = files.findIndex((f) => f.path === selectedFilePath)
                    if (idx > 0) setSelectedFilePath(files[idx - 1]!.path)
                  }}
                  title="上一个文件"
                >
                  ◀
                </button>
                <button
                  className="review-nav-arrow"
                  disabled={files.findIndex((f) => f.path === selectedFilePath) >= files.length - 1}
                  onClick={() => {
                    const idx = files.findIndex((f) => f.path === selectedFilePath)
                    if (idx < files.length - 1) setSelectedFilePath(files[idx + 1]!.path)
                  }}
                  title="下一个文件"
                >
                  ▶
                </button>
              </div>
            </div>

            <button
              className={`diff-toggle ${sideBySide ? 'active' : ''}`}
              onClick={() => setSideBySide((v) => !v)}
              title={t('changes.toggleLayoutTitle')}
            >
              {sideBySide ? t('changes.split') : t('changes.unified')}
            </button>
          </div>

          <div className="review-card-container">
            {selectedFilePath && files.some((f) => f.path === selectedFilePath) ? (
              <FileDiffCard
                file={files.find((f) => f.path === selectedFilePath)!}
                sessionId={props.sessionId}
                sideBySide={sideBySide}
                defaultOpen={true}
                comments={props.onSendPrompt ? lineComments : undefined}
                onLineComment={props.onSendPrompt ? addComment : undefined}
                isSingleFileView={true}
              />
            ) : (
              <div className="empty sm muted">请选择一个文件进行评审</div>
            )}
          </div>

          {props.onSendPrompt && lineComments.length > 0 && (
            <div className="review-comments-footer">
              <button
                className="btn sm primary changes-send-comments"
                onClick={sendComments}
                title={t('changes.sendCommentsTitle')}
              >
                {t('changes.sendComments', { n: lineComments.length })}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function LandingBar(props: {
  sessionId: string
  busy: boolean
  isWorktree: boolean
  onSendPrompt?: (text: string) => void
}) {
  const { sessionId, busy, isWorktree, onSendPrompt } = props
  const { t } = useTranslation('thread')
  const queryClient = useQueryClient()
  const [commitOpen, setCommitOpen] = useState(false)
  const [commitMsg, setCommitMsg] = useState('')
  const [pending, setPending] = useState<null | 'commit' | 'merge' | 'pr'>(null)
  const [notice, setNotice] = useState<null | { kind: 'ok' | 'err'; text: string; url?: string }>(null)

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: qk.workingTree(sessionId) })
  }

  const runCommit = async () => {
    setPending('commit')
    setNotice(null)
    try {
      const r = await commitSessionChanges(sessionId, commitMsg.trim() || undefined)
      if (r.ok && r.nothingToCommit) setNotice({ kind: 'ok', text: t('landingNothingToCommit') })
      else if (r.ok) setNotice({ kind: 'ok', text: t('landingCommitted', { sha: r.sha?.slice(0, 8) ?? '' }) })
      else setNotice({ kind: 'err', text: t('landingFailed', { error: r.error ?? '' }) })
      if (r.ok) {
        setCommitOpen(false)
        setCommitMsg('')
        refresh()
      }
    } catch (e) {
      setNotice({ kind: 'err', text: t('landingFailed', { error: String(e) }) })
    } finally {
      setPending(null)
    }
  }

  const runMerge = async () => {
    setPending('merge')
    setNotice(null)
    try {
      const r = await mergeSessionBack(sessionId)
      if (r.ok && r.nothingToMerge) setNotice({ kind: 'ok', text: t('landingNothingToMerge') })
      else if (r.ok) setNotice({ kind: 'ok', text: t('landingMerged', { sha: r.sha?.slice(0, 8) ?? '' }) })
      else if (r.conflictFiles?.length) setNotice({ kind: 'err', text: t('landingConflicts', { files: r.conflictFiles.join(', ') }) })
      else setNotice({ kind: 'err', text: t('landingFailed', { error: r.error ?? '' }) })
      if (r.ok) refresh()
    } catch (e) {
      setNotice({ kind: 'err', text: t('landingFailed', { error: String(e) }) })
    } finally {
      setPending(null)
    }
  }

  const runPr = async () => {
    setPending('pr')
    setNotice(null)
    try {
      const r = await createSessionPr(sessionId)
      if (r.ok) setNotice({ kind: 'ok', text: t('landingPrCreated'), url: r.url })
      else setNotice({ kind: 'err', text: t('landingFailed', { error: r.error ?? '' }) })
    } catch (e) {
      setNotice({ kind: 'err', text: t('landingFailed', { error: String(e) }) })
    } finally {
      setPending(null)
    }
  }

  const askAgentCommit = () => {
    onSendPrompt?.(t('landingAgentCommitPrompt'))
    setNotice({ kind: 'ok', text: t('landingAgentCommitSent') })
  }

  const directDisabled = busy || pending !== null

  return (
    <div className="changes-landing">
      <div className="changes-landing-actions">
        <button
          className="btn sm"
          disabled={directDisabled}
          onClick={() => setCommitOpen((v) => !v)}
          title={busy ? t('landingBusy') : undefined}
        >
          {pending === 'commit' ? '…' : t('landingCommit')}
        </button>
        {onSendPrompt && (
          <button className="btn sm ghost" onClick={askAgentCommit}>
            {t('landingCommitAgent')}
          </button>
        )}
        {isWorktree && (
          <>
            <button
              className="btn sm"
              disabled={directDisabled}
              onClick={runMerge}
              title={busy ? t('landingBusy') : t('landingMergeBackHint')}
            >
              {pending === 'merge' ? '…' : t('landingMergeBack')}
            </button>
            <button
              className="btn sm"
              disabled={directDisabled}
              onClick={runPr}
              title={busy ? t('landingBusy') : t('landingCreatePrHint')}
            >
              {pending === 'pr' ? '…' : t('landingCreatePr')}
            </button>
          </>
        )}
      </div>
      {commitOpen && (
        <div className="changes-landing-commit">
          <input
            type="text"
            value={commitMsg}
            placeholder={t('landingCommitMsgPlaceholder')}
            onChange={(e) => setCommitMsg(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !directDisabled) void runCommit() }}
            autoFocus
          />
          <button className="btn sm primary" disabled={directDisabled} onClick={runCommit}>
            {t('landingConfirm')}
          </button>
        </div>
      )}
      {notice && (
        <div className={`changes-landing-notice ${notice.kind}`}>
          {notice.text}
          {notice.url && (
            <a href={notice.url} target="_blank" rel="noreferrer">{notice.url}</a>
          )}
        </div>
      )}
    </div>
  )
}

function FileDiffCard(props: {
  file: WorkingTreeFile
  sessionId: string | null
  sideBySide: boolean
  defaultOpen: boolean
  comments?: LineComment[]
  onLineComment?: (anchor: { file: string; oldLine?: number; newLine?: number }, text: string) => void
  isSingleFileView?: boolean
}) {
  const { file, sessionId, sideBySide, defaultOpen, comments, onLineComment, isSingleFileView } = props
  const { t } = useTranslation('git')
  const [open, setOpen] = useState(defaultOpen)
  const diff = useFileDiff(isSingleFileView || open ? file.path : null, sessionId)

  if (isSingleFileView) {
    return (
      <div className="file-diff-card-body single-view">
        {diff.isLoading ? (
          <div className="empty sm">{t('changes.loadingDiff')}</div>
        ) : diff.isError ? (
          <div className="empty sm">{t('changes.diffFailed')}</div>
        ) : !diff.data?.diff ? (
          <div className="empty sm muted">{t('changes.binaryNoDiff')}</div>
        ) : (
          <DiffView
            raw={diff.data.diff}
            sideBySide={sideBySide}
            hideToolbar
            comments={comments}
            onLineComment={onLineComment}
          />
        )}
      </div>
    )
  }

  return (
    <div className={`file-diff-card ${open ? 'open' : ''}`}>
      <button className="file-diff-card-head" onClick={() => setOpen((v) => !v)} title={file.path}>
        <span className="file-diff-chevron" aria-hidden>{open ? '▾' : '▸'}</span>
        <span className={`changes-status ${STATUS_CLASS[file.status]}`} aria-hidden>
          {STATUS_LABEL[file.status]}
        </span>
        <span className="file-diff-path">{file.path}</span>
        <span className="file-diff-delta">
          {file.additions > 0 && <span className="add">+{file.additions}</span>}
          {file.deletions > 0 && <span className="del">-{file.deletions}</span>}
        </span>
      </button>
      {open && (
        <div className="file-diff-card-body">
          {diff.isLoading ? (
            <div className="empty sm">{t('changes.loadingDiff')}</div>
          ) : diff.isError ? (
            <div className="empty sm">{t('changes.diffFailed')}</div>
          ) : !diff.data?.diff ? (
            <div className="empty sm muted">{t('changes.binaryNoDiff')}</div>
          ) : (
            <DiffView
              raw={diff.data.diff}
              sideBySide={sideBySide}
              hideToolbar
              comments={comments}
              onLineComment={onLineComment}
            />
          )}
        </div>
      )}
    </div>
  )
}
