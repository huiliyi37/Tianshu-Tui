import { useMemo, useState } from 'react'
import { useUiState } from '../state/store'
import { useHooks, useSetHooks } from '../state/queries'
import { useSessionEvents } from '../state/use-session-events'
import type { HookEntry, HookEvent, SessionEvent } from '../runtime/types'
import { Check, Plus, Trash2 } from 'lucide-react'

const EVENTS: HookEvent[] = ['preTurn', 'postTurn', 'postTool', 'postSession', 'onError']

interface HookResultEventData {
  event: HookEvent
  turn?: number
  toolName?: string
  error?: string
  results: { script: string; ok: boolean; output: string }[]
}

function isHookResultEvent(e: SessionEvent): e is SessionEvent & { data: HookResultEventData } {
  const d = e.data as unknown as HookResultEventData
  return e.type === 'hook_result' && Array.isArray(d.results)
}

export function HooksSurface() {
  const ui = useUiState()
  const sessionId = ui.activeSessionId
  const hooksQuery = useHooks(sessionId)
  const setHooks = useSetHooks()
  const [draft, setDraft] = useState<HookEntry[] | null>(null)
  const [saved, setSaved] = useState(false)
  const eventState = useSessionEvents(sessionId)

  const entries = draft ?? hooksQuery.data?.hooks ?? []

  const hookEvents = useMemo(() => {
    return eventState.hookResults.filter(isHookResultEvent).slice(-20).reverse()
  }, [eventState.hookResults])

  const changed = JSON.stringify(draft) !== JSON.stringify(hooksQuery.data?.hooks ?? [])

  const updateEntry = (index: number, patch: Partial<HookEntry>) => {
    setDraft((prev) => {
      const next = [...(prev ?? hooksQuery.data?.hooks ?? [])]
      next[index] = { ...next[index]!, ...patch }
      return next
    })
  }

  const addEntry = () => {
    setDraft((prev) => [
      ...(prev ?? hooksQuery.data?.hooks ?? []),
      { event: 'postTool', script: '' },
    ])
  }

  const removeEntry = (index: number) => {
    setDraft((prev) => {
      const next = [...(prev ?? hooksQuery.data?.hooks ?? [])]
      next.splice(index, 1)
      return next
    })
  }

  const handleSave = () => {
    if (!sessionId) return
    setSaved(false)
    setHooks.mutate(
      { id: sessionId, hooks: entries.filter((h) => h.script.trim()) },
      {
        onSuccess: () => {
          setDraft(null)
          setSaved(true)
          setTimeout(() => setSaved(false), 1500)
        },
      },
    )
  }

  return (
    <div className="surface-scroll">
      <div className="hooks-surface">
        <header className="hooks-header">
          <h3>Hooks</h3>
          {sessionId && (
            <span className="meta">
              当前线程：{ui.activeSessionId?.slice(0, 8)}
            </span>
          )}
        </header>

        {!sessionId && <div className="empty">请先选择一个线程。</div>}

        {sessionId && (
          <>
            <section className="hooks-section">
              <div className="hooks-section-title">
                <h4>.rivet/hooks.json</h4>
                <button
                  className="btn primary small"
                  onClick={handleSave}
                  disabled={setHooks.isPending || !changed}
                >
                  {setHooks.isPending ? '保存中…' : saved ? <><Check size={14} /> 已保存</> : '保存'}
                </button>
              </div>
              {hooksQuery.isLoading && <div className="surface-loading">加载中…</div>}
              {hooksQuery.isError && <div className="meta warn">加载失败</div>}
              <div className="hooks-list">
                {entries.map((entry, i) => (
                  <div key={i} className="hooks-row">
                    <select
                      value={entry.event}
                      onChange={(e) => updateEntry(i, { event: e.target.value as HookEvent })}
                    >
                      {EVENTS.map((ev) => (
                        <option key={ev} value={ev}>{ev}</option>
                      ))}
                    </select>
                    <input
                      type="text"
                      placeholder="脚本路径（相对项目根目录）"
                      value={entry.script}
                      onChange={(e) => updateEntry(i, { script: e.target.value })}
                    />
                    <input
                      type="number"
                      placeholder="超时 ms"
                      value={entry.timeoutMs ?? ''}
                      onChange={(e) => {
                        const v = e.target.value
                        updateEntry(i, { timeoutMs: v ? Number(v) : undefined })
                      }}
                      className="hooks-timeout"
                    />
                    <button
                      className="btn ghost danger"
                      onClick={() => removeEntry(i)}
                      title="删除"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <button className="btn secondary small" onClick={addEntry}>
                <Plus size={14} /> 添加 hook
              </button>
            </section>

            <section className="hooks-section">
              <h4>最近运行结果</h4>
              {hookEvents.length === 0 && <div className="meta">暂无 hook_result 事件</div>}
              <div className="hooks-events">
                {hookEvents.map((e) => (
                  <div key={e.seq} className="hook-event">
                    <div className="hook-event-meta">
                      <span className="badge">{e.data.event}</span>
                      <span className="meta">turn {e.data.turn ?? '-'}</span>
                    </div>
                    <div className="hook-event-results">
                      {e.data.results.map((r, idx) => (
                        <div key={idx} className={`hook-result ${r.ok ? 'ok' : 'err'}`}>
                          <span className="hook-result-script">{r.script}</span>
                          <span className="hook-result-output">{r.output || (r.ok ? 'ok' : 'failed')}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  )
}
