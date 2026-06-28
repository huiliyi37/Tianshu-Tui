import { useEffect, useMemo, useRef, useState } from 'react'
import {
  LayoutDashboard, Clock, Bell, Puzzle, GitBranch, BarChart3,
  Network, Settings, Scale, Plug, type LucideIcon,
} from 'lucide-react'
import { useCloseSession, useSessions, useUnarchiveSession } from '../state/queries'
import { useUiDispatch, useUiState, type Surface } from '../state/store'
import { addKnownProject, deriveProjects, loadKnownProjects, projectId, type StoredProject } from '../lib/projects'
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

const SURFACE_ORDER: Surface[] = ['workspace', 'automations', 'attention', 'skills', 'git', 'insights', 'delegation', 'council', 'hooks', 'settings']

const SURFACE_LABEL: Record<Surface, string> = {
  workspace: '工作台',
  automations: '自动化',
  attention: '需处理',
  skills: '技能',
  git: 'Git',
  insights: 'Insights',
  delegation: '委派树',
  council: '议事会',
  hooks: 'Hooks',
  settings: '设置',
}

const NAV_ICONS: Record<Surface, LucideIcon> = {
  workspace: LayoutDashboard,
  automations: Clock,
  attention: Bell,
  skills: Puzzle,
  git: GitBranch,
  insights: BarChart3,
  delegation: Network,
  council: Scale,
  hooks: Plug,
  settings: Settings,
}

function NavIcon({ surface }: { surface: Surface }) {
  const Ic = NAV_ICONS[surface]
  return <Ic size={16} strokeWidth={1.7} aria-hidden />
}
// Project → Thread sidebar (Cursor 3.0 style).
// Top: New Session button + main navigation. Below: project tree of sessions.
export function ProjectSidebar() {
  const ui = useUiState()
  const dispatch = useUiDispatch()
  const sessions = useSessions()
  const closeSession = useCloseSession()
  const unarchive = useUnarchiveSession()
  const [known, setKnown] = useState(() => loadKnownProjects())
  const [filter, setFilter] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [archivedSessions, setArchivedSessions] = useState<SessionRecord[]>([])
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set())
  const searchRef = useRef<HTMLInputElement>(null)

  const loadArchived = async () => {
    const next = !showArchived
    setShowArchived(next)
    if (next) {
      try {
        const all = await listAllSessions()
        setArchivedSessions(all.filter((s) => s.archived))
      } catch { setArchivedSessions([]) }
    }
  }

  const projects = useMemo(
    () => deriveProjects(sessions.data ?? [], known),
    [sessions.data, known],
  )

  // All non-archived sessions, optionally filtered by search query.
  const visibleSessions = useMemo(() => {
    let list = (sessions.data ?? []).filter((s) => !s.archived)
    const q = filter.trim().toLowerCase()
    if (q) {
      list = list.filter((s) =>
        (s.title ?? '').toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        (s.currentPhase ?? '').toLowerCase().includes(q) ||
        s.cwd.toLowerCase().includes(q),
      )
    }
    return list.sort((a, b) => b.updatedAt - a.updatedAt)
  }, [sessions.data, filter])

  // Group sessions by project id (slug of primary root). A multi-root project
  // stays a single group even if sessions land in different roots.
  const projectGroups = useMemo(() => {
    const groups = new Map<string, SessionRecord[]>()
    for (const s of visibleSessions) {
      const key = projectId(s.cwd)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(s)
    }
    return groups
  }, [visibleSessions])

  // Ensure active project is expanded.
  useEffect(() => {
    if (ui.activeProject) {
      setExpandedProjects((prev) => {
        if (prev.has(ui.activeProject!)) return prev
        const next = new Set(prev)
        next.add(ui.activeProject!)
        return next
      })
    }
  }, [ui.activeProject])

  const openFolder = async () => {
    let cwd = await pickFolder()
    if (!cwd) {
      cwd = typeof window !== 'undefined' ? window.prompt('项目文件夹绝对路径') : null
    }
    if (!cwd) return
    setKnown(addKnownProject(cwd))
    dispatch({ type: 'setProject', projectId: projectId(cwd) })
  }

  const toggleProject = (id: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const activeProjectName = projects.find((p) => p.id === ui.activeProject)?.name

  return (
    <div className="project-sidebar">
      <button
        className="sidebar-new-btn"
        onClick={() => dispatch({ type: 'openNew', open: true })}
        title="新建线程 (⌘N)"
      >
        <span className="snb-glyph" aria-hidden>+</span>
        <span className="snb-label">New Session</span>
        <span className="snb-hint">⌘N</span>
      </button>

      <nav className="sidebar-nav" aria-label="主导航">
        {SURFACE_ORDER.map((s) => (
          <button
            key={s}
            className={`sidebar-nav-item ${ui.surface === s ? 'active' : ''}`}
            onClick={() => dispatch({ type: 'setSurface', surface: s })}
          >
            <span className="sni-icon"><NavIcon surface={s} /></span>
            <span className="sni-label">{SURFACE_LABEL[s]}</span>
            {s === 'attention' && (
              <AttentionBadge />
            )}
          </button>
        ))}
      </nav>

      <div className="sidebar-divider" />

      <div className="search-wrapper">
        <span className="search-icon" aria-hidden>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
        </span>
        <input
          ref={searchRef}
          className="thread-filter"
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="搜索会话…"
          aria-label="搜索会话"
        />
        {filter && (
          <button
            className="search-clear"
            onClick={() => setFilter('')}
            aria-label="清除搜索"
            title="清除搜索"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      <div className="sidebar-section-head">
        <span className="sidebar-section-title">Home</span>
        <span className="sidebar-section-count">{visibleSessions.length}</span>
      </div>

      {visibleSessions.length === 0 && !filter && (
        <div className="sidebar-empty">No sessions yet</div>
      )}
      {filter && visibleSessions.length === 0 && (
        <div className="sidebar-empty">No matches</div>
      )}

      <div className="project-tree" role="tree">
        {projects.map((p) => {
          const group = projectGroups.get(p.id) ?? []
          const expanded = expandedProjects.has(p.id) || filter.length > 0
          const isActiveProject = p.id === ui.activeProject
          return (
            <div key={p.id} className="project-tree-node" role="treeitem" aria-expanded={expanded}>
              <button
                className={`project-tree-header ${isActiveProject ? 'active' : ''}`}
                onClick={() => {
                  dispatch({ type: 'setProject', projectId: p.id })
                  toggleProject(p.id)
                }}
              >
                <span className={`pt-chev ${expanded ? 'open' : ''}`} aria-hidden>▸</span>
                <span className="pt-folder" aria-hidden>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
                  </svg>
                </span>
                <span className="pt-name">{p.name}</span>
                {p.roots.length > 1 && (
                  <span className="pt-repo-badge" title={p.roots.join('\n')}>
                    {p.roots.length} repos
                  </span>
                )}
                <span className="pt-count">{group.length}</span>
              </button>
              {expanded && (
                <div className="project-tree-children">
                  {group.map((s) => (
                    <div
                      key={s.id}
                      className={`thread-row ${s.id === ui.activeSessionId ? 'active' : ''}`}
                      onClick={() => dispatch({ type: 'setActive', id: s.id })}
                    >
                      <div className="thread-row-main">
                        <div className="title">
                          <span className={`status-dot status-${s.status}`} />
                          {s.domainGlyph && (
                            <span className={`domain-glyph domain-accent-${s.domainAccent}`} aria-hidden>
                              {s.domainGlyph}
                            </span>
                          )}
                          {s.title ?? s.id.slice(0, 8)}
                          {s.planMode === 'planning' && <span className="thread-plan-badge">Plan</span>}
                          {s.worktreeBranch && (
                            <span className="thread-wt-badge" title={`Worktree: ${s.worktreeBranch}`}>
                              ⑂ {s.worktreeBranch.replace(/^rivet-hands-/, '').slice(0, 8)}
                            </span>
                          )}
                        </div>
                        <div className="meta">
                          {STATUS_GLYPH[s.status] ?? '·'} {s.status}
                          {s.currentPhase ? ` · ${s.currentPhase}` : ''}
                          {s.pendingApprovals > 0 ? ` · ⚠ ${s.pendingApprovals}` : ''}
                        </div>
                      </div>
                      <button
                        className="thread-row-close"
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
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="sidebar-divider" />

      <div className="sidebar-tools">
        <button className="sidebar-tool-row" onClick={openFolder} title="打开项目文件夹">
          <span className="sidebar-tool-icon" aria-hidden>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
              <path d="M12 11v5M9.5 13.5h5" />
            </svg>
          </span>
          <span className="sidebar-tool-label">打开文件夹</span>
        </button>
        <button
          className={`sidebar-tool-row ${showArchived ? 'open' : ''}`}
          onClick={loadArchived}
          title="归档会话"
        >
          <span className="sidebar-tool-icon" aria-hidden>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
            </svg>
          </span>
          <span className="sidebar-tool-label">归档会话</span>
          <span className="sidebar-tool-chev" aria-hidden>▸</span>
        </button>
      </div>

      {showArchived && (
        <div className="archived-section">
          {archivedSessions.length === 0 && <div className="sidebar-empty">没有归档会话</div>}
          {archivedSessions.map((s) => (
            <div key={s.id} className="thread-row archived">
              <div className="thread-row-main">
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
                  setArchivedSessions((prev) => prev.filter((a) => a.id !== s.id))
                }}
              >恢复</button>
            </div>
          ))}
        </div>
      )}

      {activeProjectName && (
        <div className="sidebar-active-project" title={ui.activeProject ?? undefined}>
          <span className="sidebar-active-label">当前项目</span>
          <span className="sidebar-active-name">{activeProjectName}</span>
        </div>
      )}
    </div>
  )
}

function AttentionBadge() {
  const sessions = useSessions()
  const count = useMemo(() => {
    return (sessions.data ?? []).filter((s) => {
      if (s.status !== 'running') return false
      // Simple heuristic: attention-worthy sessions have pending approvals or errors.
      return (s.pendingApprovals ?? 0) > 0
    }).length
  }, [sessions.data])
  if (count === 0) return null
  return <span className="sidebar-nav-badge">{count > 9 ? '9+' : count}</span>
}
