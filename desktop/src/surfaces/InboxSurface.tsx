import { useSessions } from '../state/queries'
import { useUiDispatch, useUiState } from '../state/store'
import { deriveAttention, type AttentionItem, type AttentionReason } from '../lib/attention'
import { projectId } from '../lib/projects'

const REASON_LABEL: Record<AttentionReason, string> = {
  approval: '待审批',
  failed: '失败',
  completed: '已完成',
}

// Attention center (Q2) — cross-session feed of items needing the human, grouped
// by project. Click jumps to the thread; opening (or "全部清除") marks seen so the
// Rail badge clears.
export function InboxSurface() {
  const sessions = useSessions()
  const ui = useUiState()
  const dispatch = useUiDispatch()
  const view = deriveAttention(sessions.data ?? [], new Set(ui.attentionSeen))

  const open = (it: AttentionItem) => {
    dispatch({ type: 'setProject', projectId: projectId(it.cwd) })
    dispatch({ type: 'setActive', id: it.sessionId })
    dispatch({ type: 'setSurface', surface: 'workspace' })
    dispatch({ type: 'markSeen', sigs: [it.sig] })
  }

  const clearAll = () => dispatch({ type: 'markSeen', sigs: view.items.map((i) => i.sig) })

  return (
    <div className="single-pane attention">
      <div className="panel-header">
        <span>需处理{view.unseenCount > 0 ? ` · ${view.unseenCount}` : ''}</span>
        {view.items.length > 0 && (
          <button className="btn ghost sm" onClick={clearAll}>全部清除</button>
        )}
      </div>

      {view.items.length === 0 && <div className="empty">没有需要关注的线程</div>}

      {view.groups.map((g) => (
        <div key={g.cwd} className="attn-group">
          <div className="attn-group-name" title={g.cwd}>{g.name}</div>
          {g.items.map((it) => {
            const unseen = !ui.attentionSeen.includes(it.sig)
            return (
              <div
                key={it.sig}
                className={`attn-card reason-${it.reason} ${unseen ? 'unseen' : ''}`}
                onClick={() => open(it)}
              >
                <span className={`status-dot reason-${it.reason}`} />
                <div className="attn-body">
                  <div className="title">{it.title}</div>
                  <div className="meta">{REASON_LABEL[it.reason]} · {it.detail}</div>
                </div>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
