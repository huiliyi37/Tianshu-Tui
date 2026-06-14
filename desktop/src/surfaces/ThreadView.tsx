import { useEffect, useRef, useState } from 'react'
import type { ApprovalMode, SessionRecord } from '../runtime/types'
import type { ConvoBlock, EventViewState } from '../state/event-reducer'
import { basename } from '../lib/projects'
import { ToolBlock } from '../components/ToolBlock'
import { DelegationTree } from '../components/DelegationTree'
import { TaskList } from '../components/TaskList'
import { AutonomyControl } from '../components/AutonomyControl'
import { isAutonomous, isWindows, levelToMode, modeToLevel } from '../lib/autonomy'

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
  onSteer: (text: string) => void
  onAbort: () => void
  onSetApprovalMode: (mode: ApprovalMode) => void
}) {
  const { session, view, onSend, onSteer, onAbort, onSetApprovalMode } = props
  const [input, setInput] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const busy = session.status === 'running'
  const autonomous = isAutonomous(session.approvalMode)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [view.blocks.length])

  const submit = () => {
    const text = input.trim()
    if (!text) return
    // T3 — while a turn is running, Enter queues steering guidance (injected at
    // the next tool boundary) instead of erroring; idle starts a fresh turn.
    // The user turn / steer is echoed back as an event, so no optimistic render.
    if (busy) onSteer(text)
    else onSend(text)
    setInput('')
  }

  const showThinking = busy && !view.private_textOpen && !view.private_thinkingOpen

  return (
    <div className="thread">
      <header className="thread-header">
        <span className={`thread-glyph ${autonomous ? 'autonomous' : ''}`} aria-hidden>
          {autonomous ? '✦' : ''}
        </span>
        <div className="thread-id">
          <div className="thread-title">{session.title ?? session.id.slice(0, 8)}</div>
          <div className="thread-sub" title={session.cwd}>{basename(session.cwd) || session.cwd}</div>
        </div>
        <AutonomyControl
          compact
          value={modeToLevel(session.approvalMode)}
          onChange={(lvl) => onSetApprovalMode(levelToMode(lvl))}
        />
        <div className="thread-status">
          <span className={`status-dot status-${session.status}`} />
          <span className="status-text">{STATUS_LABEL[session.status] ?? session.status}</span>
          {busy && view.phase && <span className="phase-chip">{view.phase}</span>}
        </div>
      </header>
      {autonomous && (
        <div className="autonomy-banner">
          <span className="ab-glyph" aria-hidden>✦</span>
          自治模式 · 项目内操作自动执行
          {isWindows()
            ? '；⚠️ Windows 无写沙箱保护，仅靠回滚兜底'
            : '；项目外写入仍被沙箱拦截，可随时回滚'}
        </div>
      )}

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

      <TaskList items={view.todos} />
      <DelegationTree nodes={view.delegation} />

      <div className="composer">
        <textarea
          value={input}
          placeholder={busy
            ? '运行中 · Enter 插入引导（下一步生效）'
            : '和天枢对话…  (Enter 发送, Shift+Enter 换行)'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        {busy ? (
          <div className="composer-actions">
            <button className="btn ghost" onClick={submit} disabled={!input.trim()}>引导</button>
            <button className="btn ghost danger" onClick={onAbort}>停止</button>
          </div>
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
  if (block.kind === 'thinking') {
    // T1 — reasoning stream, collapsed by default (Antigravity surfaces summaries,
    // not raw token streams; the user can expand to audit).
    return (
      <details className="reasoning">
        <summary className="reasoning-summary">
          <span className="reasoning-glyph" aria-hidden>✶</span>
          推理过程
        </summary>
        <div className="reasoning-body">{block.text}</div>
      </details>
    )
  }
  if (block.kind === 'turn') {
    const t = block.turn
    const tokens = t?.totalTokens ? ` · ~${formatTokens(t.totalTokens)} tokens` : ''
    const label = t?.turnNumber != null ? `第 ${t.turnNumber} 轮` : '一轮结束'
    return (
      <div className="turn-divider" role="separator">
        <span className="turn-label">{label}{tokens}</span>
      </div>
    )
  }
  if (block.kind === 'checkpoint') {
    return (
      <div className="checkpoint-chip" title="本轮写操作前的回滚锚点（可在右侧审查面板回滚）">
        <span className="cp-glyph" aria-hidden>⎌</span>
        回滚点 · {(block.hash ?? '').slice(0, 8)}
      </div>
    )
  }
  if (block.kind === 'steer') {
    return (
      <div className="msg steer">
        <div className="msg-role">引导 · 已排队</div>
        <div className="msg-body">{block.text}</div>
      </div>
    )
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

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
