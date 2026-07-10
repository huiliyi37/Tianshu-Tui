import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  useComputerUseStatus,
  useCreateSchedule,
  useDeleteSchedule,
  usePauseSchedule,
  useRunScheduleNow,
  useSchedule,
  useTasks,
  useCancelTask,
} from '../state/queries'
import { useUiDispatch } from '../state/store'
import {
  tasksForSchedule,
  latestStatusForSchedule,
  isCancellable,
  statusLabel,
  statusTone,
  trustStage,
  newlyGrantedApps,
  FIRST_RUNS_TRUST_THRESHOLD,
} from '../lib/automations'
import type { ReviewPolicy, ScheduledTask, TaskStatus } from '../runtime/types'

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
  const runNow = useRunScheduleNow()
  const dispatch = useUiDispatch()

  const [prompt, setPrompt] = useState('')
  const [type, setType] = useState<TriggerType>('interval')
  const [spec, setSpec] = useState('3600000')
  const [maxAttempts, setMaxAttempts] = useState('1')
  const [backoffSec, setBackoffSec] = useState('30')
  const [allowedTools, setAllowedTools] = useState('')
  const [reviewPolicy, setReviewPolicy] = useState<ReviewPolicy>('always-review')
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
        ...(reviewPolicy !== 'always-review' ? { reviewPolicy } : {}),
      },
      { onSuccess: () => { setPrompt(''); setAllowedTools(''); setReviewPolicy('always-review') } },
    )
  }

  // 无人值守（Pro）：非 always-review 或点名 computer_use。auto-proceed 只放行
  // 已授权 app（Computer Use「始终允许」），未授权动作 fail-closed 中止。
  const wantsUnattended = reviewPolicy !== 'always-review'
    || allowedTools.split(',').map((s) => s.trim()).includes('computer_use')

  // 授权可见（试跑驱动信任 · Phase 1）：表单选了无人值守策略、或已有任务带
  // 无人值守意图时启用轮询——试跑中「始终允许」新增的授权自动出现在清单里。
  const anyUnattendedTask = definitions.some((d) =>
    (d.reviewPolicy !== undefined && d.reviewPolicy !== 'always-review') || d.allowedTools.includes('computer_use'))
  const cuStatus = useComputerUseStatus(wantsUnattended || anyUnattendedTask)
  const grantedApps = useMemo(() => (cuStatus.data?.grants ?? []).map((g) => g.app), [cuStatus.data])

  // 试跑后新增授权 toast（Phase 2）：diff 授权清单前后状态。
  const prevGrantsRef = useRef<string[] | null>(null)
  useEffect(() => {
    if (!cuStatus.data) return
    const prev = prevGrantsRef.current
    prevGrantsRef.current = grantedApps
    if (prev === null) return
    const added = newlyGrantedApps(prev, grantedApps)
    if (added.length > 0) toast.success(t('grants.newGrants', { apps: added.join(', ') }))
  }, [grantedApps, cuStatus.data, t])

  const trialRun = (id: string) => {
    runNow.mutate(id, {
      onSuccess: () => {
        setSelectedId(id)
        toast.success(t('schedule.trialStarted'))
      },
      onError: (err) => toast.error((err as Error).message),
    })
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
            <label className="meta" style={{ minWidth: 64 }}>{t('form.reviewPolicy')}</label>
            <select value={reviewPolicy} onChange={(e) => setReviewPolicy(e.target.value as ReviewPolicy)}>
              <option value="always-review">{t('form.policyAlways')}</option>
              <option value="first-runs">{t('form.policyFirstRuns')}</option>
              <option value="auto-proceed">{t('form.policyAutoProceed')}</option>
            </select>
          </div>
          <div className="row">
            <input value={allowedTools} onChange={(e) => setAllowedTools(e.target.value)} placeholder={t('form.allowedToolsPlaceholder')} />
            <button className="btn" disabled={!prompt.trim() || create.isPending} onClick={submit}>{t('form.create')}</button>
          </div>
          <div className="meta">{specHint} · {t('form.retryHint')}</div>
          {wantsUnattended && <div className="meta">{t('form.unattendedHint')}</div>}
          {wantsUnattended && cuStatus.data && (
            grantedApps.length > 0 ? (
              <div className="meta">{t('grants.listLabel', { apps: grantedApps.join(', ') })}</div>
            ) : (
              <div className="meta">
                {t('grants.empty')}{' '}
                <button
                  className="btn ghost sm"
                  onClick={() => dispatch({ type: 'setSurface', surface: 'settings' })}
                >
                  {t('grants.goSettings')}
                </button>
              </div>
            )
          )}
          {create.isError && (
            <div className="meta warn">
              {/pro_required/.test((create.error as Error).message) ? t('form.proRequired') : (create.error as Error).message}
            </div>
          )}
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
              onRunNow={() => trialRun(t.id)}
              runNowPending={runNow.isPending}
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
                {/* 中止修复闭环（Phase 3）：缺授权 app 结构化展示，替代原始错误文本 */}
                {run.haltedApp ? (
                  <div className="meta warn" title={run.error}>{t('history.haltMissingApp', { app: run.haltedApp })}</div>
                ) : (
                  run.error && <div className="meta warn" title={run.error}>{run.error.slice(0, 160)}</div>
                )}
                {run.result?.summary && <div className="meta">{run.result.summary.slice(0, 160)}</div>}
                <div className="row">
                  {run.sessionId && (
                    <button className="btn ghost" onClick={() => jumpToSession(run.sessionId!)}>{t('history.viewSession')}</button>
                  )}
                  {isCancellable(run.status) && (
                    <button className="btn ghost" disabled={cancel.isPending} onClick={() => cancel.mutate(run.id)}>{t('history.cancel')}</button>
                  )}
                  {run.haltedApp && (
                    <>
                      <button
                        className="btn ghost"
                        title={t('history.grantHint', { app: run.haltedApp })}
                        onClick={() => dispatch({ type: 'setSurface', surface: 'settings' })}
                      >
                        {t('history.goGrant')}
                      </button>
                      {run.scheduledTaskId && (
                        <button
                          className="btn ghost"
                          disabled={runNow.isPending}
                          title={t('history.rerunHint')}
                          onClick={() => trialRun(run.scheduledTaskId!)}
                        >
                          {t('history.rerun')}
                        </button>
                      )}
                    </>
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
  onRunNow,
  runNowPending,
}: {
  task: ScheduledTask
  selected: boolean
  latest: TaskStatus | null
  onSelect: () => void
  onPause: () => void
  onDelete: () => void
  onRunNow: () => void
  runNowPending: boolean
}) {
  const { t } = useTranslation('automations')
  // 信任徽章（试跑驱动信任 · Phase 2）：未试跑 / 已试跑 N 次 / 可无人值守。
  const stage = trustStage(task)
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
        {task.reviewPolicy && task.reviewPolicy !== 'always-review' ? ` · ${t(`schedule.policy.${task.reviewPolicy}`)}` : ''}
        {task.enabled === false ? ` · ${t('schedule.paused')}` : ''}
      </div>
      {stage && (
        <div className="meta">
          <span className={`mcp-status-badge ${stage === 'trusted' || stage === 'unattended' ? 'green' : 'yellow'}`}>
            <span className="label">
              {t(`schedule.trust.${stage}`, { n: task.triggerCount, total: FIRST_RUNS_TRUST_THRESHOLD })}
            </span>
          </span>
          {stage === 'trusted' && <span> {t('schedule.trust.trustedHint')}</span>}
        </div>
      )}
      {latest && <div className="meta">{t('schedule.latest')}<StatusBadge status={latest} /></div>}
      <div className="row">
        <button
          className="btn ghost"
          disabled={runNowPending || task.enabled === false}
          title={t('schedule.runNowHint')}
          onClick={(e) => { e.stopPropagation(); onRunNow() }}
        >
          {t('schedule.runNow')}
        </button>
        <button className="btn ghost" onClick={(e) => { e.stopPropagation(); onPause() }}>
          {task.enabled === false ? t('schedule.resume') : t('schedule.pause')}
        </button>
        <button className="btn ghost" onClick={(e) => { e.stopPropagation(); onDelete() }}>{t('schedule.delete')}</button>
      </div>
    </div>
  )
}
