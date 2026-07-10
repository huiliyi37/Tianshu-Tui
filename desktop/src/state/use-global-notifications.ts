import { useEffect, useRef } from 'react'
import i18n from '../i18n'
import { useSessions } from './queries'
import { useSessionEventsSelector } from './use-session-events'
import { initNotificationRouting, notifyRouted, shouldNotify } from '../lib/notify'
import { loadNotifPref } from '../lib/persist'
import { useUiDispatch, useUiState } from './store'
import { isAutonomous } from '../lib/autonomy'

interface Snap { status: string; pendingApprovals: number }

// 付费版 v1 · T2 — 定时任务派生的会话（SessionRuntimePool titlePrefix）。
// 自动化运行的结束通知走专用文案：成功 → 走查报告就绪；失败/中止 → 原因。
function isScheduledRun(title: string | undefined): boolean {
  return !!title && title.startsWith('scheduled:')
}

type TerminalStatus = 'completed' | 'failed' | 'aborted'

function notifyTerminal(
  sessionId: string,
  status: TerminalStatus,
  label: string,
  error: string | undefined,
  pref: ReturnType<typeof loadNotifPref>,
  scheduled: boolean,
): void {
  const err = error || i18n.t('shell:notify.unknownError')
  if (scheduled) {
    if (status === 'completed') {
      void notifyRouted(i18n.t('shell:notify.automationCompleted'), i18n.t('shell:notify.automationCompletedBody', { label }), sessionId, pref)
    } else if (status === 'failed') {
      void notifyRouted(i18n.t('shell:notify.automationFailed'), i18n.t('shell:notify.automationFailedBody', { label, error: err }), sessionId, pref)
    } else {
      void notifyRouted(i18n.t('shell:notify.automationHalted'), i18n.t('shell:notify.automationHaltedBody', { label, error: err }), sessionId, pref)
    }
    return
  }
  // 非自动化会话维持原行为：aborted（用户自己按的停止）不打扰。
  if (status === 'completed') {
    void notifyRouted(i18n.t('shell:notify.taskCompleted'), i18n.t('shell:notify.completedBody', { label }), sessionId, pref)
  } else if (status === 'failed') {
    void notifyRouted(i18n.t('shell:notify.taskFailed'), i18n.t('shell:notify.failedBody', { label, error: err }), sessionId, pref)
  }
}

// Cross-session desktop notifications (Q2/S). Diffs successive session-list polls
// and fires an OS notification for ANY session (not just the active one) that
// newly needs approval or transitions to completed/failed. The first snapshot is
// only primed (no notification) to avoid a burst on app start. Per-reason copy;
// autonomous sessions suppress per-approval pings (they auto-run); clicking a
// notification focuses the window and jumps to that session.
//
// Two signal sources feed the same notification path:
//   • Active session — its live SSE stream surfaces the `done` event immediately
//     (event-reducer.ts), so we watch useSessionEvents(activeId) for a running→
//     terminal transition and fire instantly instead of waiting for the 2 s poll.
//   • All sessions — the 2 s `useSessions()` poll diff remains the backstop for
//     background/non-active sessions that don't have an open SSE stream.
// `notifiedSet` dedupes so a single completion never pings twice when both
// sources race.
export function useGlobalNotifications(): void {
  const sessions = useSessions()
  const dispatch = useUiDispatch()
  const { activeSessionId } = useUiState()
  const prev = useRef<Map<string, Snap>>(new Map())
  const primed = useRef(false)
  // `sessionId:status` keys for completions already announced this run, so the
  // live SSE path and the poll path don't double-fire on the same transition.
  const notified = useRef<Set<string>>(new Set())
  const activeStatusPrev = useRef<string>('')

  useEffect(() => {
    initNotificationRouting((sessionId) => {
      dispatch({ type: 'setActive', id: sessionId })
      dispatch({ type: 'setSurface', surface: 'workspace' })
    })
  }, [dispatch])

  // ── Active session: real-time completion via the live SSE event stream ──
  // Sliced subscription (Wave 3): only the status string wakes this hook —
  // streaming text deltas no longer re-render the whole app shell above it.
  const liveStatus = useSessionEventsSelector(activeSessionId, (v) => v.status ?? '')
  useEffect(() => {
    if (!activeSessionId) {
      activeStatusPrev.current = ''
      return
    }
    const before = activeStatusPrev.current
    const now = liveStatus
    activeStatusPrev.current = now
    if (before === 'running' && (now === 'completed' || now === 'failed' || now === 'aborted')) {
      const key = `${activeSessionId}:${now}`
      if (notified.current.has(key)) return
      notified.current.add(key)
      const pref = loadNotifPref()
      if (!shouldNotify(pref)) return
      // Reuse the poll's label/error resolution so copy stays consistent: the
      // live view doesn't carry title/error, but the sessions list does.
      const meta = sessions.data?.find((s) => s.id === activeSessionId)
      const label = meta?.title ?? activeSessionId.slice(0, 8)
      notifyTerminal(activeSessionId, now as TerminalStatus, label, meta?.error, pref, isScheduledRun(meta?.title))
    }
  }, [liveStatus, activeSessionId, sessions.data])

  // ── All sessions: 2 s poll diff (backstop for non-active sessions) ──
  useEffect(() => {
    const list = sessions.data
    if (list === undefined) return

    const pref = loadNotifPref()
    if (!shouldNotify(pref)) return

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
        void notifyRouted(i18n.t('shell:notify.needsApproval'), i18n.t('shell:notify.approvalBody', { label, count: s.pendingApprovals }), s.id, pref)
      }
      if (was && was.status !== s.status) {
        if (s.status !== 'completed' && s.status !== 'failed' && s.status !== 'aborted') continue
        const key = `${s.id}:${s.status}`
        // Live SSE path already announced this transition — skip the duplicate.
        if (notified.current.has(key)) continue
        notified.current.add(key)
        notifyTerminal(s.id, s.status as TerminalStatus, label, s.error, pref, isScheduledRun(s.title))
      }
    }
    prev.current = snapshot()
  }, [sessions.data])

  // Release dedupe entries when a session leaves terminal status (starts a new
  // run), so the next completion can announce again.
  useEffect(() => {
    const list = sessions.data
    if (!list) return
    const liveIds = new Set(list.map((s) => s.id))
    for (const key of notified.current) {
      const sid = key.slice(0, key.lastIndexOf(':'))
      if (!liveIds.has(sid)) notified.current.delete(key)
    }
  }, [sessions.data])
}
