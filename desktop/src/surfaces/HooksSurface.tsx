import { useMemo, useState } from 'react'
import { useUiState } from '../state/store'
import { useHooks, useSetHooks } from '../state/queries'
import { useSessionEvents } from '../state/use-session-events'
import type { HookEntry, HookEvent, SessionEvent } from '../runtime/types'
import { Check, Plus, Trash2 } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'

const EVENTS: HookEvent[] = ['preTurn', 'postTurn', 'postTool', 'postSession', 'onError']

const EVENT_LABEL: Record<HookEvent, string> = {
  preTurn: '回合前',
  postTurn: '回合后',
  postTool: '工具后',
  postSession: '会话后',
  onError: '出错时',
}

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
          <div>
            <h3>Hooks</h3>
            {sessionId && (
              <div className="hooks-session">
                <span>当前线程：{sessionId.slice(0, 8)}</span>
                <span>·</span>
                <span>.rivet/hooks.json</span>
              </div>
            )}
          </div>

          {sessionId && (
            <div className="hooks-toolbar">
              <button
                className="btn ghost sm"
                onClick={addEntry}
                disabled={hooksQuery.isLoading || setHooks.isPending}
              >
                <Plus size={14} /> 添加 hook
              </button>
              <button
                className="btn primary sm"
                onClick={handleSave}
                disabled={setHooks.isPending || !changed}
              >
                {setHooks.isPending ? (
                  '保存中…'
                ) : saved ? (
                  <>
                    <Check size={14} /> 已保存
                  </>
                ) : (
                  '保存'
                )}
              </button>
            </div>
          )}
        </header>

        {!sessionId && (
          <div className="hooks-empty-state">
            请先选择一个线程以配置 Hooks。
          </div>
        )}

        {sessionId && (
          <div className="hooks-layout">
            {/* Configuration */}
            <section className="hooks-panel">
              <div className="hooks-panel-title">
                <div>
                  <h4>Hook 配置</h4>
                  <div className="hooks-panel-sub">
                    按事件触发项目根目录下的脚本
                  </div>
                </div>
              </div>

              {hooksQuery.isLoading && (
                <div className="hooks-empty-state">加载中…</div>
              )}
              {hooksQuery.isError && (
                <div className="hooks-empty-state hooks-error">加载失败</div>
              )}

              {!hooksQuery.isLoading && entries.length === 0 && (
                <div className="hooks-empty-state">
                  还没有 hook，点击右上角“添加 hook”开始配置。
                </div>
              )}

              <div className="hooks-list">
                {entries.map((entry, i) => (
                  <div key={i} className="hooks-card">
                    <div className="hooks-card-header">
                      <Select
                        value={entry.event}
                        onValueChange={(v) =>
                          updateEntry(i, { event: v as HookEvent })
                        }
                      >
                        <SelectTrigger className="w-[128px]">
                          <SelectValue placeholder="事件" />
                        </SelectTrigger>
                        <SelectContent>
                          {EVENTS.map((ev) => (
                            <SelectItem key={ev} value={ev}>
                              {EVENT_LABEL[ev]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      <Input
                        type="number"
                        placeholder="超时 ms"
                        value={entry.timeoutMs ?? ''}
                        onChange={(e) => {
                          const v = e.target.value
                          updateEntry(i, { timeoutMs: v ? Number(v) : undefined })
                        }}
                        className="w-[100px]"
                      />

                      <button
                        className="btn sm ghost danger hooks-card-delete"
                        onClick={() => removeEntry(i)}
                        title="删除"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>

                    <div className="hooks-card-body">
                      <Input
                        type="text"
                        placeholder="脚本路径（相对项目根目录）"
                        value={entry.script}
                        onChange={(e) =>
                          updateEntry(i, { script: e.target.value })
                        }
                      />
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* Recent results */}
            <section className="hooks-panel">
              <div className="hooks-panel-title">
                <div>
                  <h4>最近运行结果</h4>
                  <div className="hooks-panel-sub">最近 20 条 hook_result 事件</div>
                </div>
              </div>

              {hookEvents.length === 0 && (
                <div className="hooks-empty-state">
                  暂无 hook_result 事件
                </div>
              )}

              <div className="hooks-events">
                {hookEvents.map((e) => (
                  <div key={e.seq} className="hooks-event">
                    <div className="hooks-event-header">
                      <span className={`hooks-event-badge ${e.data.event}`}>
                        {EVENT_LABEL[e.data.event]}
                      </span>
                      <span className="hooks-event-turn">
                        turn {e.data.turn ?? '-'}
                      </span>
                      <span className="hooks-event-time">
                        {new Date(e.ts).toLocaleTimeString()}
                      </span>
                    </div>
                    <div className="hooks-event-results">
                      {e.data.results.map((r, idx) => (
                        <div key={idx} className="hooks-event-result">
                          <div className="hooks-result-head">
                            <span className="hooks-result-script">{r.script}</span>
                            <span className={`hooks-result-status ${r.ok ? 'ok' : 'err'}`}>
                              {r.ok ? '成功' : '失败'}
                            </span>
                          </div>
                          {r.output ? (
                            <pre className="hooks-result-output">{r.output}</pre>
                          ) : (
                            <pre className="hooks-result-output">{r.ok ? '完成' : '失败（无输出）'}</pre>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  )
}
