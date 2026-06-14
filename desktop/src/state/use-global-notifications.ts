import { useEffect, useRef } from 'react'
import { useSessions } from './queries'
import { notify } from '../lib/notify'

interface Snap { status: string; pendingApprovals: number }

// Cross-session desktop notifications (Q2). Diffs successive session-list polls
// and fires an OS notification for ANY session (not just the active one) that
// newly needs approval or transitions to completed/failed. The first snapshot is
// only primed (no notification) to avoid a burst on app start.
export function useGlobalNotifications(): void {
  const sessions = useSessions()
  const prev = useRef<Map<string, Snap>>(new Map())
  const primed = useRef(false)

  useEffect(() => {
    const list = sessions.data
    if (list === undefined) return

    const snapshot = () =>
      new Map(list.map((s) => [s.id, { status: s.status, pendingApprovals: s.pendingApprovals }]))

    if (!primed.current) {
      prev.current = snapshot()
      primed.current = true
      return
    }

    const before = prev.current
    for (const s of list) {
      const was = before.get(s.id)
      const label = s.title ?? s.id.slice(0, 8)
      if (s.pendingApprovals > 0 && (!was || was.pendingApprovals === 0)) {
        void notify('需要批准', `${label} 有 ${s.pendingApprovals} 项待审批`)
      }
      if (was && was.status !== s.status && (s.status === 'completed' || s.status === 'failed')) {
        void notify('会话结束', `${label} ${s.status === 'completed' ? '已完成' : '失败'}`)
      }
    }
    prev.current = snapshot()
  }, [sessions.data])
}
