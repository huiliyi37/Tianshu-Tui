import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation('hooks')
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
                <span>{t('currentThread', { id: sessionId.slice(0, 8) })}</span>
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
                <Plus size={14} /> {t('addHook')}
              </button>
              <button
                className="btn primary sm"
                onClick={handleSave}
                disabled={setHooks.isPending || !changed}
              >
                {setHooks.isPending ? (
                  t('saving')
                ) : saved ? (
                  <>
                    <Check size={14} /> {t('saved')}
                  </>
                ) : (
                  t('save')
                )}
              </button>
            </div>
          )}
        </header>

        {!sessionId && (
          <div className="hooks-empty-state">
            {t('selectSessionHint')}
          </div>
        )}

        {sessionId && (
          <div className="hooks-layout">
            {/* Configuration */}
            <section className="hooks-panel">
              <div className="hooks-panel-title">
                <div>
                  <h4>{t('config.title')}</h4>
                  <div className="hooks-panel-sub">
                    {t('config.subtitle')}
                  </div>
                </div>
              </div>

              {hooksQuery.isLoading && (
                <div className="hooks-empty-state">{t('config.loading')}</div>
              )}
              {hooksQuery.isError && (
                <div className="hooks-empty-state hooks-error">{t('config.loadFailed')}</div>
              )}

              {!hooksQuery.isLoading && entries.length === 0 && (
                <div className="hooks-empty-state">
                  {t('config.empty')}
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
                          <SelectValue placeholder={t('config.eventPlaceholder')} />
                        </SelectTrigger>
                        <SelectContent>
                          {EVENTS.map((ev) => (
                            <SelectItem key={ev} value={ev}>
                              {t(`event.${ev}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      <Input
                        type="number"
                        placeholder={t('config.timeoutPlaceholder')}
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
                        title={t('config.delete')}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>

                    <div className="hooks-card-body">
                      <Input
                        type="text"
                        placeholder={t('config.scriptPlaceholder')}
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
                  <h4>{t('results.title')}</h4>
                  <div className="hooks-panel-sub">{t('results.subtitle')}</div>
                </div>
              </div>

              {hookEvents.length === 0 && (
                <div className="hooks-empty-state">
                  {t('results.empty')}
                </div>
              )}

              <div className="hooks-events">
                {hookEvents.map((e) => (
                  <div key={e.seq} className="hooks-event">
                    <div className="hooks-event-header">
                      <span className={`hooks-event-badge ${e.data.event}`}>
                        {t(`event.${e.data.event}`)}
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
                              {r.ok ? t('results.ok') : t('results.err')}
                            </span>
                          </div>
                          {r.output ? (
                            <pre className="hooks-result-output">{r.output}</pre>
                          ) : (
                            <pre className="hooks-result-output">{r.ok ? t('results.done') : t('results.failedNoOutput')}</pre>
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
