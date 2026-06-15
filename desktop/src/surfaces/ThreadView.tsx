import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  onSend: (prompt: string, images?: string[]) => void
  onSteer: (text: string) => void
  onAbort: () => void
  onSetApprovalMode: (mode: ApprovalMode) => void
}) {
  const { session, view, onSend, onSteer, onAbort, onSetApprovalMode } = props
  const [input, setInput] = useState('')
  const [showRewind, setShowRewind] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  const msgRef = useRef<HTMLDivElement>(null)
  const [scrolledUp, setScrolledUp] = useState(false)
  const busy = session.status === 'running'
  const autonomous = isAutonomous(session.approvalMode)

  const isNearBottom = useCallback(() => {
    const el = msgRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }, [])

  // Auto-scroll only when user is near the bottom.
  useEffect(() => {
    if (!scrolledUp && endRef.current) {
      endRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [view.blocks.length, scrolledUp])

  // Track scroll position: when user scrolls into the "near bottom" zone,
  // clear the scrolled-up flag so auto-scroll resumes.
  const onScroll = useCallback(() => {
    setScrolledUp(!isNearBottom())
  }, [isNearBottom])

  const scrollToBottom = useCallback(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
    setScrolledUp(false)
  }, [])

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

      <div className="messages" ref={msgRef} onScroll={onScroll}>
        {view.blocks.length === 0 && (
          <div className="empty sm">
            <svg className="empty-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
            </svg>
            <span>发一条消息开始</span>
          </div>
        )}
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
        {scrolledUp && (
          <button className="scroll-bottom-btn" onClick={scrollToBottom} aria-label="回到底部">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
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
        onSubmit={(text, images) => {
          if (busy) onSteer(text)
          else onSend(text, images)
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
      <MsgBlock role="你">
        <Markdown source={block.text} />
        {block.imageCount && block.imageCount > 0 ? (
          <div className="msg-images">📷 {block.imageCount} 张图片</div>
        ) : null}
      </MsgBlock>
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
      <MsgBlock role="引导 · 已排队">
        <Markdown source={block.text} />
      </MsgBlock>
    )
  }
  if (block.kind === 'phase') {
    return <MsgBlock className="phase">{block.text}</MsgBlock>
  }
  if (block.kind === 'error') {
    return <MsgBlock isError>{block.text}</MsgBlock>
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
    <MsgBlock role="天枢">
      <Markdown source={block.text} />
    </MsgBlock>
  )
}

/** MsgBlock — message wrapper with a copy button that appears on hover. */
function MsgBlock(props: {
  role?: string
  isError?: boolean
  className?: string
  children: React.ReactNode
}) {
  const { role, isError, className, children } = props
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const copy = useCallback(() => {
    const text = ref.current?.textContent ?? ''
    if (!text) return
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [])

  const kind = className
    ? ` ${className}`
    : isError ? ' error' : role === '引导 · 已排队' ? ' steer' : role === '你' ? ' user' : ' assistant'

  return (
    <div className={`msg${kind}`}>
      {role && <div className="msg-role">{role}</div>}
      <div className="msg-body" ref={ref}>
        <button
          className="msg-copy-btn"
          onClick={copy}
          aria-label={copied ? '已复制' : '复制'}
          title={copied ? '已复制' : '复制'}
        >
          {copied ? '✓' : '⎘'}
        </button>
        {children}
      </div>
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
