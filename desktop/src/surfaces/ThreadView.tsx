import { useEffect, useRef, useState } from 'react'
import type { SessionRecord } from '../runtime/types'
import type { ConvoBlock, EventViewState } from '../state/event-reducer'
import { basename } from '../lib/projects'
import { ToolBlock } from '../components/ToolBlock'
import { DelegationTree } from '../components/DelegationTree'

const STATUS_LABEL: Record<string, string> = {
  idle: '空闲',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  aborted: '已中止',
}

// Thread view (P2/Q1) — the single-session working surface. Status header (with a
// reserved slot for a future CVM domain glyph) + Codex-style message stream
// (collapsible tools, streaming indicator, server-persisted user turns) + composer.
export function ThreadView(props: {
  session: SessionRecord
  view: EventViewState
  onSend: (prompt: string) => void
  onAbort: () => void
}) {
  const { session, view, onSend, onAbort } = props
  const [input, setInput] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const busy = session.status === 'running'

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [view.blocks.length])

  const submit = () => {
    const text = input.trim()
    if (!text) return
    // The user turn is echoed back as a 'user' event (server run()), so we don't
    // render optimistically — the SSE round-trip is sub-ms on localhost.
    onSend(text)
    setInput('')
  }

  const showThinking = busy && !view.private_textOpen

  return (
    <div className="thread">
      <header className="thread-header">
        <span className="thread-glyph" aria-hidden />
        <div className="thread-id">
          <div className="thread-title">{session.title ?? session.id.slice(0, 8)}</div>
          <div className="thread-sub" title={session.cwd}>{basename(session.cwd) || session.cwd}</div>
        </div>
        <div className="thread-status">
          <span className={`status-dot status-${session.status}`} />
          <span className="status-text">{STATUS_LABEL[session.status] ?? session.status}</span>
          {busy && view.phase && <span className="phase-chip">{view.phase}</span>}
        </div>
      </header>

      <div className="messages">
        {view.blocks.length === 0 && <div className="empty sm">发一条消息开始</div>}
        {view.blocks.map((b) => <Block key={b.key} block={b} />)}
        {showThinking && (
          <div className="thinking">
            <span className="dot-pulse" /><span className="dot-pulse" /><span className="dot-pulse" />
            <span className="thinking-label">{view.phase ? `思考中 · ${view.phase}` : '思考中…'}</span>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <DelegationTree nodes={view.delegation} />

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
    </div>
  )
}

function Block({ block }: { block: ConvoBlock }) {
  if (block.kind === 'user') {
    return (
      <div className="msg user">
        <div className="msg-role">你</div>
        <div className="msg-body">{block.text}</div>
      </div>
    )
  }
  if (block.kind === 'tool' || block.kind === 'result') {
    return <ToolBlock title={block.role ?? block.kind} body={block.text} isError={block.isError} />
  }
  if (block.kind === 'phase') {
    return <div className="msg phase">{block.text}</div>
  }
  if (block.kind === 'error') {
    return <div className="msg error">{block.text}</div>
  }
  if (block.kind === 'decision_shift' && block.shift) {
    const s = block.shift
    return (
      <div className={`decision-shift ${s.severity}`}>
        <div className="ds-head">
          <span className="ds-glyph" aria-hidden>✦</span>
          <span className="ds-domain">{s.domain ? `星域 · ${s.domain}` : '星域 · 改道'}</span>
          <span className="ds-tag">提醒 → 改道</span>
        </div>
        <div className="ds-reason">{s.reason}</div>
        {s.methods.length > 0 && (
          <ul className="ds-methods">
            {s.methods.map((m, i) => <li key={i}>{m}</li>)}
          </ul>
        )}
      </div>
    )
  }
  return (
    <div className="msg assistant">
      <div className="msg-role">天枢</div>
      <div className="msg-body">{block.text}</div>
    </div>
  )
}
