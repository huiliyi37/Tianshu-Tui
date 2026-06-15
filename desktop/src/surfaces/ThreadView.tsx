import { useEffect, useMemo, useRef, useState } from 'react'
import type { ApprovalMode, SessionRecord } from '../runtime/types'
import type { ConvoBlock, EventViewState } from '../state/event-reducer'
import { basename } from '../lib/projects'
import { ToolBlock } from '../components/ToolBlock'
import { Markdown } from '../components/Markdown'
import { Composer } from '../components/Composer'
import { DelegationTree } from '../components/DelegationTree'
import { TaskList } from '../components/TaskList'
import { AutonomyControl } from '../components/AutonomyControl'
import { RewindOverlay } from '../components/RewindOverlay'
import type { ComposerCommand } from '../lib/composer-commands'
import { isAutonomous, isWindows, levelToMode, modeToLevel } from '../lib/autonomy'
import { loadThemePref, setThemePref } from '../lib/theme'

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
  const [showRewind, setShowRewind] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  const busy = session.status === 'running'
  const autonomous = isAutonomous(session.approvalMode)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [view.blocks.length])

  const showThinking = busy && !view.private_textOpen && !view.private_thinkingOpen

  // D3 — composer slash commands: only desktop-actionable items (no agent slashes).
  const commands = useMemo<ComposerCommand[]>(() => [
    { name: '/rewind', desc: '回滚到某条消息', run: () => setShowRewind(true) },
    { name: '/supervise', desc: '监督档 · 每步确认', run: () => onSetApprovalMode(levelToMode('supervised')) },
    { name: '/default', desc: '默认档 · 低风险自动', run: () => onSetApprovalMode(levelToMode('default')) },
    { name: '/autonomous', desc: '自治档 · 项目内全自动', run: () => onSetApprovalMode(levelToMode('autonomous')) },
    {
      name: '/theme',
      desc: '切换主题 (system→light→dark)',
      run: () => {
        const order = ['system', 'light', 'dark'] as const
        const cur = loadThemePref()
        setThemePref(order[(order.indexOf(cur) + 1) % order.length]!)
      },
    },
  ], [onSetApprovalMode])

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
        {view.blocks.map((b, i) => (
          <Block
            key={b.key}
            block={b}
            isStreaming={
              b.kind === 'thinking' &&
              i === view.blocks.length - 1 &&
              view.private_thinkingOpen
            }
          />
        ))}
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

      <Composer
        sessionId={session.id}
        value={input}
        onChange={setInput}
        busy={busy}
        onSubmit={(text) => {
          if (busy) onSteer(text)
          else onSend(text)
          setInput('')
        }}
        onAbort={onAbort}
        onDoubleEscape={() => setShowRewind(true)}
        commands={commands}
      />
      {showRewind && (
        <RewindOverlay
          sessionId={session.id}
          onClose={() => setShowRewind(false)}
          onRewound={(prompt) => {
            setInput(prompt)
            // Force re-fetch events to update the conversation view
            window.dispatchEvent(new Event('rewind-complete'))
          }}
        />
      )}
    </div>
  )
}

function Block({ block, isStreaming }: { block: ConvoBlock; isStreaming?: boolean }) {
  if (block.kind === 'user') {
    return (
      <div className="msg user">
        <div className="msg-role">你</div>
        <div className="msg-body"><Markdown source={block.text} /></div>
      </div>
    )
  }
  if (block.kind === 'tool' || block.kind === 'result') {
    return <ToolBlock title={block.role ?? block.kind} body={block.text} isError={block.isError} />
  }
  if (block.kind === 'thinking') {
    return <ThinkingBlock block={block} streaming={!!isStreaming} />
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
        <div className="msg-body"><Markdown source={block.text} /></div>
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
      <div className="msg-body"><Markdown source={block.text} /></div>
    </div>
  )
}

/**
 * T1 — reasoning stream. Defaults to OPEN while streaming (user sees live
 * token flow), collapsible for review after the run finishes.
 *
 * Replaces the old `<details>` approach which (a) defaulted to collapsed,
 * hiding the live stream, and (b) used browser-managed `open` state that
 * could desync under React's high-frequency re-renders during streaming.
 */
function ThinkingBlock({ block, streaming }: { block: ConvoBlock; streaming: boolean }) {
  const [open, setOpen] = useState(true)
  const bodyRef = useRef<HTMLDivElement>(null)

  // While streaming, force-open and auto-scroll to the bottom.
  useEffect(() => {
    if (streaming) {
      setOpen(true)
      if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [streaming, block.text])

  return (
    <div className="reasoning">
      <div className="reasoning-summary" onClick={() => setOpen((o) => !o)}>
        <span className={`reasoning-glyph${streaming ? ' streaming' : ''}`} aria-hidden>{streaming ? '⟳' : '✶'}</span>
        {streaming ? '推理中…' : '推理过程'}
      </div>
      {open && (
        <div className="reasoning-body" ref={bodyRef}>{block.text}</div>
      )}
    </div>
  )
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
