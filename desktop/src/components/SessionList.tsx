import type { SessionRecord } from '../runtime/types'

const GLYPH: Record<string, string> = {
  running: '◴',
  completed: '✓',
  failed: '✕',
  aborted: '⊘',
  idle: '○',
}

export function SessionList(props: {
  sessions: SessionRecord[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
}) {
  const { sessions, activeId, onSelect, onNew } = props
  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span>Agent Manager</span>
        <button className="btn" onClick={onNew}>+ 新会话</button>
      </div>
      {sessions.length === 0 && <div className="empty">还没有 agent 在跑</div>}
      {sessions.map((s) => (
        <div
          key={s.id}
          className={`session-card ${s.id === activeId ? 'active' : ''}`}
          onClick={() => onSelect(s.id)}
        >
          <div className="title">
            <span className={`status-dot status-${s.status}`} />
            {s.title ?? s.id.slice(0, 8)}
          </div>
          <div className="meta">
            {GLYPH[s.status] ?? '·'} {s.status}
            {s.currentPhase ? ` · ${s.currentPhase}` : ''}
            {s.pendingApprovals > 0 ? ` · ⚠ ${s.pendingApprovals} 待审批` : ''}
          </div>
        </div>
      ))}
    </div>
  )
}
