import { useEffect, useRef, useState } from 'react'
import type { SessionRecord } from '../runtime/types'
import type { ConvoBlock } from '../state/event-reducer'

const KIND_CLASS: Record<ConvoBlock['kind'], string> = {
  assistant: 'event assistant',
  tool: 'event tool',
  result: 'event tool',
  phase: 'event phase',
  error: 'event error',
}

export function Conversation(props: {
  session: SessionRecord
  blocks: ConvoBlock[]
  phase?: string
  onSend: (prompt: string) => void
  onAbort: () => void
}) {
  const { session, blocks, phase, onSend, onAbort } = props
  const [input, setInput] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
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
        <span className="meta">{busy && phase ? `▸ ${phase}` : session.cwd}</span>
      </div>
      <div className="events">
        {blocks.length === 0 && <div className="empty">发一条消息开始</div>}
        {blocks.map((b) => (
          <div key={b.key} className={`${KIND_CLASS[b.kind]}${b.isError ? ' err' : ''}`}>
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
