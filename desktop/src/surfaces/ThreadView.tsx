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

interface UserTurn {
  key: string
  text: string
  before: number // view.blocks length at send time → render order anchor
}

// Thread view (P2) — the single-session working surface. Status header (with a
// reserved slot for a future CVM domain glyph) + Codex-style message stream
// (collapsible tools, streaming indicator, optimistic user turns) + composer.
export function ThreadView(props: {
  session: SessionRecord
  view: EventViewState
  onSend: (prompt: string) => void
  onAbort: () => void
}) {
  const { session, view, onSend, onAbort } = props
  const [input, setInput] = useState('')
  const [userTurns, setUserTurns] = useState<UserTurn[]>([])
  const endRef = useRef<HTMLDivElement>(null)
  const busy = session.status === 'running'

  useEffect(() => {
    setUserTurns([])
  }, [session.id])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [view.blocks.length, userTurns.length])

  const submit = () => {
    const text = input.trim()
    if (!text) return
    setUserTurns((t) => [...t, { key: `u-${Date.now()}`, text, before: view.blocks.length }])
    onSend(text)
    setInput('')
  }

  // Interleave optimistic user turns with reducer blocks by their anchor index.
  const rendered: React.ReactNode[] = []
  const flushUsers = (idx: number) => {
    for (const u of userTurns) {
      if (u.before === idx) {
        rendered.push(
          <div key={u.key} className="msg user">
            <div className="msg-role">你</div>
            <div className="msg-body">{u.text}</div>
          </div>,
        )
      }
    }
  }
  view.blocks.forEach((b, i) => {
    flushUsers(i)
    rendered.push(<Block key={b.key} block={b} />)
  })
  // Trailing user turns (sent against the current tail / before any response).
  for (const u of userTurns) {
    if (u.before >= view.blocks.length) {
      rendered.push(
        <div key={u.key} className="msg user">
          <div className="msg-role">你</div>
          <div className="msg-body">{u.text}</div>
        </div>,
      )
    }
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
        {rendered.length === 0 && <div className="empty sm">发一条消息开始</div>}
        {rendered}
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
  if (block.kind === 'tool' || block.kind === 'result') {
    return <ToolBlock title={block.role ?? block.kind} body={block.text} isError={block.isError} />
  }
  if (block.kind === 'phase') {
    return <div className="msg phase">{block.text}</div>
  }
  if (block.kind === 'error') {
    return <div className="msg error">{block.text}</div>
  }
  return (
    <div className="msg assistant">
      <div className="msg-role">天枢</div>
      <div className="msg-body">{block.text}</div>
    </div>
  )
}
