import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  History, Home, Clock, Bell, Puzzle, GitBranch, BarChart3,
  Network, Settings, Scale, Plug, SlidersHorizontal, FolderOpen, LayoutGrid, type LucideIcon,
} from 'lucide-react'
import { useCloseSession, useSessions, useUnarchiveSession } from '../state/queries'
import { useUiDispatch, useUiState, type Surface } from '../state/store'
import { addKnownProject, deriveProjects, loadKnownProjects, projectId } from '../lib/projects'
import { pickFolder } from '../lib/dialog'
import { listAllSessions } from '../runtime/client'
import type { SessionRecord } from '../runtime/types'


const CORE_SURFACES: Surface[] = ['workspace', 'mission', 'automations']
const TOOL_SURFACES: Surface[] = ['git', 'skills', 'insights', 'delegation', 'council', 'hooks']

const NAV_ICONS: Record<Surface, LucideIcon> = {
  home: Home,
  workspace: History,
  mission: LayoutGrid,
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


function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d`
  const months = Math.floor(days / 30)
  return `${months}mo`
}

export function ProjectSidebar(props: { onCollapse?: () => void }) {
  const { onCollapse } = props
  const { t } = useTranslation('nav')
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
  const [toolsExpanded, setToolsExpanded] = useState(false)
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
      <div className="sidebar-top-container">
        <div className="flex items-center justify-between gap-2 mb-2">
          <button
            className="sidebar-new-btn outline flex-1"
            onClick={() => dispatch({ type: 'openNew', open: true })}
            title={`${t('sidebar.newConversation')} (⌘N)`}
            style={{ margin: 0 }}
          >
            <span className="snb-glyph" aria-hidden>+</span>
            <span className="snb-label">{t('sidebar.newConversation')}</span>
          </button>
          {onCollapse && (
            <button
              onClick={onCollapse}
              className="sidebar-collapse-btn p-1.5 rounded hover:bg-panel-2 border border-border text-muted hover:text-text transition-all shrink-0"
              title={`${t('sidebar.collapseSidebar')} (⌘B)`}
              style={{
                width: '32px',
                height: '32px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                background: 'transparent',
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M9 3v18" />
              </svg>
            </button>
          )}
        </div>

        <nav className="sidebar-nav" aria-label={t('sidebar.mainNav')}>
          {CORE_SURFACES.map((s) => (
            <button
              key={s}
              className={`sidebar-nav-item ${ui.surface === s ? 'active' : ''}`}
              onClick={() => dispatch({ type: 'setSurface', surface: s })}
            >
              <span className="sni-icon"><NavIcon surface={s} /></span>
              <span className="sni-label">{t(s)}</span>
            </button>
          ))}

          <div
            className="sidebar-section-head tools-toggle-head"
            onClick={() => setToolsExpanded(!toolsExpanded)}
            style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '8px 0 4px 0', padding: '6px 8px' }}
          >
            <span className="sidebar-section-title">{t('sidebar.tools')}</span>
            <span className="tools-toggle-arrow" style={{ fontSize: '9px', opacity: 0.6 }}>{toolsExpanded ? '▲' : '▼'}</span>
          </div>

          {toolsExpanded && (
            <div className="sidebar-sub-nav">
              {TOOL_SURFACES.map((s) => (
                <button
                  key={s}
                  className={`sidebar-nav-item sub-item ${ui.surface === s ? 'active' : ''}`}
                  onClick={() => dispatch({ type: 'setSurface', surface: s })}
                >
                  <span className="sni-icon"><NavIcon surface={s} /></span>
                  <span className="sni-label">{t(s)}</span>
                </button>
              ))}
            </div>
          )}
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
            placeholder={t('sidebar.searchSessions')}
            aria-label={t('sidebar.searchSessions')}
          />
          {filter && (
            <button
              className="search-clear"
              onClick={() => setFilter('')}
              aria-label={t('sidebar.clearSearch')}
              title={t('sidebar.clearSearch')}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        <div className="sidebar-section-head" style={{ marginTop: '12px' }}>
          <span className="sidebar-section-title">{t('sidebar.projects')}</span>
          <div className="sidebar-section-actions" style={{ display: 'flex', gap: '8px', alignItems: 'center', opacity: 0.6 }}>
            <SlidersHorizontal size={13} style={{ cursor: 'pointer' }} />
            <FolderOpen size={13} style={{ cursor: 'pointer' }} onClick={openFolder} />
          </div>
        </div>

        {visibleSessions.length === 0 && !filter && (
          <div className="sidebar-empty">{t('sidebar.noSessions')}</div>
        )}
        {filter && visibleSessions.length === 0 && (
          <div className="sidebar-empty">{t('sidebar.noMatches')}</div>
        )}
      </div>

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
                    {p.roots.length}
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
                      onClick={() => {
                        dispatch({ type: 'setActive', id: s.id })
                        dispatch({ type: 'setSurface', surface: 'workspace' })
                      }}
                    >
                      <div className="thread-row-main" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                        <div className="title" style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                          <span className={`status-dot status-${s.status}`} />
                          <span className="thread-title-text" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {s.title ?? s.id.slice(0, 8)}
                          </span>
                          {s.planMode === 'planning' && <span className="thread-plan-badge">Plan</span>}
                          {s.worktreeBranch && (
                            <span className="thread-wt-badge" title={`Worktree: ${s.worktreeBranch}`}>
                              ⑂ {s.worktreeBranch.replace(/^rivet-hands-/, '').slice(0, 8)}
                            </span>
                          )}
                        </div>
                        <span className="thread-time" style={{ fontSize: '11px', color: 'var(--muted)', marginLeft: '8px', flexShrink: 0 }}>
                          {formatRelativeTime(s.updatedAt)}
                        </span>
                      </div>
                      <button
                        className="thread-row-close"
                        title={t('sidebar.closeSession')}
                        aria-label={t('sidebar.closeSession')}
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

      {showArchived && archivedSessions.length > 0 && (
        <div className="archived-section" style={{ borderTop: '1px solid var(--border)', paddingTop: '8px', maxHeight: '180px', overflowY: 'auto' }}>
          <div className="sidebar-section-head" style={{ padding: '0 8px 4px' }}>
            <span className="sidebar-section-title">{t('sidebar.archivedSessions')}</span>
          </div>
          {archivedSessions.map((s) => (
            <div key={s.id} className="thread-row archived">
              <div className="thread-row-main" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                <div className="title" style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                  <span className="status-dot status-archived" />
                  <span className="thread-title-text" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.title ?? s.id.slice(0, 8)}
                  </span>
                </div>
              </div>
              <button
                className="btn-sm"
                title={t('sidebar.restore')}
                onClick={() => {
                  unarchive.mutate(s.id)
                  setArchivedSessions((prev) => prev.filter((a) => a.id !== s.id))
                }}
                style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '4px', background: 'var(--panel-3)', border: 'none', cursor: 'pointer' }}
              >{t('sidebar.restore')}</button>
            </div>
          ))}
        </div>
      )}

      {activeProjectName && (
        <div className="sidebar-active-project" title={ui.activeProject ?? undefined} style={{ padding: '8px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: '2px' }}>
          <span className="sidebar-active-label" style={{ fontSize: '10px', color: 'var(--muted)', textTransform: 'uppercase' }}>{t('sidebar.currentProject')}</span>
          <span className="sidebar-active-name" style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-strong)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activeProjectName}</span>
        </div>
      )}

      <div className="sidebar-bottom" style={{ display: 'flex', gap: '4px', borderTop: '1px solid var(--border)', paddingTop: '8px' }}>
        <button
          className={`sidebar-nav-item bottom-settings-btn ${ui.surface === 'settings' ? 'active' : ''}`}
          onClick={() => dispatch({ type: 'setSurface', surface: 'settings' })}
          style={{ flex: 1 }}
        >
          <span className="sni-icon"><Settings size={16} strokeWidth={1.7} /></span>
          <span className="sni-label">{t('settings')}</span>
        </button>
        <button
          className={`sidebar-archive-btn ${showArchived ? 'active' : ''}`}
          onClick={loadArchived}
          title={t('sidebar.archive')}
          style={{
            width: '32px',
            height: '32px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--muted)',
            cursor: 'pointer',
            transition: 'background var(--dur) var(--ease), color var(--dur) var(--ease)'
          }}
        >
          <FolderOpen size={16} />
        </button>
      </div>
    </div>
  )
}

