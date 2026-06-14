import { useState } from 'react'
import { useCreateSchedule, useDeleteSchedule, usePauseSchedule, useSchedule } from '../state/queries'

type TriggerType = 'interval' | 'cron' | 'oneshot'

// N3 — CRUD over the CronScheduler. A due task fires through CronWiring →
// TaskRegistry → SessionRuntimePool, appearing as a visible session in 工作台.
export function ScheduleSurface() {
  const schedule = useSchedule()
  const create = useCreateSchedule()
  const pause = usePauseSchedule()
  const del = useDeleteSchedule()

  const [prompt, setPrompt] = useState('')
  const [type, setType] = useState<TriggerType>('interval')
  const [spec, setSpec] = useState('3600000')

  const submit = () => {
    if (!prompt.trim() || !spec.trim()) return
    create.mutate(
      { prompt: prompt.trim(), trigger: { type, spec: spec.trim() } },
      { onSuccess: () => setPrompt('') },
    )
  }

  const specHint =
    type === 'interval' ? '毫秒间隔，如 3600000（每小时）'
      : type === 'cron' ? '"分 时 * * *"，如 "30 9 * * *"（每天 9:30 UTC）'
        : 'ISO 时间，如 2026-07-01T09:00:00Z'

  return (
    <div className="single-pane">
      <div className="panel-header"><span>定时任务</span></div>

      <div className="schedule-form">
        <textarea
          value={prompt}
          placeholder="到点要让 agent 做什么…"
          onChange={(e) => setPrompt(e.target.value)}
        />
        <div className="row">
          <select value={type} onChange={(e) => setType(e.target.value as TriggerType)}>
            <option value="interval">间隔</option>
            <option value="cron">每日 cron</option>
            <option value="oneshot">一次性</option>
          </select>
          <input value={spec} onChange={(e) => setSpec(e.target.value)} placeholder={specHint} />
          <button className="btn" disabled={!prompt.trim() || create.isPending} onClick={submit}>
            新建
          </button>
        </div>
        <div className="meta">{specHint}</div>
        {create.isError && <div className="meta warn">{(create.error as Error).message}</div>}
      </div>

      {(schedule.data ?? []).length === 0 && <div className="empty">还没有定时任务</div>}
      {(schedule.data ?? []).map((t) => (
        <div key={t.id} className="schedule-card">
          <div className="title">{t.prompt}</div>
          <div className="meta">
            {t.trigger.type} · {t.trigger.spec} · 已触发 {t.triggerCount} 次
            {t.enabled === false ? ' · 已暂停' : ''}
          </div>
          <div className="row">
            <button className="btn ghost" onClick={() => pause.mutate({ id: t.id, enabled: t.enabled === false })}>
              {t.enabled === false ? '恢复' : '暂停'}
            </button>
            <button className="btn ghost" onClick={() => del.mutate(t.id)}>删除</button>
          </div>
        </div>
      ))}
    </div>
  )
}
