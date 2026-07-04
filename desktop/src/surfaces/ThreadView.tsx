import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useQueryClient } from '@tanstack/react-query'
import type { ApprovalMode, PlanModeState, SessionRecord } from '../runtime/types'
import type { ConvoBlock, EventViewState } from '../state/event-reducer'
import type { StreamStatus } from '../state/use-session-events'
import { basename } from '../lib/projects'
import { ToolCard, toolNameOf, pairEntries, PairedRow } from '../components/ToolGroup'
import type { PairedEntry } from '../components/ToolGroup'
import { Markdown, closeUnterminatedFence } from '../components/Markdown'
import { Composer } from '../components/Composer'
import { TimelineGroup } from '../components/TimelineGroup'
import { ArtifactCard } from '../components/ArtifactCard'
import { DelegationPill } from '../components/DelegationPill'
import { DelegationOverlay } from '../components/DelegationOverlay'
import { DelegateDialog } from '../components/DelegateDialog'
import { CompletionCurtain } from '../components/CompletionCurtain'
import { RewindOverlay } from '../components/RewindOverlay'
import { FileViewer } from '../components/FileViewer'
import { getFileContent, openFile } from '../runtime/client'
import type { FileContent } from '../runtime/types'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import type { ComposerCommand } from '../lib/composer-commands'
import { isAutonomous, levelToMode, modeToLevel } from '../lib/autonomy'
import { loadThemePref, setThemePref } from '../lib/theme'
import type { ThemePref } from '../lib/theme'
import { fetchSessionImageObjectUrl, getRewindPoints, rewindSession } from '../runtime/client'
import { formatMention } from '../lib/mention-input'
import { useUiState, useUiDispatch } from '../state/store'
import { SideChat } from '../components/SideChat'
import { MessageNavigator, type TurnEntry } from '../components/MessageNavigator'
import { QuestionCard } from './QuestionCard'
import { STAR_DOMAINS } from '../../../src/agent/star-domain.js'
import type { StarDomainId } from '../../../src/agent/star-domain.js'

const STATUS_LABEL: Record<string, string> = {
  idle: '空闲',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  aborted: '已中止',
}

/** Resolve the active star domain for this session. Uses the session's pinned
 *  domain when known; otherwise falls back to 天枢 (tianshu). */
function resolveActiveDomain(session: SessionRecord, _view: EventViewState): StarDomainId {
  if (session.domain && session.domain in STAR_DOMAINS) return session.domain as StarDomainId
  return 'tianshu'
}

/** Look up a domain glyph by name or ID. Falls back to the default ✹. */
function domainGlyphForName(name: string): string {
  for (const [, d] of Object.entries(STAR_DOMAINS)) {
    if (d.name === name || d.id === name) return d.uiPersona.glyph
  }
  return '✹'
}

/** Format milliseconds as a short elapsed string: "3s", "1m 23s", "5m 00s". */
function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}m ${String(s).padStart(2, '0')}s`
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
  /** D2 — live SSE connection state; drives the "updates stopped" banner. */
  streamStatus?: StreamStatus
  onRetryStream?: () => void
}) {
  const { session, view, onSend, onSteer, onAbort, onSetApprovalMode, onSetPlanMode, onClose, streamStatus, onRetryStream } = props
  const ui = useUiState()
  const dispatch = useUiDispatch()
  const [input, setInputRaw] = useState(ui.composerDrafts[session.id] ?? '')
  /** Wrapper that also syncs to the store so drafts survive tab switches. */
  const setInput = useCallback((text: string) => {
    setInputRaw(text)
    dispatch({ type: 'setComposerDraft', sessionId: session.id, text })
  }, [dispatch, session.id])

  // ── Prompt history recall (terminal-style Up/Down) ──
  // Source from raw `view.blocks` (not `rendered`) so history is stable across
  // rewind-slider / view-mode filtering. Newest first; empty strings skipped.
  const historyTexts = useMemo(() => {
    const out: string[] = []
    for (let i = view.blocks.length - 1; i >= 0; i--) {
      const b = view.blocks[i]!
      if (b.kind === 'user' && b.text) out.push(b.text)
    }
    return out
  }, [view.blocks])
  // historyIndex: null = not browsing history (normal typing); number = index
  // into historyTexts currently shown in the input.
  const historyIndex = useRef<number | null>(null)
  // Stash of the in-progress draft when the user first presses Up, restored on
  // the way back Down past the newest entry.
  const stashedDraft = useRef<string>('')
  // Reset browsing state when switching sessions — history belongs to a session.
  useEffect(() => { historyIndex.current = null }, [session.id])

  const recallHistory = useCallback((dir: 'prev' | 'next') => {
    const n = historyTexts.length
    if (n === 0) return
    const cur = historyIndex.current
    if (dir === 'prev') {
      // First Up from typing: stash current draft, jump to newest (index 0).
      // Subsequent Up: walk older (index++).
      const next = cur === null ? 0 : Math.min(cur + 1, n - 1)
      if (cur === null) stashedDraft.current = input
      historyIndex.current = next
      setInput(historyTexts[next] ?? '')
    } else {
      if (cur === null) return // not browsing — nothing to do
      const next = cur - 1
      if (next < 0) {
        // Down past newest → restore stashed draft, back to typing mode.
        historyIndex.current = null
        setInput(stashedDraft.current)
        stashedDraft.current = ''
      } else {
        historyIndex.current = next
        setInput(historyTexts[next] ?? '')
      }
    }
  }, [historyTexts, input, setInput])
  const qc = useQueryClient()
  const [showRewind, setShowRewind] = useState(false)
  const [showDelegation, setShowDelegation] = useState(false)
  const [showDelegateDialog, setShowDelegateDialog] = useState(false)
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)
  // P1-4 — Side Chat drawer (旁路提问): Cmd+; or the header button toggles.
  const [sideChatOpen, setSideChatOpen] = useState(false)
  // File viewer drawer: opened by clicking @file mentions in messages.
  const [fileViewer, setFileViewer] = useState<{ path: string; content?: FileContent; loading?: boolean; error?: string } | null>(null)
  useEffect(() => {
    if (!fileViewer?.path || fileViewer.content || fileViewer.loading) return
    setFileViewer({ path: fileViewer.path, loading: true })
    getFileContent(session.id, fileViewer.path)
      .then((content) => setFileViewer({ path: fileViewer.path, content }))
      .catch((err) => setFileViewer({ path: fileViewer.path, error: (err as Error).message }))
  }, [fileViewer, session.id])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ';') {
        e.preventDefault()
        setSideChatOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const [composerHeight, setComposerHeight] = useState(0)
  const composerWrapRef = useRef<HTMLDivElement | null>(null)
  const composerObserverRef = useRef<ResizeObserver | null>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const openImage = useCallback((src: string) => setLightbox(src), [])
  // Watchdog "继续执行" — resume a run the recovery quota stopped.
  const handleWatchdogContinue = useCallback(() => onSend('continue'), [onSend])
  const msgRef = useRef<HTMLDivElement>(null)
  const [scrolledUp, setScrolledUp] = useState(false)
  const [navTick, setNavTick] = useState(0) // bumps on scroll → refresh navigator marker

  // Time-Travel Timeline Slider state
  const [rewindPoints, setRewindPoints] = useState<import('../runtime/client').RewindPoint[]>([])
  const [selectedTurnIndex, setSelectedTurnIndex] = useState<number>(-1)

  useEffect(() => {
    if (session.id) {
      getRewindPoints(session.id)
        .then(({ points }) => {
          setRewindPoints(points)
          setSelectedTurnIndex(points.length) // default to latest
        })
        .catch((err) => console.error(err))
    }
  }, [session.id])

  // Append file attachments queued from the file explorer as @file mentions.
  // Keep any existing text and preserve the trailing mention suffix pattern.
  useEffect(() => {
    if (ui.composerAttachments.length === 0) return
    const suffix = ui.composerAttachments.map((a) => formatMention(a.path, a.kind)).join(' ')
    const next = input
      ? `${input}${input.endsWith(' ') ? '' : ' '}${suffix}`
      : suffix
    setInput(next)
    dispatch({ type: 'clearComposerAttachments' })
  }, [ui.composerAttachments, input, dispatch])

  // 发消息失败时回填输入内容：useSendPrompt 的 onError 派发 'send-prompt-failed' 事件，
  // 此处监听并把失败的 prompt 塞回输入框，让用户能编辑后重发（而非因 submit 已清空而丢失）。
  // 仅当当前输入框为空时回填，避免覆盖用户失败后已手动输入的新内容。
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ prompt: string }>).detail
      if (detail?.prompt && !input) setInput(detail.prompt)
    }
    window.addEventListener('send-prompt-failed', handler as EventListener)
    return () => window.removeEventListener('send-prompt-failed', handler as EventListener)
  }, [input])
  const busy = session.status === 'running'
  // Elapsed-time indicator: tick every second while running so users can tell
  // if the agent is genuinely working or stuck (参考 Codex #24240 / Claude Code spinner).
  const [, setElapsedTick] = useState(0)
  useEffect(() => {
    if (!busy || !view.runStartedAt) return
    const id = setInterval(() => setElapsedTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [busy, view.runStartedAt])
  const elapsedMs = busy && view.runStartedAt ? Date.now() - view.runStartedAt : 0
  const elapsedStr = elapsedMs > 0 ? formatElapsed(elapsedMs) : ''
  const elapsedStalled = elapsedMs > 600_000 // >10min → 红色高亮提示可能卡住

  const autonomous = isAutonomous(session.approvalMode)
  const activeDomainId = useMemo(() => resolveActiveDomain(session, view), [session, view])
  const activeDomain = STAR_DOMAINS[activeDomainId]
  const domainGlyph = session.domainGlyph ?? activeDomain?.uiPersona.glyph ?? '✹'
  const domainSeparator = activeDomain?.uiPersona.separator ?? 'thin'

  const isNearBottom = useCallback(() => {
    const el = msgRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }, [])

  // Group consecutive tool/result blocks into one compact stream (Cursor 3.0).
  // U8: depend on blocksRev so in-place streaming text updates still recompute.
  const filteredBlocks = useMemo(() => {
    // selectedTurnIndex === -1 (no selection) or === length (slider far right) =
    // latest: show everything.
    if (selectedTurnIndex === -1 || selectedTurnIndex >= rewindPoints.length) {
      return view.blocks
    }

    // Historical: parked BEFORE rewind point `selectedTurnIndex`, so only the
    // turns a fork here would keep are shown. Anchor on that point's `seq` — the
    // exact `u-${seq}` block rewind() truncates from — so the preview is the
    // byte-for-byte post-fork state (no drift from system/compaction/image turns
    // that broke the old user-block-counting heuristic).
    const point = rewindPoints[selectedTurnIndex]
    if (!point) return view.blocks

    if (typeof point.seq === 'number') {
      const cutIdx = view.blocks.findIndex(
        (b) => b.kind === 'user' && b.key === `u-${point.seq}`,
      )
      if (cutIdx >= 0) return view.blocks.slice(0, cutIdx)
    }

    // Fallback (event log trimmed → no seq): cut at the (selectedTurnIndex)-th
    // user block. Equivalent to the seq path on a healthy 1:1 block/message log.
    let userBlockCount = 0
    for (let i = 0; i < view.blocks.length; i++) {
      if (view.blocks[i]?.kind === 'user') {
        if (userBlockCount === selectedTurnIndex) {
          return view.blocks.slice(0, i)
        }
        userBlockCount++
      }
    }
    return view.blocks
  }, [view.blocks, selectedTurnIndex, rewindPoints])

  // P1-2 view mode: summary keeps only conversational text (user/assistant/
  // error/turn separators) — tool runs and thinking are dropped before grouping.
  const viewMode = ui.viewMode
  const modeBlocks = useMemo(() => {
    if (viewMode !== 'summary') return filteredBlocks
    return filteredBlocks.filter((b) =>
      b.kind === 'user' || b.kind === 'assistant' || b.kind === 'error' || b.kind === 'turn' || b.kind === 'steer',
    )
  }, [filteredBlocks, viewMode])

  const rendered = useMemo(() => groupBlocks(modeBlocks), [modeBlocks, view.blocksRev])
  const lastKey = view.blocks[view.blocks.length - 1]?.key
  // P2 — only render the visible window of the message list. Long sessions keep
  // DOM at O(viewport) instead of O(messages). Item heights vary, so rows are
  // measured dynamically via measureElement (ResizeObserver under the hood).
  const virtualizer = useVirtualizer({
    count: rendered.length,
    getScrollElement: () => msgRef.current,
    estimateSize: () => 80,
    overscan: 8,
    getItemKey: (index) => {
      const item = rendered[index]!
      return item.kind === 'timeline' ? item.key : item.block.key
    },
  })

  // The last block's text length drives streaming auto-scroll: blocks.length
  // stays constant while a reply streams in, so we pin the bottom on text growth.
  const lastBlockTextLen = view.blocks[view.blocks.length - 1]?.text.length ?? 0

  // Auto-scroll only when the user is near the bottom, throttled to ~10Hz. During
  // streaming these deps change every rAF batch; an unthrottled scrollToIndex
  // forces a layout (plus a measureElement remeasure of the growing last row) on
  // every token — a feedback loop that janks hard on WebView2. A leading+trailing
  // throttle keeps the bottom pinned without the per-token layout storm.
  const scrolledUpRef = useRef(scrolledUp)
  scrolledUpRef.current = scrolledUp
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastScrollAtRef = useRef(0)
  useEffect(() => () => { if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current) }, [])
  useEffect(() => {
    if (scrolledUp || rendered.length === 0) return
    const SCROLL_THROTTLE_MS = 100
    const run = () => {
      scrollTimerRef.current = null
      if (scrolledUpRef.current) return // user scrolled up while the tick was pending
      lastScrollAtRef.current = performance.now()
      virtualizer.scrollToIndex(rendered.length - 1, { align: 'end' })
    }
    const elapsed = performance.now() - lastScrollAtRef.current
    if (elapsed >= SCROLL_THROTTLE_MS) run()
    else if (scrollTimerRef.current === null) {
      scrollTimerRef.current = setTimeout(run, SCROLL_THROTTLE_MS - elapsed)
    }
  }, [rendered.length, lastBlockTextLen, scrolledUp, virtualizer])

  // Measure the floating composer so the thread reserves bottom padding and
  // the last message is never hidden behind the input card.
  useEffect(() => {
    const node = composerWrapRef.current
    if (!node) return
    composerObserverRef.current?.disconnect()
    const ro = new ResizeObserver(() => setComposerHeight(node.offsetHeight))
    ro.observe(node)
    composerObserverRef.current = ro
    setComposerHeight(node.offsetHeight)
    return () => {
      composerObserverRef.current?.disconnect()
      composerObserverRef.current = null
    }
  }, [])

  // Track scroll position: when user scrolls into the "near bottom" zone,
  // clear the scrolled-up flag so auto-scroll resumes.
  const onScroll = useCallback(() => {
    setScrolledUp(!isNearBottom())
    setNavTick((t) => t + 1) // refresh navigator "current" marker
    // Persist scroll position to store (throttled via rAF).
    const el = msgRef.current
    if (el) dispatch({ type: 'setScrollPosition', sessionId: session.id, scrollTop: el.scrollTop })
  }, [isNearBottom, dispatch, session.id])

  // Restore scroll position on mount — preserves across tab switches.
  useEffect(() => {
    const saved = ui.scrollPositions[session.id]
    const el = msgRef.current
    if (saved != null && saved > 0 && el) {
      // Wait one frame for the virtualizer to measure content.
      requestAnimationFrame(() => { el.scrollTop = saved })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id])

  const scrollToBottom = useCallback(() => {
    if (rendered.length > 0) virtualizer.scrollToIndex(rendered.length - 1, { align: 'end' })
    setScrolledUp(false)
  }, [rendered.length, virtualizer])

  // Keyboard navigation: j/k or ↑/↓ to jump between message blocks.
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null)
  const onMessagesKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Only handle when focus is on the messages container itself (not in input).
    const el = document.activeElement
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable)) return
    const isNav = e.key === 'j' || e.key === 'k' || (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp'))
    if (!isNav) return
    e.preventDefault()
    const dir = e.key === 'j' || e.key === 'ArrowDown' ? 1 : -1
    setFocusedIndex((prev) => {
      const next = prev == null ? (dir > 0 ? 0 : rendered.length - 1) : Math.max(0, Math.min(rendered.length - 1, prev + dir))
      virtualizer.scrollToIndex(next, { align: 'center' })
      return next
    })
  }, [rendered.length, virtualizer])

  // ── Message navigator: jump to any earlier user turn without scrolling ──
  // seq → timestamp, joined from the already-fetched rewind points.
  const tsBySeq = useMemo(() => {
    const m = new Map<number, number>()
    for (const p of rewindPoints) {
      if (typeof p.seq === 'number') m.set(p.seq, p.timestamp)
    }
    return m
  }, [rewindPoints])

  // User turns as jumpable anchors. Derived from `rendered` (not raw blocks) so
  // renderedIndex is always a valid scrollToIndex target for the virtual list.
  const userTurns = useMemo<TurnEntry[]>(() => {
    const out: TurnEntry[] = []
    rendered.forEach((item, i) => {
      if (item.kind === 'block' && item.block.kind === 'user') {
        const seq = Number(item.block.key.slice(2)) // "u-<seq>"
        out.push({
          renderedIndex: i,
          key: item.block.key,
          text: item.block.text,
          ...(tsBySeq.has(seq) ? { ts: tsBySeq.get(seq) } : {}),
        })
      }
    })
    return out
  }, [rendered, tsBySeq])

  // Rendered-row index of the first currently-visible row → drives the
  // navigator's "current" marker. Recomputed on scroll via navTick.
  const navActiveIndex = useMemo(() => {
    void navTick // recompute when the viewport moves
    const items = virtualizer.getVirtualItems()
    return items.length > 0 ? items[0]!.index : null
  }, [navTick, virtualizer, rendered.length])

  const jumpTo = useCallback((renderedIndex: number) => {
    setScrolledUp(true) // stop streaming auto-scroll from yanking us back to bottom
    virtualizer.scrollToIndex(renderedIndex, { align: 'start' })
    // Dynamic row heights: the estimate (80px) differs from measured height, so
    // a single call can under/overshoot — correct once on the next frame.
    requestAnimationFrame(() => virtualizer.scrollToIndex(renderedIndex, { align: 'start' }))
    setFocusedIndex(renderedIndex)
  }, [virtualizer])

  const showThinking = busy && !view.private_textOpen && !view.private_thinkingOpen

  // Context usage bar: live token estimate vs model window.
  const ctxPct = useMemo(() => {
    const tokens = session.contextTokens
    const window = session.contextWindow
    if (!tokens || !window || window <= 0) return 0
    return Math.min(Math.round((tokens / window) * 100), 100)
  }, [session.contextTokens, session.contextWindow])

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
    { name: '/subagents', desc: '打开子代理面板', run: () => setShowDelegation(true) },
    { name: '/supervise', desc: '监督档 · 每步确认', run: () => onSetApprovalMode(levelToMode('supervised')) },
    { name: '/default', desc: '默认档 · 低风险自动', run: () => onSetApprovalMode(levelToMode('default')) },
    { name: '/autonomous', desc: '自治档 · 项目内全自动', run: () => onSetApprovalMode(levelToMode('autonomous')) },
    {
      name: '/review',
      desc: 'L2 审查 · 单审查员',
      example: '/review [关注点描述]',
      // Raw slash → server resolveAppPromptInput translates (single source of truth).
      run: () => onSend('/review'),
    },
    {
      name: '/review max',
      desc: 'L3 审查 · 编队 5 审查员',
      example: '/review max [关注点描述]',
      run: () => onSend('/review max'),
    },
    {
      name: '/theme',
      desc: '切换主题 (system→light→dark→nebula→sakura→cyberpunk→cupertino→light-classic)',
      run: () => {
        const order: ThemePref[] = ['system', 'light', 'dark', 'nebula', 'sakura', 'cyberpunk', 'cupertino', 'light-classic']
        const cur = loadThemePref()
        setThemePref(order[(order.indexOf(cur) + 1) % order.length]!)
      },
    },
    {
      name: '/plan',
      desc: '进入 Plan 模式 · 调研后写方案',
      example: '/plan <功能描述>',
      run: () => {
        if (onSetPlanMode && view.planMode !== 'planning') {
          onSetPlanMode('planning')
        }
        onSend('Enter plan mode. Explore the codebase and produce an implementation plan for the task I will describe next.')
      },
    },
    {
      name: '/write-plan',
      desc: '写实现计划文档 · 先调研后设计',
      example: '/write-plan <功能描述>',
      // Needs args — prefill the composer instead of firing a bare command.
      run: () => setInput('/write-plan '),
    },
    {
      name: '/plan-close',
      desc: '关闭计划 · 归档并总结偏差',
      example: '/plan-close <计划 slug>',
      run: () => setInput('/plan-close '),
    },
    {
      name: '/team',
      desc: '团队模式 · 多 agent 协作',
      example: '/team <任务描述>',
      run: () => onSend('/team'),
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
    {
      name: '/council',
      desc: '议事会 · 星域专家审查',
      example: '/council <目标描述>',
      run: () => onSend('/council'),
    },
    // C4 — /goal & /cancel-goal 已移除：sidecar 从不创建 GoalTracker，这两个
    // 快捷命令只是把一段假承诺文案发给模型（「跨 turn 自主执行直到达成」不成立）。
    // 真正的 sidecar goal 接线（含暂停/取消按钮）另立项。
    {
      name: '/effort',
      desc: '设置推理强度 (off/low/medium/high/max)',
      run: () => onSend('Show current reasoning effort level. Available: off, low, medium, high, max.'),
    },
    {
      name: '/model',
      desc: '切换模型',
      run: () => onSend('Show available models for switching.'),
    },
    {
      name: '/domain',
      desc: '切换星域人格',
      run: () => onSend('Show available star domains for switching.'),
    },
    {
      name: '/todo',
      desc: '任务清单管理 (list/add/done/skip/move)',
      run: () => onSend('Show current todo list. Use /todo add/done/skip/move to manage tasks.'),
    },
    {
      name: '/undo',
      desc: '撤销文件更改',
      run: () => onSend('Undo the last file change. Use /undo preview N to preview before undoing.'),
    },
    {
      name: '/rollback',
      desc: '回滚文件更改（/undo 别名）',
      run: () => onSend('Rollback recent file changes.'),
    },
    {
      name: '/workflow',
      desc: 'YAML 工作流编排 (list/<name>/replay)',
      run: () => onSend('Show available workflows from .rivet/workflows/*.yaml.'),
    },
    {
      name: '/plan-template',
      desc: '计划模板库 (list/save/<name>)',
      run: () => onSend('Show available plan templates from .rivet/plan-templates/*.md.'),
    },
    {
      name: '/team-resume',
      desc: '从 wave checkpoint 恢复团队执行',
      run: () => onSend('Show available team checkpoints for resume.'),
    },
    {
      name: '/fork',
      desc: 'Fork 当前会话',
      run: () => onSend('Fork the current session into a new branch.'),
    },
    {
      name: '/branch',
      desc: '分支树 · 查看父/子会话',
      run: () => onSend('Show the session branch tree: parent and child sessions.'),
    },
    {
      name: '/sessions',
      desc: '列出所有会话',
      run: () => onSend('List all saved sessions.'),
    },
    {
      name: '/skill',
      desc: '技能管理 (list/<name>)',
      run: () => onSend('Show available skills.'),
    },
    {
      name: '/evidence',
      desc: '验证证据摘要',
      run: () => onSend('Show evidence summary: last 10 verifications and pass rate.'),
    },
    {
      name: '/status',
      desc: 'Agent 状态总览',
      run: () => onSend('Show agent status: model, domain, cache hit rate, token usage, cost.'),
    },
    {
      name: '/mcp',
      desc: 'MCP 服务器状态',
      run: () => onSend('Show MCP server connection status.'),
    },
    {
      name: '/leave',
      desc: '在星图留下标记',
      run: () => onSend('Leave a mark in the starmap summarizing this session.'),
    },
    {
      name: '/diagram',
      desc: '生成 Mermaid 图表骨架',
      run: () => onSend('Generate a mermaid diagram skeleton. Types: architecture, dataflow, sequence, flowchart, comparison, state.'),
    },
  ], [onSetApprovalMode, onSend, onSetPlanMode, view.planMode])

  // Lookup map for welcome cards/pills to call the actual slash command
  // run() instead of sending raw text to the model.
  const runCommand = useMemo(() => {
    const m = new Map<string, () => void>()
    for (const c of commands) m.set(c.name, c.run)
    return (name: string) => m.get(name)?.()
  }, [commands])

  return (
    <div className={`thread domain-${activeDomainId}`} data-separator={domainSeparator} style={{ paddingBottom: composerHeight }}>
      <header className="thread-header">
        <div className="thread-header-main">
          <span className={`thread-glyph${busy ? ' breathing' : ''}`} aria-hidden>
            {domainGlyph}
          </span>
          <div className="thread-id">
            <div className="thread-title">{session.title ?? session.id.slice(0, 8)}</div>
            <div className="thread-sub" title={session.cwd}>{basename(session.cwd) || session.cwd}</div>
          </div>
          {/* 权限档位芯片移到 Composer 旁（P1-1，对标 Claude Desktop 送信钮旁控件群）。 */}
          {autonomous && (
            <span className="autonomy-badge" title="自治模式 · 项目内操作自动执行；项目外写入仍被沙箱拦截，可随时回滚">
              <span className="ab-glyph" aria-hidden>✦</span>
              自治
            </span>
          )}
          <span className={`status-dot status-${session.status}`} />
          <span className="status-text">{STATUS_LABEL[session.status] ?? session.status}</span>
          <button
            className={`icon-btn sidechat-toggle ${sideChatOpen ? 'active' : ''}`}
            title="旁路提问 (⌘;) — 不影响主任务的独立轻会话"
            aria-label="旁路提问"
            onClick={() => setSideChatOpen((o) => !o)}
          >💬</button>
          <button className="icon-btn thread-close" title="关闭会话" onClick={() => setShowCloseConfirm(true)} aria-label="关闭会话">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {rewindPoints.length > 0 && (
          <div className="thread-timeline-slider-container px-4 py-2 border-t border-border bg-panel-2 flex items-center gap-3">
            <span className="text-xs text-muted font-medium flex items-center gap-1 shrink-0">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              时间旅行:
            </span>
            <input
              type="range"
              min="0"
              max={rewindPoints.length}
              value={selectedTurnIndex === -1 ? rewindPoints.length : selectedTurnIndex}
              onChange={(e) => {
                const val = Number(e.target.value)
                setSelectedTurnIndex(val)
              }}
              className="timeline-slider flex-1 h-1 bg-border rounded-lg appearance-none cursor-pointer accent-accent"
            />
            <span className="text-xs font-mono text-muted bg-panel-3 px-1.5 py-0.5 rounded border border-border max-w-[220px] truncate shrink-0" title={selectedTurnIndex >= 0 && selectedTurnIndex < rewindPoints.length ? `分叉点（第 ${selectedTurnIndex + 1} 轮）：${rewindPoints[selectedTurnIndex]?.content}` : '最新'}>
              {selectedTurnIndex === -1 || selectedTurnIndex >= rewindPoints.length ? (
                '最新 (Latest)'
              ) : (
                `↩ 第 ${selectedTurnIndex + 1} 轮之前`
              )}
            </span>
          </div>
        )}

        <div className="thread-header-meta">
          {/* model / plan-mode / context-ring 在 Composer 底栏已有可交互版本——header 不重复 */}
          {session.reasoningEffort && (
            <button
              className="effort-chip"
              title={`推理强度: ${session.reasoningEffort}（点击切换）`}
              onClick={() => onSend('/effort')}
            >
              {session.reasoningEffort}
            </button>
          )}
          {session.contextWindow && session.contextWindow > 0 && ctxPct >= 80 ? (
            <div className="ctx-bar warn" title={`${formatTokens(session.contextTokens ?? 0)} / ${formatTokens(session.contextWindow)} tokens — 接近上限`}>
              <div className="ctx-bar-fill" style={{ width: `${ctxPct}%` }} />
              <span className="ctx-bar-label">{ctxPct}%</span>
            </div>
          ) : null}
          {cacheHitRate !== null ? (
            <span className="cache-chip" title={`缓存读 ${formatTokens(view.cacheReadTokens)} / 创建 ${formatTokens(view.cacheCreationTokens)}`}>
              ⚡{cacheHitRate}%
            </span>
          ) : null}
          {ctxDelta > 0 ? (
            <span className="ctx-delta" title="本轮上下文增量">
              +{formatTokens(ctxDelta)}
            </span>
          ) : null}
          {busy && view.phase && <span className="phase-chip">{view.phase}{elapsedStr && ` · ${elapsedStr}`}</span>}
          {busy && !view.phase && elapsedStr && <span className={`phase-chip${elapsedStalled ? ' stalled' : ''}`}>{elapsedStr}</span>}
        </div>
      </header>

      <div className="messages" ref={msgRef} onScroll={onScroll} onKeyDown={onMessagesKeyDown} tabIndex={-1}>
        {streamStatus === 'offline' && (
          <div className="stream-banner offline" role="alert">
            <span className="stream-banner-glyph" aria-hidden>⚠</span>
            <span className="stream-banner-text">实时连接已断开，可能错过最新进度</span>
            <button
              className="stream-banner-retry"
              onClick={() => onRetryStream?.()}
              aria-label="重新连接实时更新"
            >
              重新连接
            </button>
          </div>
        )}
        {streamStatus === 'reconnecting' && (
          <div className="stream-banner reconnecting" role="status">
            <span className="stream-banner-glyph spin" aria-hidden>⟳</span>
            <span className="stream-banner-text">连接中断，正在重连…</span>
          </div>
        )}
        {view.blocks.length === 0 && (
          <div className="empty welcome">
            <p className="welcome-title">开始对话</p>
            <p className="welcome-hint">输入消息或选择一个快捷命令</p>
            <div className="welcome-pills">
              <span className="welcome-pill" onClick={() => runCommand('/plan')}>创建方案</span>
              <span className="welcome-pill" onClick={() => runCommand('/review')}>审查变更</span>
              <span className="welcome-pill" onClick={() => runCommand('/autonomous')}>自治模式</span>
              <span className="welcome-pill" onClick={() => runCommand('/team')}>组队</span>
              <span className="welcome-pill" onClick={() => runCommand('/context')}>上下文</span>
            </div>
          </div>
        )}
        {rendered.length > 0 && (
          <div className="vlist" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const item = rendered[vi.index]!
              return (
                <div
                  key={vi.key}
                  className={`vrow${focusedIndex === vi.index ? ' vrow-focused' : ''}`}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  style={{ transform: `translateY(${vi.start}px)` }}
                >
                  {item.kind === 'timeline' ? (
                    <TimelineGroup blocks={item.items} forceOpen={viewMode === 'verbose'}>
                      {groupTimelineItems(item.items).map((tItem, idx) => {
                        if (tItem.kind === 'thinking') {
                          const isStreaming = tItem.block.key === lastKey && view.private_thinkingOpen
                          return (
                            <ThinkingBlock
                              key={tItem.block.key ?? idx}
                              block={tItem.block}
                              streaming={!!isStreaming}
                            />
                          )
                        } else {
                          return (
                            <PairedRow
                              key={tItem.entry.tool?.key ?? tItem.entry.result?.key ?? idx}
                              entry={tItem.entry}
                              sessionId={session.id}
                              onOpenImage={openImage}
                            />
                          )
                        }
                      })}
                    </TimelineGroup>
                  ) : item.kind === 'artifact' ? (
                    <ArtifactCard block={item.block} />
                  ) : (
                    <Block
                      block={item.block}
                      sessionId={session.id}
                      onOpenImage={openImage}
                      onFileClick={(p) => setFileViewer({ path: p })}
                      domainGlyph={domainGlyph}
                      domainName={activeDomain?.name}
                      onContinue={handleWatchdogContinue}
                      onCancelContinue={onAbort}
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
            <span className="thinking-label">
              {view.phase ? `思考中 · ${view.phase}` : '思考中…'}
              {elapsedStr && <span className={`elapsed${elapsedStalled ? ' stalled' : ''}`}> · {elapsedStr}</span>}
            </span>
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
        <MessageNavigator turns={userTurns} activeIndex={navActiveIndex} onJump={jumpTo} />
      </div>

      {session.status === 'completed' && view.completionSummary && (() => {
        // 显示条件：有 todo（无论是否全部完成）、有文件改动、或有验证记录。
        // 之前要求 allTodosDone 才显示——agent 不用 todo 就永远看不到总结。
        const hasTodos = view.todos.length > 0
        const hasFileChanges = (view.completionSummary.filesModified?.length ?? 0) > 0
        const hasReads = (view.completionSummary.filesRead?.length ?? 0) > 0
        const hasVerifications = (view.completionSummary.verifications?.length ?? 0) > 0
        if (!hasTodos && !hasFileChanges && !hasReads && !hasVerifications) return null
        return <CompletionCurtain summary={view.completionSummary} />
      })()}

      <DelegationPill
        nodes={view.delegation}
        open={showDelegation}
        onToggle={() => setShowDelegation((v) => !v)}
      />

      <div className="composer-float" ref={composerWrapRef}>
        <div className="composer-float-inner">
          {view.pendingQuestion && !busy && (
            <QuestionCard
              question={view.pendingQuestion}
              onSubmit={(text) => onSend(text)}
            />
          )}
          {selectedTurnIndex >= 0 && selectedTurnIndex < rewindPoints.length && (
            <div className="historical-turn-banner flex items-center justify-between bg-warning-soft border border-warning/30 rounded-lg p-3 mb-2 text-xs">
              <div className="flex items-center gap-2 text-warning">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                <span className="font-medium">
                  已回退到第 {selectedTurnIndex + 1} 轮之前（仅显示其前的 {selectedTurnIndex} 轮）。在此发送新消息将从这里分叉（Fork），截断第 {selectedTurnIndex + 1} 轮及其后的历史。
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  className="px-2.5 py-1 rounded bg-warning text-white hover:bg-warning/90 transition-colors font-medium"
                  onClick={async () => {
                    const point = rewindPoints[selectedTurnIndex]
                    if (point) {
                      try {
                        await rewindSession(session.id, point.index)
                        setSelectedTurnIndex(-1)
                        const { points } = await getRewindPoints(session.id)
                        setRewindPoints(points)
                      } catch (err) {
                        console.error(err)
                      }
                    }
                  }}
                >
                  在此分叉 (Fork)
                </button>
                <button
                  className="px-2.5 py-1 rounded bg-panel-3 hover:bg-panel-2 border border-border text-text transition-colors"
                  onClick={() => setSelectedTurnIndex(-1)}
                >
                  返回最新
                </button>
              </div>
            </div>
          )}
          <Composer
            sessionId={session.id}
            value={input}
            onChange={setInput}
            busy={busy}
            threadNonEmpty={view.blocks.length > 0}
            approvalLevel={modeToLevel(session.approvalMode)}
            onSetApprovalLevel={(lvl) => onSetApprovalMode(levelToMode(lvl))}
            contextUsage={{
              usedTokens: session.contextTokens ?? view.lastTotalTokens,
              contextWindow: session.contextWindow,
              cacheReadTokens: view.cacheReadTokens,
              cacheCreationTokens: view.cacheCreationTokens,
              deltaTokens: ctxDelta,
            }}
            onSubmit={async (text, images) => {
              if (selectedTurnIndex >= 0 && selectedTurnIndex < rewindPoints.length) {
                const point = rewindPoints[selectedTurnIndex]
                if (point) {
                  try {
                    await rewindSession(session.id, point.index)
                    setSelectedTurnIndex(-1)
                    const { points } = await getRewindPoints(session.id)
                    setRewindPoints(points)
                  } catch (err) {
                    console.error(err)
                  }
                }
              }
              if (busy) onSteer(text)
              else onSend(text, images)
              setInput('')
              historyIndex.current = null
            }}
            onAbort={onAbort}
            onDoubleEscape={() => setShowRewind(true)}
            commands={commands}
            planMode={view.planMode}
            onSetPlanMode={onSetPlanMode}
            onDelegate={() => setShowDelegateDialog(true)}
            onWorkflow={(cmd) => {
              // 带上引导 prompt——让 agent 进入对应工作流模式并询问用户具体目标。
              const label = cmd === '/council' ? '议事会评审' : '团队协作'
              onSend(`${cmd} 我想用${label}模式完成一个任务，请先问我具体目标是什么。`)
            }}
            menuRev={view.menuRev}
            onHistoryPrev={() => recallHistory('prev')}
            onHistoryNext={() => recallHistory('next')}
          />
        </div>
      </div>
      {showDelegation && (
        <DelegationOverlay
          nodes={view.delegation}
          onClose={() => setShowDelegation(false)}
          onAdopt={(text) => { setInput(text); setShowDelegation(false) }}
        />
      )}
      {showDelegateDialog && (
        <DelegateDialog
          sessionId={session.id}
          onClose={() => setShowDelegateDialog(false)}
          onDispatched={() => setShowDelegation(true)}
        />
      )}
      {showRewind && (
        <RewindOverlay
          sessionId={session.id}
          isRunning={busy}
          onClose={() => setShowRewind(false)}
          onRewound={(prompt) => {
            setInput(prompt)
            // Force re-fetch events to update the conversation view
            window.dispatchEvent(new Event('rewind-complete'))
          }}
          onCodeRolledBack={() => {
            // Files changed on disk without a conversation event — refresh the
            // working tree + any open per-file diffs so Changes reflects it now.
            void qc.invalidateQueries({ queryKey: ['git', 'working-tree'] })
            void qc.invalidateQueries({ queryKey: ['git', 'diff'] })
          }}
        />
      )}
      {lightbox && <ImageLightbox src={lightbox} onClose={() => setLightbox(null)} />}

      <SideChat
        open={sideChatOpen}
        onClose={() => setSideChatOpen(false)}
        mainTitle={session.title ?? session.id.slice(0, 8)}
        cwd={session.cwd}
        mainBlocks={view.blocks}
      />

      {fileViewer && (
        <div className="file-viewer-drawer" role="complementary" aria-label="文件预览">
          <div className="file-viewer-head">
            <span className="file-viewer-title" title={fileViewer.path}>
              {fileViewer.path.replace(/.*[/\\]/, '') || fileViewer.path}
            </span>
            <button
              className="icon-btn"
              title="在编辑器中打开"
              aria-label="在编辑器中打开"
              onClick={() => void openFile(fileViewer.path)}
            >↗</button>
            <button
              className="icon-btn"
              title="关闭"
              aria-label="关闭"
              onClick={() => setFileViewer(null)}
            >✕</button>
          </div>
          <div className="file-viewer-body">
            {fileViewer.loading && <div className="file-viewer-loading">加载中…</div>}
            {fileViewer.error && <div className="file-viewer-error">加载失败：{fileViewer.error}</div>}
            {fileViewer.content && (
              <FileViewer
                content={fileViewer.content.content}
                language={fileViewer.content.language}
                startLine={fileViewer.content.startLine}
              />
            )}
          </div>
        </div>
      )}

      <AlertDialog open={showCloseConfirm} onOpenChange={setShowCloseConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>关闭会话？</AlertDialogTitle>
            <AlertDialogDescription>
              关闭后该线程将从标签栏移除，未保存的上下文将丢失。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={onClose}>关闭</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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

function isArtifactTool(b: ConvoBlock): boolean {
  if (b.kind !== 'tool' && b.kind !== 'result') return false;
  const name = toolNameOf(b);
  if (name === 'write_file' || name === 'write_to_file' || name === 'edit_file') {
    try {
      const text = b.kind === 'tool' ? b.text : '';
      if (text.includes('ArtifactMetadata') || text.includes('implementation_plan.md') || text.includes('task.md') || text.includes('walkthrough.md')) {
        return true;
      }
    } catch(e) {}
  }
  return false;
}

function groupTimelineItems(blocks: ConvoBlock[]) {
  const items: Array<{ kind: 'thinking'; block: ConvoBlock } | { kind: 'paired'; entry: PairedEntry }> = []
  let currentToolRun: ConvoBlock[] = []

  const flushTools = () => {
    if (currentToolRun.length === 0) return
    const paired = pairEntries(currentToolRun)
    for (const entry of paired) {
      items.push({ kind: 'paired', entry })
    }
    currentToolRun = []
  }

  for (const b of blocks) {
    if (b.kind === 'thinking') {
      flushTools()
      items.push({ kind: 'thinking', block: b })
    } else {
      currentToolRun.push(b)
    }
  }
  flushTools()
  return items
}

type RenderItem =
  | { kind: 'timeline'; key: string; items: ConvoBlock[] }
  | { kind: 'artifact'; block: ConvoBlock }
  | { kind: 'block'; block: ConvoBlock }

/** Collapse contiguous agent reasoning and background tools into a unified timeline.
 *  Artifacts and conversational turns break the timeline. */
function groupBlocks(blocks: ConvoBlock[]): RenderItem[] {
  const out: RenderItem[] = []
  let run: ConvoBlock[] | null = null
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!
    if (
      b.kind === 'user' ||
      (b.kind === 'assistant' && b.text.trim()) ||
      b.kind === 'phase' ||
      b.kind === 'turn' ||
      b.kind === 'steer' ||
      b.kind === 'decision_shift' ||
      b.kind === 'intent_note' ||
      b.kind === 'watchdog_recovery' ||
      b.kind === 'autonomy_checkpoint' ||
      isArtifactTool(b)
    ) {
      if (run) {
        out.push({ kind: 'timeline', key: `tl-${run[0]!.key}`, items: run })
        run = null
      }
      
      if (isArtifactTool(b)) {
        if (b.kind === 'tool') {
          // If the next block is the corresponding result, skip it so we don't render it separately
          const next = blocks[i+1]
          if (next && next.kind === 'result' && toolNameOf(next) === toolNameOf(b)) {
            out.push({ kind: 'artifact', block: b })
            i++ // skip next
          } else {
            out.push({ kind: 'artifact', block: b })
          }
        } else {
          // It's a result block of an artifact tool without a preceding tool block in this context
          out.push({ kind: 'artifact', block: b })
        }
      } else {
        out.push({ kind: 'block', block: b })
      }
    } else {
      if (!run) run = []
      run.push(b)
    }
  }
  if (run) {
    out.push({ kind: 'timeline', key: `tl-${run[0]!.key}`, items: run })
  }
  return out
}

// Row-level memo (Cursor 3.0): with the reducer's immutable updates, historical
// blocks keep object identity, so memo skips their reconciliation entirely —
// only the actively-growing last block re-renders during streaming.
const Block = memo(BlockImpl, (a, b) =>
  a.block === b.block && a.isStreaming === b.isStreaming &&
  a.sessionId === b.sessionId && a.onOpenImage === b.onOpenImage &&
  a.onFileClick === b.onFileClick &&
  a.domainGlyph === b.domainGlyph && a.domainName === b.domainName &&
  a.onContinue === b.onContinue && a.onCancelContinue === b.onCancelContinue
)

function BlockImpl({ block, isStreaming, sessionId, onOpenImage, onFileClick, domainGlyph, domainName, onContinue, onCancelContinue }: {
  block: ConvoBlock
  isStreaming?: boolean
  sessionId?: string
  onOpenImage?: (src: string) => void
  onFileClick?: (path: string) => void
  domainGlyph?: string
  domainName?: string
  /** Resume a run stopped by the watchdog quota (sends "continue"). */
  onContinue?: () => void
  /** C2 刹车 — cancel a pending watchdog auto-continue countdown (aborts the session). */
  onCancelContinue?: () => void
}) {
  if (block.kind === 'user') {
    return (
      <MsgBlock role="你" roleGlyph="user">
        <Markdown source={block.text} onFileClick={onFileClick} />
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
      <MsgBlock role="引导" roleGlyph="steer">
        <Markdown source={block.text} onFileClick={onFileClick} />
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
  if (block.kind === 'intent_note' && block.note) {
    const n = block.note
    return (
      <div className="decision-shift info intent-note">
        <div className="ds-head">
          <span className="ds-glyph" aria-hidden>✦</span>
          <span className="ds-domain">{n.title}</span>
          <span className="ds-tag">方向提示</span>
        </div>
        {n.reasons.length > 0 && (
          <ul className="ds-methods">
            {n.reasons.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        )}
        {n.action && <div className="ds-reason">{n.action}</div>}
        {n.steerHint && <div className="intent-note-steer">{n.steerHint}</div>}
      </div>
    )
  }
  if (block.kind === 'autonomy_checkpoint') {
    // C3 刹车 — cruise pause (resume explicitly) vs unleashed non-blocking
    // progress ping (informational, no resume button — the run keeps going).
    const turns = block.checkpointTurns ?? 0
    const paused = block.checkpointPaused !== false
    if (!paused) {
      return (
        <div className="decision-shift info">
          <div className="ds-head">
            <span className="ds-glyph" aria-hidden>◦</span>
            <span className="ds-domain">自治进度播报</span>
            <span className="ds-tag">第 {turns} 轮 · 不暂停</span>
          </div>
          {block.checkpointDigest && (
            <pre className="ds-digest">{block.checkpointDigest}</pre>
          )}
        </div>
      )
    }
    return (
      <div className="decision-shift info">
        <div className="ds-head">
          <span className="ds-glyph" aria-hidden>⏸</span>
          <span className="ds-domain">自治检查点</span>
          <span className="ds-tag">已暂停</span>
        </div>
        <div className="ds-reason">
          已连续自主执行 {turns} 轮。停在这里核对方向——确认没跑偏再继续，或直接键入新指令改道。
        </div>
        {block.checkpointDigest && (
          <pre className="ds-digest">{block.checkpointDigest}</pre>
        )}
        {onContinue && (
          <button className="btn-sm watchdog-continue" onClick={onContinue}>继续执行</button>
        )}
      </div>
    )
  }
  if (block.kind === 'watchdog_recovery' && block.watchdog) {
    const w = block.watchdog
    // C2 刹车 — pending auto-continue: cancellable countdown card.
    if (w.pendingAutoContinue) {
      return <WatchdogPendingCard w={w} onContinue={onContinue} onCancel={onCancelContinue} />
    }
    const stopped = !w.autoContinue
    const tag = stopped
      ? (w.stopReason === 'session-total' ? '配额耗尽'
        : w.stopReason === 'consecutive' ? '连续上限'
        : '已停止')
      : '自动恢复'
    const quota = `${w.sessionTotal}/12`
    return (
      <div className={`decision-shift ${stopped ? 'warn' : 'info'}`}>
        <div className="ds-head">
          <span className="ds-glyph" aria-hidden>{stopped ? '⏹' : '⟳'}</span>
          <span className="ds-domain">边界停滞恢复</span>
          <span className="ds-tag">{tag}</span>
        </div>
        <div className="ds-reason">
          {stopped
            ? '停滞反复触发，已停止自动续跑——请检查方向或键入指令继续。'
            : '检测到边界停滞，已自动注入 continue 恢复执行。'}
          {' '}
          <span className="watchdog-quota">会话配额 {quota} · 连续 {w.consecutive}/3</span>
        </div>
        {stopped && onContinue && (
          <button className="btn-sm watchdog-continue" onClick={onContinue}>继续执行</button>
        )}
      </div>
    )
  }
  return (
    <MsgBlock role={domainName ?? STAR_DOMAINS.tianshu.name} roleGlyph={domainGlyph}>
      <AssistantText text={block.text} isStreaming={!!isStreaming} onFileClick={onFileClick} />
    </MsgBlock>
  )
}

/**
 * C2 刹车 — watchdog auto-continue countdown card. The server delays the
 * 'continue' resubmit by delayMs; this card counts it down and offers
 * 「立即继续」(send continue now) / 「取消」(abort → cancels the server timer).
 * Once the countdown lapses the server continues on its own — the card then
 * reads as a plain recovery notice.
 */
function WatchdogPendingCard({ w, onContinue, onCancel }: {
  w: NonNullable<ConvoBlock['watchdog']>
  onContinue?: () => void
  onCancel?: () => void
}) {
  const deadline = (w.receivedAt ?? Date.now()) + (w.delayMs ?? 5000)
  const [remainMs, setRemainMs] = useState(() => Math.max(0, deadline - Date.now()))
  useEffect(() => {
    if (w.cancelled) return
    const t = setInterval(() => {
      const r = Math.max(0, deadline - Date.now())
      setRemainMs(r)
      if (r <= 0) clearInterval(t)
    }, 200)
    return () => clearInterval(t)
  }, [deadline, w.cancelled])

  const cancelled = w.cancelled === true
  const pending = !cancelled && remainMs > 0
  const quota = `${w.sessionTotal}/12`
  return (
    <div className={`decision-shift ${cancelled ? 'warn' : 'info'}`}>
      <div className="ds-head">
        <span className="ds-glyph" aria-hidden>{cancelled ? '⏹' : '⟳'}</span>
        <span className="ds-domain">边界停滞恢复</span>
        <span className="ds-tag">{cancelled ? '已取消' : pending ? '倒计时' : '自动恢复'}</span>
      </div>
      <div className="ds-reason">
        {cancelled
          ? '续跑已取消——等待你的下一条指令。'
          : pending
            ? `检测到边界停滞，${Math.ceil(remainMs / 1000)}s 后自动续跑（可取消）。`
            : '倒计时结束，已自动注入 continue 恢复执行。'}
        {' '}
        <span className="watchdog-quota">会话配额 {quota} · 连续 {w.consecutive}/3</span>
      </div>
      {pending && (
        <div style={{ display: 'flex', gap: '8px' }}>
          {onContinue && (
            <button className="btn-sm watchdog-continue" onClick={onContinue}>立即继续</button>
          )}
          {onCancel && (
            <button className="btn-sm watchdog-continue" onClick={onCancel}>取消</button>
          )}
        </div>
      )}
    </div>
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
function AssistantText({ text, isStreaming, onFileClick }: { text: string; isStreaming: boolean; onFileClick?: (path: string) => void }) {
  const heavy = isStreaming && text.length > STREAM_MARKDOWN_MAX
  const throttled = useThrottledStreamingSource(text, isStreaming && !heavy)
  if (heavy) return <StreamingText source={text} />
  // Streaming: render structure only (highlight=false); the async highlight pass
  // runs once on completion so mid-stream deltas stay cheap.
  if (isStreaming) return <Markdown source={closeUnterminatedFence(throttled)} highlight={false} onFileClick={onFileClick} />
  return <Markdown source={text} onFileClick={onFileClick} />
}

// Above this size the streaming tail is windowed (see below).
const STREAM_TAIL_MAX = 8000

// Plain-text fallback for the very-long streaming guard (md-streaming keeps the
// pre-wrap styling until the final Markdown parse on turn completion).
//
// Only the trailing window is rendered while a long reply streams: a single
// growing text node costs O(n) to diff/paint per throttle tick, so over a
// 50k-char reply the naive full render is O(n^2). The user is pinned to the
// bottom mid-stream (auto-scroll), so the tail is exactly what they read; the
// full text + Markdown render the instant streaming completes (AssistantText
// switches off this path). Bounds per-tick work to O(tail).
function StreamingText({ source }: { source: string }) {
  const tail = source.length > STREAM_TAIL_MAX ? source.slice(-STREAM_TAIL_MAX) : source
  const truncated = tail.length < source.length
  return (
    <div className="md md-streaming">
      {truncated && <div className="md-stream-more">↑ 输出较长，完成后显示全文</div>}
      {tail}
    </div>
  )
}

/** MsgBlock — message wrapper with a copy button that appears on hover. */
function MsgBlock(props: {
  role?: string
  roleGlyph?: string | 'user' | 'steer'
  isError?: boolean
  className?: string
  children: React.ReactNode
}) {
  const { role, roleGlyph, isError, className, children } = props
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
    : isError ? ' error' : role === '引导' ? ' steer' : role === '你' ? ' user' : ' assistant'

  return (
    <div className={`msg${kind}`}>
      {role && (
        <div className="msg-role" title={role}>
          {roleGlyph === 'user' && <span className="msg-role-dot" />}
          {roleGlyph === 'steer' && <span className="msg-role-glyph">↳</span>}
          {roleGlyph && roleGlyph !== 'user' && roleGlyph !== 'steer' && (
            <span className="msg-role-glyph">{roleGlyph}</span>
          )}
          <span className="msg-role-label">{role}</span>
        </div>
      )}
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

  // Reasoning is plain text with no Markdown throttle of its own, so a fast model
  // otherwise dumps tokens straight into the DOM at full rAF rate (~60Hz). Reuse
  // the assistant-text throttle to update the body / peek / scroll at ~10Hz, then
  // snap to the full text the instant streaming stops.
  const shown = useThrottledStreamingSource(block.text, streaming)

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
  }, [streaming, open, shown])

  const toggle = useCallback(() => { manual.current = true; setOpen((o) => !o) }, [])
  const summary = useMemo(() => summarizeThinking(shown), [shown])

  return (
    <div className={`reasoning${open ? ' open' : ''}${streaming ? ' streaming' : ''}`}>
      <div className="reasoning-summary" onClick={toggle}>
        <span className={`reasoning-glyph${streaming ? ' streaming' : ''}`} aria-hidden>{streaming ? '⟳' : '✶'}</span>
        <span className="reasoning-label">{streaming ? '推理中…' : '已推理'}</span>
        {!open && summary && <span className="reasoning-peek">{summary}</span>}
        <span className="reasoning-caret" aria-hidden>{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <div className="reasoning-body" ref={bodyRef}>{shown}</div>
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
