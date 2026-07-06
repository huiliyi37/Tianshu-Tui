import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, LayoutGrid, Radio } from 'lucide-react'
import { useSessions } from '../state/queries'
import { useUiDispatch, useUiState } from '../state/store'
import { projectId } from '../lib/projects'
import { AgentCardWrapper } from '../components/AgentCard'
import type { SessionRecord } from '../runtime/types'

/** Connection budget: the webview caps ~6 concurrent connections to the
 *  sidecar (HTTP/1.1, single origin). We reserve ~1 for the shared polls/
 *  actions and let at most this many cards hold a live SSE stream. */
const MAX_LIVE = 5

type ProjectFilter = 'active' | 'all'

/** Running first, then by most-recent activity — the order cards appear in. */
function cardOrder(a: SessionRecord, b: SessionRecord): number {
  const ra = a.status === 'running' ? 1 : 0
  const rb = b.status === 'running' ? 1 : 0
  if (ra !== rb) return rb - ra
  return b.updatedAt - a.updatedAt
}

/** Live-stream priority among running sessions: pending approvals first
 *  (they block progress), then most-recent activity. */
function livePriority(a: SessionRecord, b: SessionRecord): number {
  const pa = a.pendingApprovals > 0 ? 1 : 0
  const pb = b.pendingApprovals > 0 ? 1 : 0
  if (pa !== pb) return pb - pa
  return b.updatedAt - a.updatedAt
}

/**
 * 任务中控台 — a dashboard observing N sessions at once. Every card is driven
 * by the shared 2s session poll; a capped pool of running sessions additionally
 * holds a live SSE mini-stream (phase + tail blocks + edit counts).
 *
 * Rendered as a surface inside WorkspaceSurface, so the active thread's stream
 * is unloaded while mission is open — that frees the connection budget for the
 * live pool here.
 */
export function MissionControlSurface() {
  const { t } = useTranslation('mission')
  const sessions = useSessions()
  const ui = useUiState()
  const dispatch = useUiDispatch()
  const [filter, setFilter] = useState<ProjectFilter>(ui.activeProject ? 'active' : 'all')

  const all = sessions.data ?? []

  const cards = useMemo(() => {
    const visible = all.filter((s) => {
      if (s.archived) return false
      if (filter === 'active' && ui.activeProject) {
        return projectId(s.cwd) === ui.activeProject
      }
      return true
    })
    return [...visible].sort(cardOrder)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, filter, ui.activeProject])

  // The live id set: running sessions, prioritized, capped. Memoized on a
  // sorted-id STRING so the set keeps referential identity across polls that
  // don't change membership — otherwise every 2s tick would remount streams.
  const liveKey = useMemo(() => {
    return cards
      .filter((s) => s.status === 'running')
      .sort(livePriority)
      .slice(0, MAX_LIVE)
      .map((s) => s.id)
      .sort()
      .join(',')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards])

  const liveIds = useMemo(() => new Set(liveKey ? liveKey.split(',') : []), [liveKey])

  const openSession = (s: SessionRecord) => {
    if (s.cwd) dispatch({ type: 'setProject', projectId: projectId(s.cwd) })
    dispatch({ type: 'setActive', id: s.id })
    dispatch({ type: 'setSurface', surface: 'workspace' })
  }

  const liveCount = liveIds.size
  const runningCount = cards.filter((s) => s.status === 'running').length

  return (
    <div className="mission-surface">
      <header className="mission-top">
        <div className="mission-top-brand">
          <span className="mission-top-icon" aria-hidden>
            <LayoutGrid size={18} strokeWidth={1.8} />
          </span>
          <h1 className="mission-top-title">{t('title')}</h1>
        </div>
        <span className="mission-top-stat">
          <span className="mission-stat-pill">{t('statSessions', { n: cards.length })}</span>
          <span className="mission-stat-pill running">{t('statRunning', { n: runningCount })}</span>
          <span className="mission-stat-pill live">
            <Radio size={12} strokeWidth={2} aria-hidden />
            {t('statLive', { n: liveCount })}
          </span>
        </span>
        <div className="mission-top-spacer" />
        {ui.activeProject && (
          <div className="mission-filter">
            <button
              className={`mission-filter-btn${filter === 'active' ? ' is-on' : ''}`}
              onClick={() => setFilter('active')}
            >
              {t('filterActive')}
            </button>
            <button
              className={`mission-filter-btn${filter === 'all' ? ' is-on' : ''}`}
              onClick={() => setFilter('all')}
            >
              {t('filterAll')}
            </button>
          </div>
        )}
        <button
          className="mission-top-new"
          onClick={() => dispatch({ type: 'openNew', open: true })}
          title={t('newThreadHint')}
        >
          <Plus size={16} strokeWidth={1.8} aria-hidden />
          <span>{t('newThread')}</span>
        </button>
      </header>

      {cards.length === 0 ? (
        <div className="mission-empty-state">
          {sessions.isLoading ? t('loading') : t('empty')}
        </div>
      ) : (
        <div className="mission-grid">
          {cards.map((s) => (
            <AgentCardWrapper
              key={s.id}
              session={s}
              live={liveIds.has(s.id)}
              onOpen={openSession}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default MissionControlSurface
