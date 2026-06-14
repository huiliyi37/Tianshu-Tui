import { useEffect, useRef } from 'react'
import { useSessions } from './queries'
import { initNotificationRouting, notifyRouted } from '../lib/notify'
import { useUiDispatch } from './store'
import { isAutonomous } from '../lib/autonomy'

interface Snap { status: string; pendingApprovals: number }

// Cross-session desktop notifications (Q2/S). Diffs successive session-list polls
// and fires an OS notification for ANY session (not just the active one) that
// newly needs approval or transitions to completed/failed. The first snapshot is
// only primed (no notification) to avoid a burst on app start. Per-reason copy;
// autonomous sessions suppress per-approval pings (they auto-run); clicking a
// notification focuses the window and jumps to that session.
export function useGlobalNotifications(): void {
  const sessions = useSessions()
  const dispatch = useUiDispatch()
  const prev = useRef<Map<string, Snap>>(new Map())
  const primed = useRef(false)

  useEffect(() => {
    initNotificationRouting((sessionId) => {
      dispatch({ type: 'setActive', id: sessionId })
      dispatch({ type: 'setSurface', surface: 'workspace' })
    })
  }, [dispatch])

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
      // Autonomous sessions auto-approve in-project; don't ping per approval.
      if (
        !isAutonomous(s.approvalMode) &&
        s.pendingApprovals > 0 &&
        (!was || was.pendingApprovals === 0)
      ) {
        void notifyRouted('需要批准', `${label} 有 ${s.pendingApprovals} 项待你审批`, s.id)
      }
      if (was && was.status !== s.status) {
        if (s.status === 'completed') {
          void notifyRouted('任务完成', `${label} 已完成，点击查看结果`, s.id)
        } else if (s.status === 'failed') {
          void notifyRouted('任务失败', `${label} 失败：${s.error || '未知错误'}`, s.id)
        }
      }
    }
    prev.current = snapshot()
  }, [sessions.data])
}
