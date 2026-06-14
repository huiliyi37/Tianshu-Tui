import { useCallback, useEffect, useRef, useState } from 'react'
import {
  abortSession,
  answerApproval,
  createSession,
  listSessions,
  pollEvents,
  sendPrompt,
} from './runtime/client'
import type { ApprovalRequest, SessionEvent, SessionRecord } from './runtime/types'
import { SessionList } from './components/SessionList'
import { Conversation } from './components/Conversation'
import { ArtifactsPanel } from './components/ArtifactsPanel'
import { ApprovalModal } from './components/ApprovalModal'
import { NewSessionDialog } from './components/NewSessionDialog'

export function App() {
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [events, setEvents] = useState<SessionEvent[]>([])
  const [pending, setPending] = useState<ApprovalRequest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const stopRef = useRef<(() => void) | null>(null)

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await listSessions())
    } catch (e) {
      setError(`无法连接 rivet runtime：${(e as Error).message}`)
    }
  }, [])

  useEffect(() => {
    void refreshSessions()
    const t = setInterval(refreshSessions, 2000)
    return () => clearInterval(t)
  }, [refreshSessions])

  // Subscribe to the active session's event stream (poll + since backfill).
  useEffect(() => {
    stopRef.current?.()
    setEvents([])
    setPending(null)
    if (!activeId) return
    const id = activeId
    stopRef.current = pollEvents(id, (batch) => {
      setEvents((prev) => [...prev, ...batch])
      for (const ev of batch) {
        if (ev.type === 'approval_required') {
          setPending(ev.data as unknown as ApprovalRequest)
        } else if (ev.type === 'approval_resolved') {
          setPending((p) => (p && p.requestId === ev.data.requestId ? null : p))
        }
      }
    })
    return () => stopRef.current?.()
  }, [activeId])

  const handleNewSession = useCallback(async (input: { cwd?: string; title?: string; prompt?: string }) => {
    try {
      const rec = await createSession(input)
      await refreshSessions()
      setActiveId(rec.id)
      setShowNew(false)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [refreshSessions])

  const handleSend = useCallback(async (prompt: string) => {
    if (!activeId) return
    try {
      await sendPrompt(activeId, prompt)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [activeId])

  const handleAbort = useCallback(async () => {
    if (!activeId) return
    await abortSession(activeId)
  }, [activeId])

  const handleApproval = useCallback(async (decision: 'approve' | 'reject') => {
    if (!activeId || !pending) return
    await answerApproval(activeId, pending.requestId, decision)
    setPending(null)
  }, [activeId, pending])

  const active = sessions.find((s) => s.id === activeId) ?? null

  return (
    <div className="app">
      <SessionList
        sessions={sessions}
        activeId={activeId}
        onSelect={setActiveId}
        onNew={() => setShowNew(true)}
      />

      <div className="conversation">
        {error && <div className="banner error">{error}</div>}
        {active ? (
          <Conversation
            session={active}
            events={events}
            onSend={handleSend}
            onAbort={handleAbort}
          />
        ) : (
          <div className="empty">
            打开就是「和 agent 对话」。左侧新建会话，或选择一个正在跑的 agent。
          </div>
        )}
      </div>

      <ArtifactsPanel sessionId={activeId} events={events} />

      {pending && (
        <ApprovalModal request={pending} onDecision={handleApproval} />
      )}

      {showNew && (
        <NewSessionDialog onCreate={handleNewSession} onClose={() => setShowNew(false)} />
      )}
    </div>
  )
}
