import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  useCreateSchedule,
  useDeleteSchedule,
  usePauseSchedule,
  useSchedule,
  useTasks,
  useCancelTask,
} from '../state/queries'
import { useUiDispatch } from '../state/store'
import { tasksForSchedule, latestStatusForSchedule, isCancellable, statusLabel, statusTone } from '../lib/automations'
import type { ScheduledTask, TaskStatus } from '../runtime/types'

type TriggerType = 'interval' | 'cron' | 'oneshot'

// Automations (P3). Two-pane dashboard: left = definitions + create form
// (trigger + bounded retry + allowed tools); right = execution history for the
// selected automation (status badges, jump-to-thread, cancel running).
export function AutomationsSurface() {
  const { t } = useTranslation('automations')
  const schedule = useSchedule()
  const tasks = useTasks()
  const create = useCreateSchedule()
  const pause = usePauseSchedule()
  const del = useDeleteSchedule()
  const cancel = useCancelTask()
  const dispatch = useUiDispatch()

  const [prompt, setPrompt] = useState('')
  const [type, setType] = useState<TriggerType>('interval')
  const [spec, setSpec] = useState('3600000')
  const [maxAttempts, setMaxAttempts] = useState('1')
  const [backoffSec, setBackoffSec] = useState('30')
  const [allowedTools, setAllowedTools] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const definitions = schedule.data ?? []
  const allTasks = tasks.data ?? []

  const submit = () => {
    if (!prompt.trim() || !spec.trim()) return
    const attempts = parseInt(maxAttempts, 10)
    const backoffMs = Math.max(0, Math.round(parseFloat(backoffSec) || 0) * 1000)
    const tools = allowedTools.split(',').map((s) => s.trim()).filter(Boolean)
    create.mutate(
      {
        prompt: prompt.trim(),
        trigger: { type, spec: spec.trim() },
        ...(tools.length > 0 ? { allowedTools: tools } : {}),
        ...(attempts >= 2 ? { retry: { maxAttempts: attempts, backoffMs } } : {}),
      },
      { onSuccess: () => { setPrompt(''); setAllowedTools('') } },
    )
  }

  const specHint =
    type === 'interval' ? t('form.specHint.interval')
      : type === 'cron' ? t('form.specHint.cron')
        : t('form.specHint.oneshot')

  const selected = definitions.find((d) => d.id === selectedId) ?? null
  const history = useMemo(
    () => (selected ? tasksForSchedule(allTasks, selected.id) : []),
    [selected, allTasks],
  )

  const jumpToSession = (sessionId: string) => {
    dispatch({ type: 'setActive', id: sessionId })
    dispatch({ type: 'setSurface', surface: 'workspace' })
  }

  return (
    <div className="automations-dashboard" style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      {/* Left: definitions + create form */}
      <div className="automations-left" style={{ flex: '0 0 46%', display: 'flex', flexDirection: 'column', minHeight: 0, borderRight: '1px solid var(--border)' }}>
        <div className="panel-header"><span>{t('title')}</span></div>

        <div className="schedule-form">
          <textarea
            value={prompt}
            placeholder={t('form.promptPlaceholder')}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <div className="row">
            <select value={type} onChange={(e) => setType(e.target.value as TriggerType)}>
              <option value="interval">{t('form.triggerInterval')}</option>
              <option value="cron">{t('form.triggerCron')}</option>
              <option value="oneshot">{t('form.triggerOneshot')}</option>
            </select>
            <input value={spec} onChange={(e) => setSpec(e.target.value)} placeholder={specHint} />
          </div>
          <div className="row">
            <label className="meta" style={{ minWidth: 64 }}>{t('form.maxAttempts')}</label>
            <input type="number" min={1} max={10} value={maxAttempts} onChange={(e) => setMaxAttempts(e.target.value)} style={{ width: 64 }} />
            <label className="meta" style={{ minWidth: 64 }}>{t('form.backoffSec')}</label>
            <input type="number" min={0} value={backoffSec} onChange={(e) => setBackoffSec(e.target.value)} style={{ width: 72 }} />
          </div>
          <div className="row">
            <input value={allowedTools} onChange={(e) => setAllowedTools(e.target.value)} placeholder={t('form.allowedToolsPlaceholder')} />
            <button className="btn" disabled={!prompt.trim() || create.isPending} onClick={submit}>{t('form.create')}</button>
          </div>
          <div className="meta">{specHint} · {t('form.retryHint')}</div>
          {create.isError && <div className="meta warn">{(create.error as Error).message}</div>}
        </div>

        <div className="automations-def-list" style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
          {definitions.length === 0 && <div className="empty">{t('list.empty')}</div>}
          {definitions.map((t) => (
            <ScheduleCard
              key={t.id}
              task={t}
              selected={t.id === selectedId}
              latest={latestStatusForSchedule(allTasks, t.id)}
              onSelect={() => setSelectedId(t.id)}
              onPause={() => pause.mutate({ id: t.id, enabled: t.enabled === false })}
              onDelete={() => { del.mutate(t.id); if (selectedId === t.id) setSelectedId(null) }}
            />
          ))}
        </div>
      </div>

      {/* Right: execution history for the selected automation */}
      <div className="automations-right" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div className="panel-header"><span>{t('history.title')}{selected ? ` · ${history.length}` : ''}</span></div>
        {!selected ? (
          <div className="empty">{t('history.selectHint')}</div>
        ) : history.length === 0 ? (
          <div className="empty">{t('history.empty')}</div>
        ) : (
          <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
            {history.map((run) => (
              <div key={run.id} className="schedule-card">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <StatusBadge status={run.status} />
                  <span className="meta">
                    {run.attempt && run.attempt > 1 ? `${t('history.attempt', { n: run.attempt })} · ` : ''}
                    {new Date(run.createdAt).toLocaleString()}
                  </span>
                </div>
                {run.error && <div className="meta warn" title={run.error}>{run.error.slice(0, 160)}</div>}
                {run.result?.summary && <div className="meta">{run.result.summary.slice(0, 160)}</div>}
                <div className="row">
                  {run.sessionId && (
                    <button className="btn ghost" onClick={() => jumpToSession(run.sessionId!)}>{t('history.viewSession')}</button>
                  )}
                  {isCancellable(run.status) && (
                    <button className="btn ghost" disabled={cancel.isPending} onClick={() => cancel.mutate(run.id)}>{t('history.cancel')}</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className={`mcp-status-badge ${statusTone(status)}`}>
      <span className="label">{statusLabel(status)}</span>
    </span>
  )
}

function ScheduleCard({
  task,
  selected,
  latest,
  onSelect,
  onPause,
  onDelete,
}: {
  task: ScheduledTask
  selected: boolean
  latest: TaskStatus | null
  onSelect: () => void
  onPause: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation('automations')
  return (
    <div
      className="schedule-card"
      onClick={onSelect}
      style={{ cursor: 'pointer', outline: selected ? '1px solid var(--accent)' : undefined }}
    >
      <div className="title">{task.prompt}</div>
      <div className="meta">
        {task.trigger.type} · {task.trigger.spec} · {t('schedule.triggerCount', { n: task.triggerCount })}
        {task.retry ? ` · ${t('schedule.retryTimes', { n: task.retry.maxAttempts })}` : ''}
        {task.enabled === false ? ` · ${t('schedule.paused')}` : ''}
      </div>
      {latest && <div className="meta">{t('schedule.latest')}<StatusBadge status={latest} /></div>}
      <div className="row">
        <button className="btn ghost" onClick={(e) => { e.stopPropagation(); onPause() }}>
          {task.enabled === false ? t('schedule.resume') : t('schedule.pause')}
        </button>
        <button className="btn ghost" onClick={(e) => { e.stopPropagation(); onDelete() }}>{t('schedule.delete')}</button>
      </div>
    </div>
  )
}
