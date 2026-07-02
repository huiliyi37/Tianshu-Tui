import { useMemo, useState } from 'react'
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
    type === 'interval' ? '毫秒间隔，如 3600000（每小时）'
      : type === 'cron' ? '"分 时 * * *"，如 "30 9 * * *"（每天 9:30 UTC）'
        : 'ISO 时间，如 2026-07-01T09:00:00Z'

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
        <div className="panel-header"><span>自动化</span></div>

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
          </div>
          <div className="row">
            <label className="meta" style={{ minWidth: 64 }}>最大尝试</label>
            <input type="number" min={1} max={10} value={maxAttempts} onChange={(e) => setMaxAttempts(e.target.value)} style={{ width: 64 }} />
            <label className="meta" style={{ minWidth: 64 }}>重试间隔(秒)</label>
            <input type="number" min={0} value={backoffSec} onChange={(e) => setBackoffSec(e.target.value)} style={{ width: 72 }} />
          </div>
          <div className="row">
            <input value={allowedTools} onChange={(e) => setAllowedTools(e.target.value)} placeholder="允许的工具(逗号分隔，留空=全部)" />
            <button className="btn" disabled={!prompt.trim() || create.isPending} onClick={submit}>新建</button>
          </div>
          <div className="meta">{specHint} · 尝试次数 ≥ 2 时启用失败重试</div>
          {create.isError && <div className="meta warn">{(create.error as Error).message}</div>}
        </div>

        <div className="automations-def-list" style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
          {definitions.length === 0 && <div className="empty">还没有自动化任务</div>}
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
        <div className="panel-header"><span>执行历史{selected ? ` · ${history.length}` : ''}</span></div>
        {!selected ? (
          <div className="empty">选择左侧一个自动化查看执行历史</div>
        ) : history.length === 0 ? (
          <div className="empty">尚无执行记录</div>
        ) : (
          <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
            {history.map((run) => (
              <div key={run.id} className="schedule-card">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <StatusBadge status={run.status} />
                  <span className="meta">
                    {run.attempt && run.attempt > 1 ? `第 ${run.attempt} 次 · ` : ''}
                    {new Date(run.createdAt).toLocaleString()}
                  </span>
                </div>
                {run.error && <div className="meta warn" title={run.error}>{run.error.slice(0, 160)}</div>}
                {run.result?.summary && <div className="meta">{run.result.summary.slice(0, 160)}</div>}
                <div className="row">
                  {run.sessionId && (
                    <button className="btn ghost" onClick={() => jumpToSession(run.sessionId!)}>查看会话</button>
                  )}
                  {isCancellable(run.status) && (
                    <button className="btn ghost" disabled={cancel.isPending} onClick={() => cancel.mutate(run.id)}>取消</button>
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
  return (
    <div
      className="schedule-card"
      onClick={onSelect}
      style={{ cursor: 'pointer', outline: selected ? '1px solid var(--accent)' : undefined }}
    >
      <div className="title">{task.prompt}</div>
      <div className="meta">
        {task.trigger.type} · {task.trigger.spec} · 已触发 {task.triggerCount} 次
        {task.retry ? ` · 重试×${task.retry.maxAttempts}` : ''}
        {task.enabled === false ? ' · 已暂停' : ''}
      </div>
      {latest && <div className="meta">最近：<StatusBadge status={latest} /></div>}
      <div className="row">
        <button className="btn ghost" onClick={(e) => { e.stopPropagation(); onPause() }}>
          {task.enabled === false ? '恢复' : '暂停'}
        </button>
        <button className="btn ghost" onClick={(e) => { e.stopPropagation(); onDelete() }}>删除</button>
      </div>
    </div>
  )
}
