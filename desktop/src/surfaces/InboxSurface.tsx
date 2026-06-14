import { useSessions } from '../state/queries'
import { useUiDispatch } from '../state/store'

// N0 placeholder; N3 fills this with a cross-session notification center
// (needs-approval / completed / failed). For now it surfaces sessions that need
// attention so the surface is wired end to end.
export function InboxSurface() {
  const sessions = useSessions()
  const dispatch = useUiDispatch()
  const items = (sessions.data ?? []).filter(
    (s) => s.pendingApprovals > 0 || s.status === 'failed',
  )

  return (
    <div className="single-pane">
      <div className="panel-header"><span>需处理</span></div>
      {items.length === 0 && <div className="empty">没有需要关注的线程</div>}
      {items.map((s) => (
        <div
          key={s.id}
          className="inbox-card"
          onClick={() => {
            dispatch({ type: 'setActive', id: s.id })
            dispatch({ type: 'setSurface', surface: 'workspace' })
          }}
        >
          <div className="title">{s.title ?? s.id.slice(0, 8)}</div>
          <div className="meta">
            {s.pendingApprovals > 0 ? `⚠ ${s.pendingApprovals} 待审批` : ''}
            {s.status === 'failed' ? ' ✕ 失败' : ''}
          </div>
        </div>
      ))}
    </div>
  )
}
