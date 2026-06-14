import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionEvent, SessionRecord } from '../runtime/types'

interface RenderBlock {
  key: string
  className: string
  role?: string
  text: string
}

// Fold the raw event stream into readable conversation blocks. Consecutive
// text_delta events coalesce into one assistant message until a non-text event
// breaks the run.
function foldEvents(events: SessionEvent[]): RenderBlock[] {
  const blocks: RenderBlock[] = []
  let textBuf = ''
  let textKey: string | null = null

  const flushText = () => {
    if (textBuf) {
      blocks.push({ key: textKey!, className: 'event assistant', role: 'assistant', text: textBuf })
      textBuf = ''
      textKey = null
    }
  }

  for (const ev of events) {
    switch (ev.type) {
      case 'text_delta':
        textBuf += String(ev.data.text ?? '')
        textKey ??= `t-${ev.seq}`
        break
      case 'tool_use':
        flushText()
        blocks.push({
          key: `tu-${ev.seq}`,
          className: 'event tool',
          role: `tool · ${String(ev.data.name ?? '')}`,
          text: JSON.stringify(ev.data.input ?? {}, null, 2),
        })
        break
      case 'tool_result':
        flushText()
        blocks.push({
          key: `tr-${ev.seq}`,
          className: `event tool ${ev.data.isError ? 'err' : ''}`,
          role: `result · ${String(ev.data.name ?? '')}`,
          text: String(ev.data.result ?? ''),
        })
        break
      case 'phase':
        flushText()
        blocks.push({ key: `p-${ev.seq}`, className: 'event phase', text: `▸ ${String(ev.data.phase ?? '')}` })
        break
      case 'error':
        flushText()
        blocks.push({ key: `e-${ev.seq}`, className: 'event error', text: `Error: ${String(ev.data.error ?? '')}` })
        break
      default:
        break
    }
  }
  flushText()
  return blocks
}

export function Conversation(props: {
  session: SessionRecord
  events: SessionEvent[]
  onSend: (prompt: string) => void
  onAbort: () => void
}) {
  const { session, events, onSend, onAbort } = props
  const [input, setInput] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const blocks = useMemo(() => foldEvents(events), [events])
  const busy = session.status === 'running'

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [blocks.length])

  const submit = () => {
    const text = input.trim()
    if (!text) return
    onSend(text)
    setInput('')
  }

  return (
    <>
      <div className="panel-header">
        <span>{session.title ?? session.id.slice(0, 8)}</span>
        <span className="meta">{session.cwd}</span>
      </div>
      <div className="events">
        {blocks.length === 0 && <div className="empty">发一条消息开始</div>}
        {blocks.map((b) => (
          <div key={b.key} className={b.className}>
            {b.role && <div className="role">{b.role}</div>}
            {b.text}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="composer">
        <textarea
          value={input}
          placeholder="和天枢对话…  (Enter 发送, Shift+Enter 换行)"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        {busy ? (
          <button className="btn ghost" onClick={onAbort}>停止</button>
        ) : (
          <button className="btn" onClick={submit} disabled={!input.trim()}>发送</button>
        )}
      </div>
    </>
  )
}
