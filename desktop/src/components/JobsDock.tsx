import { memo, useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, Square, Terminal, FileText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { JobState } from '../runtime/types'
import { getJobLogs, killJob } from '../runtime/client'

// 底部常驻后台任务停靠条（对齐 TodoDock 的常驻/折叠交互）。数据源为 SSE 的
// `job` 事件在 event-reducer 里聚合的 view.jobs。列出运行中/近期任务的状态、
// 实时 elapsed、最后一行输出，可展开日志、Kill、在终端打开。
//
// memo 包裹：ReviewPanel/WorkspaceSurface 在流式帧里频繁重渲染，jobsRev 只在
// job 事件时递增 → 引用变化时才重渲染。

function fmtElapsed(job: JobState, now: number): string {
  const end = job.status === 'running' ? now : (job.endedAt ?? now)
  const s = Math.max(0, Math.round((end - job.startedAt) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r ? `${m}m${r}s` : `${m}m`
}

export const JobsDock = memo(function JobsDock({
  sessionId,
  jobs,
  visible,
  onToggle,
  onOpenTerminal,
  onClose,
}: {
  sessionId: string
  jobs: JobState[]
  /** dock 展开/折叠（持久化于 store.jobsDockVisible）。 */
  visible: boolean
  onToggle: () => void
  /** 在终端打开任务的 cwd（复用 TerminalTabs）。 */
  onOpenTerminal?: () => void
  onClose: () => void
}) {
  const { t } = useTranslation('jobs')
  const [now, setNow] = useState(() => Date.now())
  const [expanded, setExpanded] = useState<string | null>(null)
  const [logs, setLogs] = useState<{ id: string; text: string; loading: boolean; error: boolean } | null>(null)

  const running = jobs.filter((j) => j.status === 'running')

  // Live elapsed ticker — only while something is running (avoid idle timers).
  useEffect(() => {
    if (running.length === 0) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running.length])

  // Refresh open logs on new job activity for the expanded job.
  useEffect(() => {
    if (!expanded) return
    let cancelled = false
    setLogs((prev) => (prev?.id === expanded ? prev : { id: expanded, text: '', loading: true, error: false }))
    getJobLogs(sessionId, expanded)
      .then((text) => { if (!cancelled) setLogs({ id: expanded, text, loading: false, error: false }) })
      .catch(() => { if (!cancelled) setLogs({ id: expanded, text: '', loading: false, error: true }) })
    return () => { cancelled = true }
    // Re-fetch when the expanded job's snapshot changes (lastLine/status updates).
  }, [expanded, sessionId, jobs])

  if (jobs.length === 0) return null

  const toggleExpand = (id: string) => {
    setExpanded((cur) => (cur === id ? null : id))
  }

  const onKill = async (id: string) => {
    try { await killJob(sessionId, id) } catch { /* surfaced via next job event */ }
  }

  return (
    <div className={`jobs-dock ${visible ? 'open' : ''}`}>
      <div className="jobs-dock-head">
        <button className="jobs-dock-toggle" onClick={onToggle} title={visible ? t('collapse') : t('expand')}>
          {visible ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
          <span className="jdh-title">{t('title')}</span>
          <span className="jdh-count">{running.length > 0 ? `${running.length} ${t('running')}` : jobs.length}</span>
        </button>
        {!visible && running[0] && (
          <span className="jdh-current" title={running[0].command}>▶ {running[0].command}</span>
        )}
        <button
          className="jobs-dock-close"
          onClick={onClose}
          title="彻底隐藏"
          aria-label="彻底隐藏"
        >
          ✕
        </button>
      </div>

      {visible && (
        <ul className="jobs-dock-list">
          {jobs.map((job) => {
            const isOpen = expanded === job.id
            return (
              <li key={job.id} className={`job-item js-${job.status}`}>
                <div className="job-row">
                  <span className={`job-status-pill js-${job.status}`}>
                    {job.status === 'running'
                      ? t('status.running')
                      : job.status === 'killed'
                        ? t('status.killed')
                        : t('exitCode', { code: job.exitCode ?? '?' })}
                  </span>
                  <span className="job-elapsed">{fmtElapsed(job, now)}</span>
                  <button className="job-cmd" onClick={() => toggleExpand(job.id)} title={job.command}>
                    {job.command}
                  </button>
                  <span className="job-lastline" title={job.lastLine}>{job.lastLine}</span>
                  <span className="job-actions">
                    <button className="job-act" onClick={() => toggleExpand(job.id)} title={isOpen ? t('hideLogs') : t('viewLogs')}>
                      <FileText size={12} />
                    </button>
                    {onOpenTerminal && (
                      <button className="job-act" onClick={onOpenTerminal} title={t('openTerminal')}>
                        <Terminal size={12} />
                      </button>
                    )}
                    {job.status === 'running' && (
                      <button className="job-act job-kill" onClick={() => onKill(job.id)} title={t('kill')}>
                        <Square size={11} />
                      </button>
                    )}
                  </span>
                </div>
                {isOpen && (
                  <pre className="job-logs">
                    {logs?.id === job.id
                      ? (logs.loading
                          ? t('logsLoading')
                          : logs.error
                            ? t('logsError')
                            : (logs.text || t('logsEmpty')))
                      : t('logsLoading')}
                  </pre>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
})
