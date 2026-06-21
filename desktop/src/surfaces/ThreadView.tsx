import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { ApprovalMode, PlanModeState, SessionRecord } from '../runtime/types'
import type { ConvoBlock, EventViewState } from '../state/event-reducer'
import { basename } from '../lib/projects'
import { ToolGroup, ToolCard, isCollapsibleTool, isRunTestsTool, toolNameOf } from '../components/ToolGroup'
import { Markdown, closeUnterminatedFence } from '../components/Markdown'
import { Composer } from '../components/Composer'
import { DelegationTree } from '../components/DelegationTree'
import { TaskList } from '../components/TaskList'
import { AutonomyControl } from '../components/AutonomyControl'
import { RewindOverlay } from '../components/RewindOverlay'
import type { ComposerCommand } from '../lib/composer-commands'
import { isAutonomous, isWindows, levelToMode, modeToLevel } from '../lib/autonomy'
import { useUiState } from '../state/store'
import { loadThemePref, setThemePref } from '../lib/theme'
import { fetchSessionImageObjectUrl } from '../runtime/client'
import { STAR_DOMAINS } from '../../../src/agent/star-domain.js'
import type { StarDomainId } from '../../../src/agent/star-domain.js'

const STATUS_LABEL: Record<string, string> = {
  idle: '空闲',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  aborted: '已中止',
}

/** Resolve the active star domain for this session. Desktop currently defaults
 *  to 天枢 (tianshu) — real-time domain events will make this dynamic later. */
function resolveActiveDomain(_session: SessionRecord, _view: EventViewState): StarDomainId {
  return 'tianshu'
}

/** Look up a domain glyph by name or ID. Falls back to the default ✹. */
function domainGlyphForName(name: string): string {
  for (const [, d] of Object.entries(STAR_DOMAINS)) {
    if (d.name === name || d.id === name) return d.uiPersona.glyph
  }
  return '✹'
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
  onSetPlanMode?: (state: PlanModeState) => void
  onClose: () => void
}) {
  const { session, view, onSend, onSteer, onAbort, onSetApprovalMode, onSetPlanMode, onClose } = props
  const [input, setInput] = useState('')
  const [showRewind, setShowRewind] = useState(false)
  const toolDensity = useUiState().toolDensity
  const [lightbox, setLightbox] = useState<string | null>(null)
  const openImage = useCallback((src: string) => setLightbox(src), [])
  const msgRef = useRef<HTMLDivElement>(null)
  const [scrolledUp, setScrolledUp] = useState(false)
  const busy = session.status === 'running'
  const autonomous = isAutonomous(session.approvalMode)
  const activeDomainId = useMemo(() => resolveActiveDomain(session, view), [session, view])
  const activeDomain = STAR_DOMAINS[activeDomainId]
  const domainGlyph = activeDomain?.uiPersona.glyph ?? '✹'
  const domainSeparator = activeDomain?.uiPersona.separator ?? 'thin'

  const isNearBottom = useCallback(() => {
    const el = msgRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }, [])

  // Group consecutive tool/result blocks into one compact stream (Cursor 3.0).
  const rendered = useMemo(() => groupBlocks(view.blocks), [view.blocks])
  const lastKey = view.blocks[view.blocks.length - 1]?.key
  // P2 — only render the visible window of the message list. Long sessions keep
  // DOM at O(viewport) instead of O(messages). Item heights vary, so rows are
  // measured dynamically via measureElement (ResizeObserver under the hood).
  const virtualizer = useVirtualizer({
    count: rendered.length,
    getScrollElement: () => msgRef.current,
    estimateSize: () => 80,
    overscan: 8,
    getItemKey: (i) => {
      const item = rendered[i]!
      return item.kind !== 'block' ? item.key : item.block.key
    },
  })

  // The last block's text length drives streaming auto-scroll: blocks.length
  // stays constant while a reply streams in, so we pin the bottom on text growth.
  const lastBlockTextLen = view.blocks[view.blocks.length - 1]?.text.length ?? 0

  // Auto-scroll only when the user is near the bottom (incl. streaming growth).
  useEffect(() => {
    if (!scrolledUp && rendered.length > 0) {
      virtualizer.scrollToIndex(rendered.length - 1, { align: 'end' })
    }
  }, [rendered.length, lastBlockTextLen, scrolledUp, virtualizer])

  // Track scroll position: when user scrolls into the "near bottom" zone,
  // clear the scrolled-up flag so auto-scroll resumes.
  const onScroll = useCallback(() => {
    setScrolledUp(!isNearBottom())
  }, [isNearBottom])

  const scrollToBottom = useCallback(() => {
    if (rendered.length > 0) virtualizer.scrollToIndex(rendered.length - 1, { align: 'end' })
    setScrolledUp(false)
  }, [rendered.length, virtualizer])

  const showThinking = busy && !view.private_textOpen && !view.private_thinkingOpen

  // Context usage bar: live token estimate vs model window.
  const ctxPct = useMemo(() => {
    const tokens = session.contextTokens
    const window = session.contextWindow
    if (!tokens || !window || window <= 0) return 0
    return Math.min(Math.round((tokens / window) * 100), 100)
  }, [session.contextTokens, session.contextWindow])

  // Latest turn's total tokens for the compact "tok" chip.
  const latestTokens = useMemo(() => {
    for (let i = view.blocks.length - 1; i >= 0; i--) {
      const t = view.blocks[i]!.turn
      if (t?.totalTokens) return t.totalTokens
    }
    return 0
  }, [view.blocks])

  // Cache hit rate from cumulative cache tokens in turn_complete events.
  const cacheHitRate = useMemo(() => {
    const total = view.cacheReadTokens + view.cacheCreationTokens
    if (total <= 0) return null
    return Math.round((view.cacheReadTokens / total) * 100)
  }, [view.cacheReadTokens, view.cacheCreationTokens])

  // Context increment: delta between last and previous turn totals.
  const ctxDelta = useMemo(() => {
    if (view.prevTotalTokens <= 0 || view.lastTotalTokens <= view.prevTotalTokens) return 0
    return view.lastTotalTokens - view.prevTotalTokens
  }, [view.lastTotalTokens, view.prevTotalTokens])

  // D3 — composer slash commands: desktop-actionable items + prompt pass-throughs.
  const commands = useMemo<ComposerCommand[]>(() => [
    { name: '/rewind', desc: '回滚到某条消息', run: () => setShowRewind(true) },
    { name: '/supervise', desc: '监督档 · 每步确认', run: () => onSetApprovalMode(levelToMode('supervised')) },
    { name: '/default', desc: '默认档 · 低风险自动', run: () => onSetApprovalMode(levelToMode('default')) },
    { name: '/autonomous', desc: '自治档 · 项目内全自动', run: () => onSetApprovalMode(levelToMode('autonomous')) },
    {
      name: '/review',
      desc: 'L2 审查 · 单审查员',
      run: () => onSend('Run code review on the current uncommitted changes: call deliver_task with commit=true and review_level="L2". This triggers L2 adversarial verifier.'),
    },
    {
      name: '/review max',
      desc: 'L3 审查 · 编队 5 审查员',
      run: () => onSend('Run code review on the current uncommitted changes: call deliver_task with commit=true and review_level="L3". This triggers L3 Review Squadron (5 inspectors).'),
    },
    {
      name: '/theme',
      desc: '切换主题 (system→light→dark)',
      run: () => {
        const order = ['system', 'light', 'dark'] as const
        const cur = loadThemePref()
        setThemePref(order[(order.indexOf(cur) + 1) % order.length]!)
      },
    },
    {
      name: '/plan',
      desc: '创建实施方案',
      run: () => onSend('Enter plan mode. Explore the codebase and produce an implementation plan for the task I will describe next.'),
    },
    {
      name: '/team',
      desc: '团队模式 · 多 agent 协作',
      run: () => onSend('Run team-mode workflow through team_orchestrate for the task I will describe next.'),
    },
    {
      name: '/interview',
      desc: '深度访谈 · 先问后做',
      run: () => onSend('Run a deep technical interview before implementing. Ask me 3-5 clarifying questions about requirements, constraints, and edge cases.'),
    },
    {
      name: '/compact',
      desc: '压缩上下文',
      run: () => onSend('Context is getting long. Please compact the conversation: summarize tool outputs, collapse resolved discussions, and trim stale context while preserving key decisions and active work state.'),
    },
    {
      name: '/memory',
      desc: '查看会话记忆',
      run: () => onSend('Show the current session memory overview: session entries, project pheromones, and project knowledge files.'),
    },
    {
      name: '/context',
      desc: '上下文状态',
      run: () => onSend('Show context ledger status: token usage, compaction state, cache hit rate, and pinned anchors.'),
    },
    {
      name: '/verify',
      desc: '验证状态',
      run: () => onSend('Show verification status for all modified files in this session: which are verified, which are pending, and the last verification result.'),
    },
    {
      name: '/mission',
      desc: '当前任务契约',
      run: () => onSend('Show the current task contract: objective, scope, acceptance criteria, and delivery status.'),
    },
    {
      name: '/debug cache',
      desc: '缓存诊断',
      run: () => onSend('Show cache debug info: hit rate, read/write tokens, estimated context size, and cost.'),
    },
    {
      name: '/constellation',
      desc: '项目星图 · 架构蓝图',
      run: () => onSend('Show the project constellation: architecture overview, milestones, and recent activity.'),
    },
    {
      name: '/dream',
      desc: '记忆蒸馏状态',
      run: () => onSend('Show dream / memory distillation status: how many curated memories exist, when the last distillation ran.'),
    },
    {
      name: '/sensorium',
      desc: '认知自感知',
      run: () => onSend('Show the cognitive sensorium state: task status, verification gaps, delivery readiness, and active signals.'),
    },
  ], [onSetApprovalMode, onSend])

  return (
    <div className={`thread domain-${activeDomainId}`} data-separator={domainSeparator}>
      <header className="thread-header">
        <span className={`thread-glyph${busy ? ' breathing' : ''}`} aria-hidden>
          {domainGlyph}
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
          {session.model && (
            <span className="model-chip" title={`当前模型: ${session.model}`}>
              {session.model.replace(/^(deepseek-|glm-|mimo-)/, '').slice(0, 16)}
            </span>
          )}
          <span className={`mode-chip ${view.planMode === 'planning' ? 'plan' : 'agent'}`}>
            {view.planMode === 'planning' ? 'Plan' : 'Agent'}
          </span>
          {session.contextWindow && session.contextWindow > 0 ? (
            <div className="ctx-bar" title={`${formatTokens(session.contextTokens ?? 0)} / ${formatTokens(session.contextWindow)} tokens`}>
              <div className="ctx-bar-fill" style={{ width: `${ctxPct}%` }} />
              <span className="ctx-bar-label">{ctxPct}%</span>
            </div>
          ) : latestTokens > 0 ? (
            <span className="ctx-meter" title="上一轮上下文 tokens">{formatTokens(latestTokens)} tok</span>
          ) : null}
          {cacheHitRate !== null ? (
            <span className="cache-chip" title={`缓存读 {formatTokens(view.cacheReadTokens)} / 创建 {formatTokens(view.cacheCreationTokens)}`}>
              ⚡{cacheHitRate}%
            </span>
          ) : null}
          {ctxDelta > 0 ? (
            <span className="ctx-delta" title="本轮上下文增量">
              +{formatTokens(ctxDelta)}
            </span>
          ) : null}
          <span className={`status-dot status-${session.status}`} />
          <span className="status-text">{STATUS_LABEL[session.status] ?? session.status}</span>
          {busy && view.phase && <span className="phase-chip">{view.phase}</span>}
        </div>
        <button className="icon-btn thread-close" title="关闭会话" onClick={onClose} aria-label="关闭会话">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
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
        {rendered.length > 0 && (
          <div className="vlist" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const item = rendered[vi.index]!
              return (
                <div
                  key={vi.key}
                  className="vrow"
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  style={{ transform: `translateY(${vi.start}px)` }}
                >
                  {item.kind !== 'block' ? (
                    <ToolGroup items={item.items} density={toolDensity} />
                  ) : (
                    <Block
                      block={item.block}
                      sessionId={session.id}
                      onOpenImage={openImage}
                      isStreaming={
                        item.block.key === lastKey && (
                          (item.block.kind === 'thinking' && view.private_thinkingOpen) ||
                          (item.block.kind === 'assistant' && view.private_textOpen)
                        )
                      }
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}
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
        planMode={view.planMode}
        onSetPlanMode={onSetPlanMode}
        menuRev={view.menuRev}
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
      {lightbox && <ImageLightbox src={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  )
}

/** A user-attached image: fetch its bytes (Bearer-gated) into a blob object URL,
 *  render a thumbnail, and revoke the URL on unmount to avoid a leak. */
function SessionImage({ sessionId, imgId, index, onOpen }: {
  sessionId: string
  imgId: string
  index: number
  onOpen?: (src: string) => void
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    let objectUrl: string | null = null
    fetchSessionImageObjectUrl(sessionId, imgId)
      .then((u) => {
        if (!alive) { URL.revokeObjectURL(u); return }
        objectUrl = u
        setUrl(u)
      })
      .catch(() => { if (alive) setFailed(true) })
    return () => {
      alive = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [sessionId, imgId])
  if (failed) return <span className="msg-thumb-fail" title="图片加载失败">🖼 加载失败</span>
  if (!url) return <span className="msg-thumb-skeleton" aria-hidden />
  return (
    <img className="msg-thumb" src={url} alt={`图片 ${index + 1}`} loading="lazy"
      onClick={() => onOpen?.(url)} />
  )
}

/** Full-size image overlay. Click anywhere or press Esc to close. */
function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="lightbox" onClick={onClose} role="dialog" aria-modal="true">
      <img className="lightbox-img" src={src} alt="图片" onClick={(e) => e.stopPropagation()} />
      <button className="lightbox-close" onClick={onClose} aria-label="关闭">×</button>
    </div>
  )
}

type RenderItem =
  | { kind: 'tools'; key: string; items: ConvoBlock[] }
  | { kind: 'run_tests'; key: string; items: ConvoBlock[] }
  | { kind: 'block'; block: ConvoBlock }

/** Only exploration tools (read/search/list) that succeeded fold into the
 *  compact group; action tools and errors render expanded as standalone cards. */
function isFoldable(b: ConvoBlock): boolean {
  return (b.kind === 'tool' || b.kind === 'result') && !b.isError && isCollapsibleTool(toolNameOf(b))
}

/** run_tests tool/result blocks eligible for action grouping (success or failure). */
function isRunTestsFoldable(b: ConvoBlock): boolean {
  return (b.kind === 'tool' || b.kind === 'result') && isRunTestsTool(toolNameOf(b))
}

/** Collapse runs of collapsible tool/result blocks into grouped render items.
 *  Exploration tools (read/search/list) and run_tests each form their own group
 *  type; everything else stays standalone. */
function groupBlocks(blocks: ConvoBlock[]): RenderItem[] {
  const out: RenderItem[] = []
  let run: ConvoBlock[] | null = null
  let runKind: 'tools' | 'run_tests' | null = null
  for (const b of blocks) {
    const foldKind = isFoldable(b) ? 'tools' as const : isRunTestsFoldable(b) ? 'run_tests' as const : null
    if (foldKind) {
      if (!run || runKind !== foldKind) { run = []; runKind = foldKind; out.push({ kind: foldKind, key: `tg-${b.key}`, items: run }) }
      run.push(b)
    } else {
      run = null
      runKind = null
      out.push({ kind: 'block', block: b })
    }
  }
  return out
}

// Row-level memo (Cursor 3.0): with the reducer's immutable updates, historical
// blocks keep object identity, so memo skips their reconciliation entirely —
// only the actively-growing last block re-renders during streaming.
const Block = memo(BlockImpl, (a, b) =>
  a.block === b.block && a.isStreaming === b.isStreaming &&
  a.sessionId === b.sessionId && a.onOpenImage === b.onOpenImage
)

function BlockImpl({ block, isStreaming, sessionId, onOpenImage }: {
  block: ConvoBlock
  isStreaming?: boolean
  sessionId?: string
  onOpenImage?: (src: string) => void
}) {
  if (block.kind === 'user') {
    return (
      <MsgBlock role="你">
        <Markdown source={block.text} />
        {block.imageIds && block.imageIds.length > 0 && sessionId ? (
          <div className="msg-images">
            {block.imageIds.map((imgId, i) => (
              <SessionImage key={imgId} sessionId={sessionId} imgId={imgId} index={i} onOpen={onOpenImage} />
            ))}
          </div>
        ) : block.images && block.images.length > 0 ? (
          <div className="msg-images">
            {block.images.map((src, i) => (
              <img key={i} className="msg-thumb" src={src} alt={`图片 ${i + 1}`}
                onClick={() => onOpenImage?.(src)} />
            ))}
          </div>
        ) : block.imageCount && block.imageCount > 0 ? (
          <div className="msg-images">📷 {block.imageCount} 张图片</div>
        ) : null}
      </MsgBlock>
    )
  }
  if (block.kind === 'tool' || block.kind === 'result') {
    return <ToolCard block={block} />
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
    const shiftGlyph = s.domain ? domainGlyphForName(s.domain) : '✦'
    return (
      <div className={`decision-shift ${s.severity}`}>
        <div className="ds-head">
          <span className="ds-glyph" aria-hidden>{shiftGlyph}</span>
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
    <MsgBlock role={STAR_DOMAINS.tianshu.name}>
      <AssistantText text={block.text} isStreaming={!!isStreaming} />
    </MsgBlock>
  )
}

// Re-parse the streaming source at ~10fps instead of every rAF frame, then snap
// to the full text the instant streaming stops. Rendering Markdown incrementally
// (rather than plain text → one big parse on turn_complete) removes the end-of-
// stream spike: the final frame is just one more cheap incremental parse, not a
// jump from plain text to a fully highlighted document.
const STREAM_THROTTLE_MS = 100
function useThrottledStreamingSource(text: string, isStreaming: boolean): string {
  const [shown, setShown] = useState(text)
  const latest = useRef(text)
  const lastAt = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  latest.current = text

  useEffect(() => {
    if (!isStreaming) {
      if (timer.current) { clearTimeout(timer.current); timer.current = null }
      setShown(text)
      return
    }
    const elapsed = Date.now() - lastAt.current
    // Mark mid-stream re-parses as low priority so a heavy Markdown/highlight
    // pass can be interrupted by scrolling or typing in the composer.
    if (elapsed >= STREAM_THROTTLE_MS) {
      lastAt.current = Date.now()
      startTransition(() => setShown(latest.current))
    } else if (timer.current === null) {
      timer.current = setTimeout(() => {
        timer.current = null
        lastAt.current = Date.now()
        startTransition(() => setShown(latest.current))
      }, STREAM_THROTTLE_MS - elapsed)
    }
  }, [text, isStreaming])

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  // Non-streaming always returns the full text immediately so the turn_complete
  // frame renders the final source without waiting for a throttle tick.
  return isStreaming ? shown : text
}

// Above this size, streaming Markdown would re-parse the whole string every
// throttle window. Fall back to plain text mid-stream and parse once at the end.
const STREAM_MARKDOWN_MAX = 16000
function AssistantText({ text, isStreaming }: { text: string; isStreaming: boolean }) {
  const heavy = isStreaming && text.length > STREAM_MARKDOWN_MAX
  const throttled = useThrottledStreamingSource(text, isStreaming && !heavy)
  if (heavy) return <StreamingText source={text} />
  // Streaming: render structure only (highlight=false); the async highlight pass
  // runs once on completion so mid-stream deltas stay cheap.
  if (isStreaming) return <Markdown source={closeUnterminatedFence(throttled)} highlight={false} />
  return <Markdown source={text} />
}

// Plain-text fallback for the very-long streaming guard (md-streaming keeps the
// pre-wrap styling until the final Markdown parse on turn completion).
function StreamingText({ source }: { source: string }) {
  return <div className="md md-streaming">{source}</div>
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
 * T1 — reasoning stream (Cursor 3.0 style). Streams OPEN by default so the user
 * sees live token flow, but stays freely collapsible mid-stream (the manual
 * toggle is honored, no force-open per delta). On completion it auto-collapses
 * to a single muted summary line unless the user pinned it open.
 */
function ThinkingBlock({ block, streaming }: { block: ConvoBlock; streaming: boolean }) {
  const [open, setOpen] = useState(true)
  const manual = useRef(false)
  const wasStreaming = useRef(streaming)
  const bodyRef = useRef<HTMLDivElement>(null)

  // Auto-collapse when the reasoning run completes (unless user pinned it open).
  useEffect(() => {
    if (wasStreaming.current && !streaming && !manual.current) setOpen(false)
    wasStreaming.current = streaming
  }, [streaming])

  // Auto-scroll the body to the tail while it streams and is open.
  useEffect(() => {
    if (streaming && open && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [streaming, open, block.text])

  const toggle = useCallback(() => { manual.current = true; setOpen((o) => !o) }, [])
  const summary = useMemo(() => summarizeThinking(block.text), [block.text])

  return (
    <div className={`reasoning${open ? ' open' : ''}${streaming ? ' streaming' : ''}`}>
      <div className="reasoning-summary" onClick={toggle}>
        <span className={`reasoning-glyph${streaming ? ' streaming' : ''}`} aria-hidden>{streaming ? '⟳' : '✶'}</span>
        <span className="reasoning-label">{streaming ? '推理中…' : '已推理'}</span>
        {!open && summary && <span className="reasoning-peek">{summary}</span>}
        <span className="reasoning-caret" aria-hidden>{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <div className="reasoning-body" ref={bodyRef}>{block.text}</div>
      )}
    </div>
  )
}

/** First meaningful line + char count, for the collapsed reasoning peek. */
function summarizeThinking(text: string): string {
  const firstLine = text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  const clean = firstLine.replace(/^[#>*\-\s]+/, '').slice(0, 80)
  const chars = text.replace(/\s/g, '').length
  if (!clean) return chars > 0 ? `${chars} 字` : ''
  return `${clean}${firstLine.length > 80 ? '…' : ''} · ${chars} 字`
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
