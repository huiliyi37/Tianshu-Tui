import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { notifyRouted } from '../lib/notify'
import { loadNotifPref } from '../lib/persist'
import type { JobState } from '../runtime/types'

/**
 * Fire an OS notification when a background job in the active session finishes,
 * emphasizing failures. Focus-gating is handled by notifyRouted/shouldNotify
 * (the 'background' preference only fires when the window is unfocused), which
 * approximates "用户不在该会话时". Each job id is notified at most once.
 */
export function useJobNotifications(sessionId: string | null, jobs: Record<string, JobState>): void {
  const { t } = useTranslation('jobs')
  const notified = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!sessionId) return
    for (const job of Object.values(jobs)) {
      if (job.status === 'running') continue
      if (notified.current.has(job.id)) continue
      notified.current.add(job.id)
      const failed = job.status === 'killed' || (job.exitCode != null && job.exitCode !== 0)
      const title = failed ? t('notify.failed') : t('notify.exited')
      const body = t('notify.body', { command: job.command, code: job.exitCode ?? '?' })
      // Only nag on failures by default; successful exits are low-signal.
      if (failed) void notifyRouted(title, body, sessionId, loadNotifPref())
    }
  }, [sessionId, jobs, t])
}
