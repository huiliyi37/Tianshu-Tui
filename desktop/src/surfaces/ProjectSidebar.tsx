import { useMemo, useState } from 'react'
import { useCloseSession, useSessions, useUnarchiveSession } from '../state/queries'
import { useUiDispatch, useUiState } from '../state/store'
import { addKnownProject, deriveProjects, loadKnownProjects } from '../lib/projects'
import { pickFolder } from '../lib/dialog'
import { listAllSessions } from '../runtime/client'
import type { SessionRecord } from '../runtime/types'

const STATUS_GLYPH: Record<string, string> = {
  running: '◴',
  completed: '✓',
  failed: '✕',
  aborted: '⊘',
  idle: '○',
}

// Project → Thread sidebar (P1). Top: project switcher + open-folder. Below:
// the threads (sessions) that belong to the active project (matched by cwd).
export function ProjectSidebar() {
  const ui = useUiState()
  const dispatch = useUiDispatch()
  const sessions = useSessions()
  const closeSession = useCloseSession()
  const unarchive = useUnarchiveSession()
  const [known, setKnown] = useState<string[]>(() => loadKnownProjects())
  const [filter, setFilter] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [archivedSessions, setArchivedSessions] = useState<SessionRecord[]>([])

  const loadArchived = async () => {
    const next = !showArchived
    setShowArchived(next)
    if (next) {
      try {
        const all = await listAllSessions()
        setArchivedSessions(all.filter(s => s.archived))
      } catch { setArchivedSessions([]) }
    }
  }

  const projects = useMemo(
    () => deriveProjects(sessions.data ?? [], known),
    [sessions.data, known],
  )

  const threads = useMemo(() => {
    let list = (sessions.data ?? []).filter(
      (s) => !ui.activeProject || s.cwd === ui.activeProject,
    )
    const q = filter.trim().toLowerCase()
    if (q) {
      list = list.filter((s) =>
        (s.title ?? '').toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        (s.currentPhase ?? '').toLowerCase().includes(q),
      )
    }
    return list
  }, [sessions.data, ui.activeProject, filter])

  const openFolder = async () => {
    let cwd = await pickFolder()
    if (!cwd) {
      cwd = typeof window !== 'undefined' ? window.prompt('项目文件夹绝对路径') : null
    }
    if (!cwd) return
    setKnown(addKnownProject(cwd))
    dispatch({ type: 'setProject', cwd })
  }

  return (
    <div className="project-sidebar">
      <div className="project-switch">
        <select
          value={ui.activeProject ?? ''}
          onChange={(e) => dispatch({ type: 'setProject', cwd: e.target.value || null })}
        >
          <option value="">所有项目</option>
          {projects.map((p) => (
            <option key={p.cwd} value={p.cwd}>
              {p.name} · {p.threadCount}
            </option>
          ))}
        </select>
        <button className="icon-btn" title="打开文件夹" onClick={openFolder}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
            <path d="M12 11v5M9.5 13.5h5" />
          </svg>
        </button>
      </div>

      {threads.length > 0 || filter ? (
        <input
          className="thread-filter"
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="搜索线程…"
          aria-label="搜索线程"
        />
      ) : null}

      <div className="thread-head">
        <span>线程{filter ? ` · ${threads.length}` : ''}</span>
        <button className="btn sm" onClick={() => dispatch({ type: 'openNew', open: true })}>
          + 新线程
        </button>
      </div>

      {!filter && threads.length === 0 && (
        <div className="empty sm">
          {ui.activeProject ? '该项目还没有线程' : '打开一个文件夹，或新建线程'}
        </div>
      )}
      {filter && threads.length === 0 && (
        <div className="empty sm">没有匹配「{filter}」的线程</div>
      )}
      {threads.map((s) => (
        <div
          key={s.id}
          className={`thread-card ${s.id === ui.activeSessionId ? 'active' : ''}`}
          onClick={() => dispatch({ type: 'setActive', id: s.id })}
        >
          <div className="thread-card-main">
            <div className="title">
              <span className={`status-dot status-${s.status}`} />
              {s.title ?? s.id.slice(0, 8)}
              {s.planMode === 'planning' && <span className="thread-plan-badge">Plan</span>}
              {s.worktreeBranch && <span className="thread-wt-badge" title={`Worktree: ${s.worktreeBranch}`}>⑂ {s.worktreeBranch.replace(/^rivet-hands-/, '').slice(0, 8)}</span>}
            </div>
            <div className="meta">
              {STATUS_GLYPH[s.status] ?? '·'} {s.status}
              {s.currentPhase ? ` · ${s.currentPhase}` : ''}
              {s.pendingApprovals > 0 ? ` · ⚠ ${s.pendingApprovals}` : ''}
            </div>
          </div>
          <button
            className="thread-card-close"
            title="关闭"
            aria-label="关闭会话"
            onClick={(e) => {
              e.stopPropagation()
              closeSession.mutate(s.id)
              if (s.id === ui.activeSessionId) dispatch({ type: 'setActive', id: '' })
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}

      <button className="btn-show-archived" onClick={loadArchived}>
        {showArchived ? '隐藏归档' : '显示归档会话'}
      </button>

      {showArchived && archivedSessions.length > 0 && (
        <div className="archived-section">
          {archivedSessions.map(s => (
            <div key={s.id} className="thread-card archived">
              <div className="thread-card-main">
                <div className="title">
                  <span className="status-dot status-archived" />
                  {s.title ?? s.id.slice(0, 8)}
                </div>
                <div className="meta">归档 · {s.status}</div>
              </div>
              <button
                className="btn-sm"
                title="恢复"
                onClick={() => {
                  unarchive.mutate(s.id)
                  setArchivedSessions(prev => prev.filter(a => a.id !== s.id))
                }}
              >恢复</button>
            </div>
          ))}
        </div>
      )}
      {showArchived && archivedSessions.length === 0 && (
        <div className="empty sm">没有归档的会话</div>
      )}
    </div>
  )
}
