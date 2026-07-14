import { memo, Profiler, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ProfilerOnRenderCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useQueryClient } from '@tanstack/react-query'
import {
  perfBegin,
  beginSessionOpen,
  endSessionOpen,
  isPerfInstrumentationEnabled,
  isSessionOpenInteractiveReady,
  perfEnd,
  perfRecord,
  perfSessionOpenFirstContent,
  perfSessionOpenFirstInteractive,
  type SessionOpenToken,
} from '../state/perf-budget'
import type { ApprovalMode, PlanModeState, AskModeState, SessionRecord } from '../runtime/types'
import type { ConvoBlock, EventViewState } from '../state/event-reducer'
import type { StreamStatus } from '../state/use-session-events'
import { ToolCard, toolNameOf, pairEntries, PairedRow } from '../components/ToolGroup'
import type { PairedEntry } from '../components/ToolGroup'
import { Markdown, closeUnterminatedFence } from '../components/Markdown'
import { splitStableSegments, EMPTY_SEGMENTS, type StreamSegments } from '../lib/stream-segments'
import { Composer } from '../components/Composer'
import { TimelineGroup } from '../components/TimelineGroup'
import { ArtifactCard } from '../components/ArtifactCard'
import { DelegateDialog } from '../components/DelegateDialog'
import { ApprovalInline } from '../components/ApprovalInline'
import { CompletionCurtain } from '../components/CompletionCurtain'
import { RewindOverlay } from '../components/RewindOverlay'
import { FileViewer } from '../components/FileViewer'
import { getFileContent, openFile } from '../runtime/client'
import { openExternal } from '../lib/open-external'
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
import { nextEffortLevel } from '../lib/composer-commands'
import type { ComposerCommand } from '../lib/composer-commands'
import { levelToMode, modeToLevel, type AutonomyLevel } from '../lib/autonomy'
import { loadThemePref, setThemePref } from '../lib/theme'
import type { ThemePref } from '../lib/theme'
import { fetchSessionImageObjectUrl, getRewindPoints, resumeSession, rewindSession } from '../runtime/client'
import { toast } from 'sonner'
import { formatMention } from '../lib/mention-input'
import { useUiState, useUiDispatch } from '../state/store'
import { useHealth } from '../state/queries'
import { usePlanModeShortcut } from '../hooks/use-plan-mode-shortcut'
import { SideChat } from '../components/SideChat'
import { MessageNavigator, type TurnEntry } from '../components/MessageNavigator'
import { QuestionCard } from './QuestionCard'
import { useUserScrollIntent } from './use-scroll-intent.js'
import { STAR_DOMAINS } from '../../../src/agent/star-domain.js'
import type { StarDomainId } from '../../../src/agent/star-domain.js'

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
  onSetAskMode?: (state: AskModeState) => void
  onSetEffort?: (effort: string) => void
  onClose: () => void
  /** D2 — live SSE connection state; drives the "updates stopped" banner. */
  streamStatus?: StreamStatus
  onRetryStream?: () => void
  onToggleDelegation?: (open: boolean) => void
  onApproval?: (decision: 'approve' | 'reject', editedInput?: Record<string, unknown>, remember?: boolean) => void
  sideChatOpen?: boolean
  onToggleSideChat?: () => void
  /** 底部终端面板是否打开；打开时 composer-float 需要抬高，避免被终端遮挡。 */
  terminalVisible?: boolean
  terminalHeight?: number
}) {
  const { session, view, onSend, onSteer, onAbort, onSetApprovalMode, onSetPlanMode, onSetAskMode, onSetEffort, onClose, streamStatus, onRetryStream, onToggleDelegation, onApproval, sideChatOpen = false, onToggleSideChat, terminalVisible = false, terminalHeight = 240 } = props
  const { t } = useTranslation('threadView')
  const sessionOpenToken = useRef<SessionOpenToken | null>(null)
  useLayoutEffect(() => {
    if (!isPerfInstrumentationEnabled()) return
    const token = beginSessionOpen(session.id, {
      hasFoldedEvents: view.lastSeq > 0,
      hasContent: view.blocks.length > 0,
    })
    if (!token) return
    sessionOpenToken.current = token
    return () => {
      endSessionOpen(token)
      if (sessionOpenToken.current?.generation === token.generation) {
        sessionOpenToken.current = null
      }
    }
  }, [session.id])
  useLayoutEffect(() => {
    const token = sessionOpenToken.current
    if (token && view.blocks.length > 0) perfSessionOpenFirstContent(token)
  }, [session.id, view.blocks.length])
  const ui = useUiState()
  const dispatch = useUiDispatch()
  // Busy-vs-dropped attribution: /health reports the sidecar's event-loop lag.
  // A ≥1s stall in the last poll window means the loop was starved by a
  // synchronous operation — the likely cause of the stream hiccup — so the
  // banner says "service busy" instead of a phantom "connection interrupted".
  const health = useHealth()
  const sidecarBusy = (health.data?.loopLagMaxMs ?? 0) >= 1000
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
  // Global Shift+Tab → Plan/Agent toggle (Cursor parity). The composer handles
  // its own Shift+Tab; this covers the rest of the thread surface.
  const togglePlanMode = useCallback(() => {
    onSetPlanMode?.(view.planMode === 'planning' ? 'off' : 'planning')
  }, [onSetPlanMode, view.planMode])
  usePlanModeShortcut(onSetPlanMode ? togglePlanMode : undefined)
  const qc = useQueryClient()
  const [showRewind, setShowRewind] = useState(false)
  const [showDelegateDialog, setShowDelegateDialog] = useState(false)
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)
  const [summaryDismissed, setSummaryDismissed] = useState(false)
  useEffect(() => {
    setSummaryDismissed(false)
  }, [session.id])
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
        onToggleSideChat?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onToggleSideChat])
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
  const scrollRafRef = useRef<ReturnType<typeof requestAnimationFrame> | null>(null)
  const pendingScrollRef = useRef<{ scrollTop: number; near: boolean }>({ scrollTop: 0, near: false })

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

  // Phase 3 可靠性 — 一键续跑卡片（resume_offer）。服务端强制模型/星域缓存
  // 亲和：原模型不可用且无兜底配置时 409 fail-closed，卡片降级为开新会话提示。
  const [resumePending, setResumePending] = useState(false)
  const [resumeError, setResumeError] = useState<string | null>(null)
  const [resumeDismissedSeq, setResumeDismissedSeq] = useState<number | null>(null)
  const handleResume = useCallback(async () => {
    setResumePending(true)
    setResumeError(null)
    try {
      const res = await resumeSession(session.id)
      if (res.switched) {
        toast.warning(t('resume.switchedToast', { model: res.model }))
      }
    } catch (err) {
      setResumeError((err as Error)?.message ?? String(err))
    } finally {
      setResumePending(false)
    }
  }, [session.id, t])

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
    const _t = perfBegin('filteredBlocks')
    const blocks = view.blocks
    const result = selectedTurnIndex === -1 || selectedTurnIndex >= rewindPoints.length
      ? blocks
      : (() => {
          const point = rewindPoints[selectedTurnIndex]
          if (!point) return blocks
          if (typeof point.seq === 'number') {
            const cutIdx = blocks.findIndex((b) => b.kind === 'user' && b.key === `u-${point.seq}`)
            if (cutIdx >= 0) return blocks.slice(0, cutIdx)
          }
          let userBlockCount = 0
          for (let i = 0; i < blocks.length; i++) {
            if (blocks[i]?.kind === 'user') {
              if (userBlockCount === selectedTurnIndex) return blocks.slice(0, i)
              userBlockCount++
            }
          }
          return blocks
        })()
    perfEnd('filteredBlocks', _t)
    return result
  }, [view.blocks, selectedTurnIndex, rewindPoints])

  // P1-2 view mode: summary keeps only conversational text (user/assistant/
  // error/turn separators) — tool runs and thinking are dropped before grouping.
  const viewMode = ui.viewMode
  const modeBlocks = useMemo(() => {
    const _t = perfBegin('modeBlocks')
    const result = viewMode !== 'summary' ? filteredBlocks : filteredBlocks.filter((b) =>
      b.kind === 'user' || b.kind === 'assistant' || b.kind === 'error' || b.kind === 'turn' || b.kind === 'steer' || b.kind === 'landing',
    )
    perfEnd('modeBlocks', _t)
    return result
  }, [filteredBlocks, viewMode])

  const rendered = useMemo(() => {
    const _t = perfBegin('groupBlocks')
    const result = groupBlocks(modeBlocks)
    perfEnd('groupBlocks', _t)
    return result
  }, [modeBlocks, view.blocksRev])
  const renderedWithTurns = useMemo(() => {
    let tNum = 1
    return rendered.map((item) => {
      if (item.kind === 'block' && item.block.kind === 'turn') {
        tNum = item.block.turn?.turnNumber ?? tNum
      }
      return { ...item, turnNumber: tNum }
    })
  }, [rendered])
  const lastKey = view.blocks[view.blocks.length - 1]?.key

  // Wave 4 — throttle the remeasure of the actively-growing LAST row while the
  // user is pinned to the bottom mid-stream. Every ResizeObserver fire on the
  // growing row otherwise triggers a full virtualizer remeasure + layout at
  // stream cadence; while bottom-pinned the exact height is irrelevant (the
  // 10Hz scroll throttle below re-aligns anyway), so a slightly stale height
  // for ≤100ms is invisible. Off-stream / scrolled-up rows measure exactly.
  const MEASURE_THROTTLE_MS = 100
  const lastRowMeasureRef = useRef<{ at: number; height: number } | null>(null)
  const measureCtxRef = useRef({ streaming: false, lastIndex: -1, pinned: false })
  measureCtxRef.current = {
    streaming: view.status === 'running',
    lastIndex: renderedWithTurns.length - 1,
    pinned: !scrolledUp,
  }

  // P2 — only render the visible window of the message list. Long sessions keep
  // DOM at O(viewport) instead of O(messages). Item heights vary, so rows are
  // measured dynamically via measureElement (ResizeObserver under the hood).
  const virtualizer = useVirtualizer({
    count: renderedWithTurns.length,
    getScrollElement: () => msgRef.current,
    estimateSize: () => 80,
    // W2-5: drop overscan to 2 while streaming + bottom-pinned — the user only
    // sees the tail, so pre-rendering 8 rows ahead wastes layout/paint. Restore
    // 8 when settled or scrolled up (exploring the history).
    overscan: view.status === 'running' && !scrolledUp ? 2 : 8,
    getItemKey: (index) => {
      const item = renderedWithTurns[index]!
      return item.kind === 'timeline' ? item.key : item.block.key
    },
    measureElement: (el, entry) => {
      const height = entry?.borderBoxSize?.[0]?.blockSize ?? el.getBoundingClientRect().height
      const ctx = measureCtxRef.current
      const idx = Number((el as HTMLElement).dataset.index)
      if (ctx.streaming && ctx.pinned && idx === ctx.lastIndex) {
        const now = performance.now()
        const cached = lastRowMeasureRef.current
        if (cached && now - cached.at < MEASURE_THROTTLE_MS) return cached.height
        lastRowMeasureRef.current = { at: now, height }
      } else if (idx === ctx.lastIndex) {
        // Stream settled or user scrolled up — drop the cache so the final
        // height lands exactly.
        lastRowMeasureRef.current = null
      }
      return height
    },
  })

  useEffect(() => {
    const el = msgRef.current
    if (!el) return
    let prevWidth = el.clientWidth
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width
        if (width > 0 && width !== prevWidth) {
          prevWidth = width
          // Container width changed (e.g. window resize, sidebar toggle).
          // Remeasure all virtualized items to update their heights and positions.
          virtualizer.measure()
        }
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [virtualizer])

  useLayoutEffect(() => {
    if (!isPerfInstrumentationEnabled()) return
    const token = sessionOpenToken.current
    if (!token) return
    const readiness = () => isSessionOpenInteractiveReady({
      hasContent: view.blocks.length > 0,
      virtualItemCount: virtualizer.getVirtualItems().length,
      hasScrollContainer: msgRef.current !== null,
      hasComposer: composerWrapRef.current !== null,
    })
    if (!readiness()) return
    const frame = requestAnimationFrame(() => {
      if (
        sessionOpenToken.current?.generation === token.generation &&
        readiness()
      ) {
        perfSessionOpenFirstInteractive(token)
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [
    composerHeight,
    renderedWithTurns.length,
    session.id,
    view.blocks.length,
    view.blocksRev,
    virtualizer,
  ])

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
  // Synchronous user-intent flag: set the instant the wheel scrolls up, before
  // React commits the scrolledUp state. This closes a race where a streaming
  // token batch triggers the auto-scroll effect in the same frame as the wheel
  // event — the effect reads a stale scrolledUp=false and yanks the view back
  // to the bottom, making the wheel feel dead.
  const scrollIntent = useUserScrollIntent()
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastScrollAtRef = useRef(0)
  useEffect(() => () => {
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current)
    if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current)
  }, [])
  useEffect(() => {
    if (scrolledUp || rendered.length === 0) return
    const SCROLL_THROTTLE_MS = 100
    const run = () => {
      scrollTimerRef.current = null
      if (scrolledUpRef.current || scrollIntent.userIntentUpRef.current) return // user scrolled up while the tick was pending
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
    const el = msgRef.current
    const scrollTop = el?.scrollTop ?? 0
    const near = isNearBottom()
    scrollIntent.onScroll(scrollTop, near)
    setScrolledUp(!near)
    // Navigator marker and persisted scroll position only need frame-rate updates;
    // batch them via rAF to avoid a React render / reducer dispatch on every wheel
    // pixel and reduce jank while scrolling through long history.
    pendingScrollRef.current = { scrollTop, near }
    if (scrollRafRef.current === null) {
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null
        const { scrollTop: st } = pendingScrollRef.current
        setNavTick((t) => t + 1) // refresh navigator "current" marker
        if (el) dispatch({ type: 'setScrollPosition', sessionId: session.id, scrollTop: st })
      })
    }
  }, [isNearBottom, dispatch, session.id, scrollIntent])

  // Wheel intent: set synchronously so the auto-scroll effect (which may run
  // in the same frame) sees the user's upward intent immediately. Cleared by
  // onScroll once the user returns near the bottom.
  const onWheel = useCallback((e: React.WheelEvent) => {
    scrollIntent.onWheel(e, msgRef.current?.scrollTop ?? 0)
  }, [scrollIntent])

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
    scrollIntent.clearIntent()
    setScrolledUp(false)
  }, [rendered.length, virtualizer, scrollIntent])

  // Keyboard navigation: j/k or ↑/↓ to jump between message blocks.
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null)
  const onMessagesKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Only handle when focus is on the messages container itself (not in input).
    const el = document.activeElement
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable)) return
    // Native scroll-up keys (PageUp, Home, ArrowUp) move the view upward without
    // firing onWheel; capture intent synchronously so streaming auto-scroll does
    // not yank the view back down in the same frame.
    const isNativeScrollUp = (e.key === 'PageUp' || e.key === 'Home' || e.key === 'ArrowUp') && !e.altKey
    if (isNativeScrollUp) {
      scrollIntent.onKeyDown(e)
      return
    }
    const isNav = e.key === 'j' || e.key === 'k' || (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp'))
    if (!isNav) return
    e.preventDefault()
    const dir = e.key === 'j' || e.key === 'ArrowDown' ? 1 : -1
    setFocusedIndex((prev) => {
      const next = prev == null ? (dir > 0 ? 0 : rendered.length - 1) : Math.max(0, Math.min(rendered.length - 1, prev + dir))
      virtualizer.scrollToIndex(next, { align: 'center' })
      return next
    })
  }, [rendered.length, virtualizer, scrollIntent])

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

  // ── In-thread search (Cmd+F) — block-level match + jump ──
  // Matches are rendered-list indices (valid scrollToIndex targets). Text-level
  // highlighting inside Markdown is intentionally out of scope; the active hit
  // row gets a highlight class instead.
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchPos, setSearchPos] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const searchMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return []
    const out: number[] = []
    rendered.forEach((item, i) => {
      if (item.kind === 'block') {
        const b = item.block
        if ((b.kind === 'user' || b.kind === 'assistant') && b.text.toLowerCase().includes(q)) out.push(i)
      } else if (item.kind === 'timeline') {
        // Tool/thinking hits count toward the collapsed group's row.
        if (item.items.some((b) => (b.text ?? '').toLowerCase().includes(q))) out.push(i)
      }
    })
    return out
  }, [rendered, searchQuery])

  const jumpToMatch = useCallback((pos: number) => {
    const idx = searchMatches[pos]
    if (idx === undefined) return
    setScrolledUp(true)
    virtualizer.scrollToIndex(idx, { align: 'center' })
    requestAnimationFrame(() => virtualizer.scrollToIndex(idx, { align: 'center' }))
  }, [searchMatches, virtualizer])

  // New query → reset to the first hit and jump there.
  useEffect(() => {
    setSearchPos(0)
    if (searchQuery.trim() && searchMatches.length > 0) jumpToMatch(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery])

  const stepSearch = useCallback((dir: 1 | -1) => {
    const n = searchMatches.length
    if (n === 0) return
    const next = ((searchPos + dir) % n + n) % n
    setSearchPos(next)
    jumpToMatch(next)
  }, [searchMatches.length, searchPos, jumpToMatch])

  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setSearchQuery('')
    msgRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault() // pre-empt the WebView native find
        setSearchOpen(true)
        requestAnimationFrame(() => searchInputRef.current?.focus())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const activeSearchIndex = searchOpen && searchMatches.length > 0 ? searchMatches[searchPos] ?? null : null

  // Regenerate an assistant reply: find the nearest preceding user turn and
  // replay it through the same rewind+resend chain as message editing.
  const handleRegenerate = useCallback(async (assistantKey: string) => {
    const blocks = view.blocks
    const idx = blocks.findIndex((b) => b.key === assistantKey)
    if (idx < 0) return
    for (let i = idx - 1; i >= 0; i--) {
      const b = blocks[i]!
      if (b.kind !== 'user') continue
      const seq = Number(b.key.slice(2)) // "u-<seq>"
      const point = Number.isNaN(seq) ? undefined : rewindPoints.find((p) => p.seq === seq)
      if (!point) return
      try {
        await rewindSession(session.id, point.index)
        setSelectedTurnIndex(-1)
        const { points } = await getRewindPoints(session.id)
        setRewindPoints(points)
        onSend(b.text)
      } catch (err) {
        console.error(err)
      }
      return
    }
  }, [view.blocks, rewindPoints, session.id, onSend])

  const showThinking = busy && !view.private_textOpen && !view.private_thinkingOpen

  // Context increment: delta between last and previous turn totals.
  const ctxDelta = useMemo(() => {
    if (view.prevTotalTokens <= 0 || view.lastTotalTokens <= view.prevTotalTokens) return 0
    return view.lastTotalTokens - view.prevTotalTokens
  }, [view.lastTotalTokens, view.prevTotalTokens])

  // W2-2: stabilize contextUsage so Composer's memo isn't busted by a new
  // object literal every render.
  const contextUsageMemo = useMemo(() => ({
    usedTokens: session.contextTokens ?? view.lastTotalTokens,
    contextWindow: session.contextWindow,
    cacheReadTokens: view.cacheReadTokens,
    cacheCreationTokens: view.cacheCreationTokens,
    deltaTokens: ctxDelta,
  }), [session.contextTokens, session.contextWindow, view.lastTotalTokens, view.cacheReadTokens, view.cacheCreationTokens, ctxDelta])

  // W2-2 收束: Composer is a memo component — every callback prop must be
  // reference-stable, or a single inline arrow busts the shallow compare and
  // Composer re-renders on every streaming batch anyway.
  const handleSetApprovalLevel = useCallback(
    (lvl: AutonomyLevel) => onSetApprovalMode(levelToMode(lvl)),
    [onSetApprovalMode],
  )
  const handleComposerSubmit = useCallback(async (text: string, images?: string[]) => {
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
  }, [selectedTurnIndex, rewindPoints, session.id, busy, onSteer, onSend])
  const handleDoubleEscape = useCallback(() => setShowRewind(true), [])
  const handleDelegate = useCallback(() => setShowDelegateDialog(true), [])
  const handleWorkflow = useCallback((cmd: string) => {
    // 带上引导 prompt——让 agent 进入对应工作流模式并询问用户具体目标。
    const label = cmd === '/council' ? t('workflow.council') : t('workflow.team')
    onSend(t('workflow.prompt', { cmd, label }))
  }, [onSend, t])
  const handleHistoryPrev = useCallback(() => recallHistory('prev'), [recallHistory])
  const handleHistoryNext = useCallback(() => recallHistory('next'), [recallHistory])

  // D3 — composer slash commands: desktop-actionable items + prompt pass-throughs.
  const commands = useMemo<ComposerCommand[]>(() => [
    { name: '/rewind', desc: t('commands.rewind'), run: () => setShowRewind(true) },
    { name: '/subagents', desc: t('commands.subagents'), run: () => onToggleDelegation?.(true) },
    { name: '/supervise', desc: t('commands.supervise'), run: () => onSetApprovalMode(levelToMode('supervised')) },
    { name: '/default', desc: t('commands.default'), run: () => onSetApprovalMode(levelToMode('default')) },
    { name: '/autonomous', desc: t('commands.autonomous'), run: () => onSetApprovalMode(levelToMode('autonomous')) },
    {
      name: '/review',
      desc: t('commands.review'),
      example: t('commands.reviewExample'),
      // Raw slash → server resolveAppPromptInput translates (single source of truth).
      run: () => onSend('/review'),
    },
    {
      name: '/review max',
      desc: t('commands.reviewMax'),
      example: t('commands.reviewMaxExample'),
      run: () => onSend('/review max'),
    },
    {
      name: '/theme',
      desc: t('commands.theme'),
      run: () => {
        const order: ThemePref[] = ['system', 'light', 'dark', 'nebula', 'sakura', 'cyberpunk', 'cupertino', 'light-classic']
        const cur = loadThemePref()
        setThemePref(order[(order.indexOf(cur) + 1) % order.length]!)
      },
    },
    {
      name: '/plan',
      desc: t('commands.plan'),
      example: t('commands.planExample'),
      // 只切模式，不烧一轮对话——plan mode 的系统提示已经写明职责，
      // 用户接着输入的任务描述才是第一轮（省一次 API 往返 + 缓存零扰动）。
      run: () => {
        if (onSetPlanMode && view.planMode !== 'planning') {
          onSetPlanMode('planning')
        }
      },
    },
    {
      name: '/ask',
      desc: t('commands.ask', { defaultValue: 'Enter Ask mode (read-only Q&A)' }),
      run: () => {
        if (onSetAskMode && view.askMode !== 'asking') {
          onSetAskMode('asking')
        } else if (onSetAskMode && view.askMode === 'asking') {
          onSetAskMode('off')
        }
      },
    },
    {
      name: '/write-plan',
      desc: t('commands.writePlan'),
      example: t('commands.writePlanExample'),
      // Needs args — prefill the composer instead of firing a bare command.
      run: () => setInput('/write-plan '),
    },
    {
      name: '/plan-close',
      desc: t('commands.planClose'),
      example: t('commands.planCloseExample'),
      run: () => setInput('/plan-close '),
    },
    {
      name: '/team',
      desc: t('commands.team'),
      example: t('commands.teamExample'),
      run: () => onSend('/team'),
    },
    {
      name: '/interview',
      desc: t('commands.interview'),
      run: () => onSend('Run a deep technical interview before implementing. Ask me 3-5 clarifying questions about requirements, constraints, and edge cases.'),
    },
    {
      name: '/compact',
      desc: t('commands.compact'),
      run: () => onSend('Context is getting long. Please compact the conversation: summarize tool outputs, collapse resolved discussions, and trim stale context while preserving key decisions and active work state.'),
    },
    {
      name: '/memory',
      desc: t('commands.memory'),
      run: () => onSend('Show the current session memory overview: session entries, project pheromones, and project knowledge files.'),
    },
    {
      name: '/context',
      desc: t('commands.context'),
      run: () => onSend('Show context ledger status: token usage, compaction state, cache hit rate, and pinned anchors.'),
    },
    {
      name: '/verify',
      desc: t('commands.verify'),
      run: () => onSend('Show verification status for all modified files in this session: which are verified, which are pending, and the last verification result.'),
    },
    {
      name: '/mission',
      desc: t('commands.mission'),
      run: () => onSend('Show the current task contract: objective, scope, acceptance criteria, and delivery status.'),
    },
    {
      name: '/debug cache',
      desc: t('commands.debugCache'),
      run: () => onSend('Show cache debug info: hit rate, read/write tokens, estimated context size, and cost.'),
    },
    {
      name: '/constellation',
      desc: t('commands.constellation'),
      run: () => onSend('Show the project constellation: architecture overview, milestones, and recent activity.'),
    },
    {
      name: '/dream',
      desc: t('commands.dream'),
      run: () => onSend('Show dream / memory distillation status: how many curated memories exist, when the last distillation ran.'),
    },
    {
      name: '/sensorium',
      desc: t('commands.sensorium'),
      run: () => onSend('Show the cognitive sensorium state: task status, verification gaps, delivery readiness, and active signals.'),
    },
    {
      name: '/council',
      desc: t('commands.council'),
      example: t('commands.councilExample'),
      run: () => onSend('/council'),
    },
    // C4 — /goal & /cancel-goal 已移除：sidecar 从不创建 GoalTracker，这两个
    // 快捷命令只是把一段假承诺文案发给模型（「跨 turn 自主执行直到达成」不成立）。
    // 真正的 sidecar goal 接线（含暂停/取消按钮）另立项。
    {
      name: '/effort',
      desc: t('commands.effort'),
      // Cycle through effort levels like /theme cycles themes; calls the server
      // endpoint so the change takes effect on the next turn (no prompt run).
      run: () => onSetEffort?.(nextEffortLevel(session.reasoningEffort)),
    },
    {
      name: '/model',
      desc: t('commands.model'),
      run: () => onSend('Show available models for switching.'),
    },
    {
      name: '/domain',
      desc: t('commands.domain'),
      run: () => onSend('Show available star domains for switching.'),
    },
    {
      name: '/todo',
      desc: t('commands.todo'),
      run: () => onSend('Show current todo list. Use /todo add/done/skip/move to manage tasks.'),
    },
    {
      name: '/undo',
      desc: t('commands.undo'),
      run: () => onSend('Undo the last file change. Use /undo preview N to preview before undoing.'),
    },
    {
      name: '/rollback',
      desc: t('commands.rollback'),
      run: () => onSend('Rollback recent file changes.'),
    },
    {
      name: '/workflow',
      desc: t('commands.workflow'),
      run: () => onSend('Show available workflows from .rivet/workflows/*.yaml.'),
    },
    {
      name: '/plan-template',
      desc: t('commands.planTemplate'),
      run: () => onSend('Show available plan templates from .rivet/plan-templates/*.md.'),
    },
    {
      name: '/team-resume',
      desc: t('commands.teamResume'),
      run: () => onSend('Show available team checkpoints for resume.'),
    },
    {
      name: '/fork',
      desc: t('commands.fork'),
      run: () => onSend('Fork the current session into a new branch.'),
    },
    {
      name: '/branch',
      desc: t('commands.branch'),
      run: () => onSend('Show the session branch tree: parent and child sessions.'),
    },
    {
      name: '/sessions',
      desc: t('commands.sessions'),
      run: () => onSend('List all saved sessions.'),
    },
    {
      name: '/skill',
      desc: t('commands.skill'),
      run: () => onSend('Show available skills.'),
    },
    {
      name: '/evidence',
      desc: t('commands.evidence'),
      run: () => onSend('Show evidence summary: last 10 verifications and pass rate.'),
    },
    {
      name: '/status',
      desc: t('commands.status'),
      run: () => onSend('Show agent status: model, domain, cache hit rate, token usage, cost.'),
    },
    {
      name: '/mcp',
      desc: t('commands.mcp'),
      run: () => onSend('Show MCP server connection status.'),
    },
    {
      name: '/leave',
      desc: t('commands.leave'),
      run: () => onSend('Leave a mark in the starmap summarizing this session.'),
    },
    {
      name: '/diagram',
      desc: t('commands.diagram'),
      run: () => onSend('Generate a mermaid diagram skeleton. Types: architecture, dataflow, sequence, flowchart, comparison, state.'),
    },
  ], [onSetApprovalMode, onSend, onSetPlanMode, onSetAskMode, view.planMode, view.askMode, t])

  // Lookup map for welcome cards/pills to call the actual slash command
  // run() instead of sending raw text to the model.
  const runCommand = useMemo(() => {
    const m = new Map<string, () => void>()
    for (const c of commands) m.set(c.name, c.run)
    return (name: string) => m.get(name)?.()
  }, [commands])

  return (
    <div className={`thread domain-${activeDomainId}`} data-separator={domainSeparator} style={{ paddingBottom: composerHeight + (terminalVisible ? terminalHeight : 0) }}>
      {rewindPoints.length > 0 && (
        <div className="thread-timeline-slider-container px-4 py-2 border-b border-border bg-panel-2 flex items-center gap-3 shrink-0">
          <span className="text-xs text-muted font-medium flex items-center gap-1 shrink-0">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            {t('timeTravel.label')}
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
          <span className="text-xs font-mono text-muted bg-panel-3 px-1.5 py-0.5 rounded border border-border max-w-[220px] truncate shrink-0" title={selectedTurnIndex >= 0 && selectedTurnIndex < rewindPoints.length ? t('timeTravel.forkPointTitle', { turn: selectedTurnIndex + 1, content: rewindPoints[selectedTurnIndex]?.content }) : t('timeTravel.latestTitle')}>
            {selectedTurnIndex === -1 || selectedTurnIndex >= rewindPoints.length ? (
              t('timeTravel.latest')
            ) : (
              t('timeTravel.beforeTurn', { turn: selectedTurnIndex + 1 })
            )}
          </span>
        </div>
      )}

      <div className="messages" ref={msgRef} onScroll={onScroll} onWheel={onWheel} onKeyDown={onMessagesKeyDown} tabIndex={-1}>
        {searchOpen && (
          <div className="thread-search-bar" role="search">
            <input
              ref={searchInputRef}
              className="thread-search-input"
              type="text"
              value={searchQuery}
              placeholder={t('search.placeholder')}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  stepSearch(e.shiftKey ? -1 : 1)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  closeSearch()
                }
              }}
            />
            <span className="thread-search-count">
              {searchQuery.trim()
                ? (searchMatches.length > 0 ? `${searchPos + 1}/${searchMatches.length}` : t('search.noMatch'))
                : ''}
            </span>
            <button
              className="thread-search-btn"
              onClick={() => stepSearch(-1)}
              disabled={searchMatches.length === 0}
              aria-label={t('search.prev')}
            >↑</button>
            <button
              className="thread-search-btn"
              onClick={() => stepSearch(1)}
              disabled={searchMatches.length === 0}
              aria-label={t('search.next')}
            >↓</button>
            <button
              className="thread-search-btn"
              onClick={closeSearch}
              aria-label={t('search.close')}
            >×</button>
          </div>
        )}
        {streamStatus === 'offline' && (
          <div className="stream-banner offline" role="alert">
            <span className="stream-banner-glyph" aria-hidden>⚠</span>
            <span className="stream-banner-text">{t('stream.offline')}</span>
            <button
              className="stream-banner-retry"
              onClick={() => onRetryStream?.()}
              aria-label={t('stream.retryAria')}
            >
              {t('stream.retry')}
            </button>
          </div>
        )}
        {streamStatus === 'reconnecting' && (
          <div className="stream-banner reconnecting" role="status">
            <span className="stream-banner-glyph spin" aria-hidden>⟳</span>
            <span className="stream-banner-text">
              {sidecarBusy ? t('stream.busy') : t('stream.reconnecting')}
            </span>
          </div>
        )}
        {view.blocks.length === 0 && (
          <div className="empty welcome">
            <p className="welcome-title">{t('welcome.title')}</p>
            <p className="welcome-hint">{t('welcome.hint')}</p>
            <div className="welcome-pills">
              <span className="welcome-pill" onClick={() => runCommand('/plan')}>{t('welcome.plan')}</span>
              <span className="welcome-pill" onClick={() => runCommand('/review')}>{t('welcome.review')}</span>
              <span className="welcome-pill" onClick={() => runCommand('/autonomous')}>{t('welcome.autonomous')}</span>
              <span className="welcome-pill" onClick={() => runCommand('/team')}>{t('welcome.team')}</span>
              <span className="welcome-pill" onClick={() => runCommand('/context')}>{t('welcome.context')}</span>
            </div>
          </div>
        )}
        {renderedWithTurns.length > 0 && (
          <div className="vlist" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const item = renderedWithTurns[vi.index]!
              return (
                <div
                  key={vi.key}
                  className={`vrow${focusedIndex === vi.index ? ' vrow-focused' : ''}${activeSearchIndex === vi.index ? ' vrow-search-active' : ''}`}
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
                      onRegenerate={busy ? undefined : handleRegenerate}
                      onEditUserMsg={async (seq, text) => {
                        const point = rewindPoints.find(p => p.seq === seq)
                        if (point) {
                          try {
                            await rewindSession(session.id, point.index)
                            setSelectedTurnIndex(-1)
                            const { points } = await getRewindPoints(session.id)
                            setRewindPoints(points)
                            onSend(text)
                          } catch (err) {
                            console.error(err)
                          }
                        }
                      }}
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
        {scrolledUp && (
          <button className="scroll-bottom-btn" onClick={scrollToBottom} aria-label={t('scrollToBottom')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        )}
        <MessageNavigator turns={userTurns} activeIndex={navActiveIndex} onJump={jumpTo} />
      </div>

      {session.status === 'completed' && view.completionSummary && !summaryDismissed && (() => {
        // 显示条件：有 todo（无论是否全部完成）、有文件改动、或有验证记录。
        // 之前要求 allTodosDone 才显示——agent 不用 todo 就永远看不到总结。
        const hasTodos = view.todos.length > 0
        const hasFileChanges = (view.completionSummary.filesModified?.length ?? 0) > 0
        const hasReads = (view.completionSummary.filesRead?.length ?? 0) > 0
        const hasVerifications = (view.completionSummary.verifications?.length ?? 0) > 0
        if (!hasTodos && !hasFileChanges && !hasReads && !hasVerifications) return null
        return <CompletionCurtain summary={view.completionSummary} onDismiss={() => setSummaryDismissed(true)} />
      })()}

      <div className="composer-float" ref={composerWrapRef}>
        <div className={`composer-float-inner accent-${activeDomain?.uiPersona.accent ?? 'primary'}`}>
          {showThinking && (
            <div className="thinking">
              <span className="dot-pulse" /><span className="dot-pulse" /><span className="dot-pulse" />
              <span className="thinking-label">
                {view.phase ? t('thinking.withPhase', { phase: view.phase }) : t('thinking.label')}
                {elapsedStr && <span className={`elapsed${elapsedStalled ? ' stalled' : ''}`}> · {elapsedStr}</span>}
              </span>
            </div>
          )}
          {view.resumeOffer && view.resumeOffer.seq !== resumeDismissedSeq && !busy && (
            <div className="resume-offer-banner flex items-center justify-between bg-panel-3 border border-border rounded-lg p-3 mb-2 text-xs" role="status">
              <div className="flex flex-col gap-1 min-w-0">
                <span className="font-medium text-text">{t('resume.title')}</span>
                <span className="text-muted truncate">
                  {view.resumeOffer.model
                    ? t('resume.detail', { model: view.resumeOffer.model, domain: view.resumeOffer.domain })
                    : t('resume.detailNoModel', { domain: view.resumeOffer.domain })}
                </span>
                {resumeError && (
                  <span className="text-warning">
                    {resumeError} — {t('resume.newSessionHint')}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0 ml-3">
                <button
                  className="px-2.5 py-1 rounded bg-primary text-white hover:bg-primary/90 transition-colors font-medium disabled:opacity-60"
                  onClick={handleResume}
                  disabled={resumePending}
                >
                  {resumePending ? t('resume.pending') : t('resume.button')}
                </button>
                <button
                  className="px-2.5 py-1 rounded bg-panel-2 hover:bg-panel-1 border border-border text-text transition-colors"
                  onClick={() => setResumeDismissedSeq(view.resumeOffer!.seq)}
                  aria-label={t('resume.dismiss')}
                >
                  ×
                </button>
              </div>
            </div>
          )}
          {view.pendingApproval && onApproval && (
            <ApprovalInline
              request={view.pendingApproval}
              onDecision={onApproval}
            />
          )}
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
                  {t('timeTravel.historicalBanner', { turn: selectedTurnIndex + 1, shown: selectedTurnIndex })}
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
                  {t('timeTravel.forkHere')}
                </button>
                <button
                  className="px-2.5 py-1 rounded bg-panel-3 hover:bg-panel-2 border border-border text-text transition-colors"
                  onClick={() => setSelectedTurnIndex(-1)}
                >
                  {t('timeTravel.backToLatest')}
                </button>
              </div>
            </div>
          )}
          <Composer
            sessionId={session.id}
            cwd={session.cwd}
            value={input}
            onChange={setInput}
            busy={busy}
            threadNonEmpty={view.blocks.length > 0}
            activeDomainAccent={activeDomain?.uiPersona.accent ?? 'primary'}
            approvalLevel={modeToLevel(session.approvalMode)}
            onSetApprovalLevel={handleSetApprovalLevel}
            // W2-2: stabilize the contextUsage object reference so Composer's
            // React.memo won't see a "new" prop every ThreadView render.
            contextUsage={contextUsageMemo}
            onSubmit={handleComposerSubmit}
            onAbort={onAbort}
            onDoubleEscape={handleDoubleEscape}
            commands={commands}
            planMode={view.planMode}
            onSetPlanMode={onSetPlanMode}
            askMode={view.askMode}
            onSetAskMode={onSetAskMode}
            effort={session.reasoningEffort}
            onSetEffort={onSetEffort}
            onDelegate={handleDelegate}
            onWorkflow={handleWorkflow}
            menuRev={view.menuRev}
            onHistoryPrev={handleHistoryPrev}
            onHistoryNext={handleHistoryNext}
          />
        </div>
      </div>
      {showDelegateDialog && (
        <DelegateDialog
          sessionId={session.id}
          onClose={() => setShowDelegateDialog(false)}
          onDispatched={() => onToggleDelegation?.(true)}
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
        onClose={() => onToggleSideChat?.()}
        mainTitle={session.title ?? session.id.slice(0, 8)}
        cwd={session.cwd}
        mainBlocks={view.blocks}
      />

      {fileViewer && (
        <div className="file-viewer-drawer" role="complementary" aria-label={t('fileViewer.aria')}>
          <div className="file-viewer-head">
            <span className="file-viewer-title" title={fileViewer.path}>
              {fileViewer.path.replace(/.*[/\\]/, '') || fileViewer.path}
            </span>
            <button
              className="icon-btn"
              title={t('fileViewer.openInEditor')}
              aria-label={t('fileViewer.openInEditor')}
              onClick={() => void openFile(fileViewer.path)}
            >↗</button>
            <button
              className="icon-btn"
              title={t('fileViewer.close')}
              aria-label={t('fileViewer.close')}
              onClick={() => setFileViewer(null)}
            >✕</button>
          </div>
          <div className="file-viewer-body">
            {fileViewer.loading && <div className="file-viewer-loading">{t('fileViewer.loading')}</div>}
            {fileViewer.error && <div className="file-viewer-error">{t('fileViewer.loadFailed', { error: fileViewer.error })}</div>}
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
            <AlertDialogTitle>{t('closeConfirm.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('closeConfirm.desc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('closeConfirm.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={onClose}>{t('closeConfirm.confirm')}</AlertDialogAction>
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
  const { t } = useTranslation('threadView')
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
  if (failed) return <span className="msg-thumb-fail" title={t('image.loadFailedTitle')}>{t('image.loadFailed')}</span>
  if (!url) return <span className="msg-thumb-skeleton" aria-hidden />
  return (
    <img className="msg-thumb" src={url} alt={t('image.alt', { index: index + 1 })} loading="lazy"
      onClick={() => onOpen?.(url)} />
  )
}

/** Full-size image overlay. Click anywhere or press Esc to close. */
function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  const { t } = useTranslation('threadView')
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="lightbox" onClick={onClose} role="dialog" aria-modal="true">
      <img className="lightbox-img" src={src} alt={t('image.imageAlt')} onClick={(e) => e.stopPropagation()} />
      <button className="lightbox-close" onClick={onClose} aria-label={t('image.close')}>×</button>
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
      b.kind === 'landing' ||
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
  a.onContinue === b.onContinue && a.onCancelContinue === b.onCancelContinue &&
  a.onEditUserMsg === b.onEditUserMsg && a.onRegenerate === b.onRegenerate
)

function BlockImpl({ block, isStreaming, sessionId, onOpenImage, onFileClick, domainGlyph, domainName, onContinue, onCancelContinue, onEditUserMsg, onRegenerate }: {
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
  onEditUserMsg?: (seq: number, text: string) => Promise<void>
  /** Regenerate this assistant reply (rewind to the preceding user turn + resend). */
  onRegenerate?: (assistantKey: string) => void
}) {
  const { t } = useTranslation('threadView')
  const [isEditing, setIsEditing] = useState(false)
  const [editText, setEditText] = useState(block.text)

  if (block.kind === 'user') {
    const seq = Number(block.key.slice(2))
    const canEdit = !!onEditUserMsg && !isNaN(seq)

    if (isEditing) {
      return (
        <MsgBlock role={t('block.you')} roleGlyph="user" className="user editing">
          <div className="user-edit-container">
            <textarea
              className="user-edit-textarea"
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              rows={Math.min(10, editText.split('\n').length || 1)}
            />
            <div className="user-edit-actions">
              <button
                className="btn-sm btn-primary user-edit-submit"
                onClick={async () => {
                  if (editText.trim()) {
                    await onEditUserMsg?.(seq, editText)
                    setIsEditing(false)
                  }
                }}
              >
                {t('block.saveResend')}
              </button>
              <button
                className="btn-sm btn-secondary user-edit-cancel"
                onClick={() => {
                  setIsEditing(false)
                  setEditText(block.text)
                }}
              >
                {t('block.cancel')}
              </button>
            </div>
          </div>
        </MsgBlock>
      )
    }

    return (
      <MsgBlock
        role={t('block.you')}
        roleGlyph="user"
        canEdit={canEdit}
        onEdit={() => setIsEditing(true)}
      >
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
              <img key={i} className="msg-thumb" src={src} alt={t('image.alt', { index: i + 1 })}
                onClick={() => onOpenImage?.(src)} />
            ))}
          </div>
        ) : block.imageCount && block.imageCount > 0 ? (
          <div className="msg-images">{t('block.imageCount', { count: block.imageCount })}</div>
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
    return null
  }
  if (block.kind === 'checkpoint') {
    return (
      <div className="checkpoint-chip" title={t('block.checkpointTitle')}>
        <span className="cp-glyph" aria-hidden>⎌</span>
        {t('block.checkpointLabel')} · {(block.hash ?? '').slice(0, 8)}
      </div>
    )
  }
  if (block.kind === 'steer') {
    return (
      <MsgBlock role={t('block.steer')} roleGlyph="steer">
        <Markdown source={block.text} onFileClick={onFileClick} />
      </MsgBlock>
    )
  }
  if (block.kind === 'landing' && block.landing) {
    const l = block.landing
    const shortSha = (l.sha ?? '').slice(0, 8)
    return (
      <div className="decision-shift info landing-card">
        <div className="ds-head">
          <span className="ds-glyph" aria-hidden>{l.action === 'pr_created' ? '⇱' : '⏚'}</span>
          {l.action === 'commit' && (
            <span className="ds-domain">{t('block.landing.committed')}{shortSha ? ` · ${shortSha}` : ''}</span>
          )}
          {l.action === 'merge_back' && (
            <span className="ds-domain">{t('block.landing.mergedBack')}{l.branch ? ` · ${l.branch} → main` : ''}{shortSha ? ` · ${shortSha}` : ''}</span>
          )}
          {l.action === 'pr_created' && (
            <span className="ds-domain">{t('block.landing.prCreated')}{l.branch ? ` · ${l.branch}` : ''}</span>
          )}
          <span className="ds-tag">{t('block.landing.tag')}</span>
        </div>
        {l.action === 'pr_created' && l.url && (
          <div className="ds-reason">
            <a
              href={l.url}
              onClick={(e) => { e.preventDefault(); openExternal(l.url!) }}
            >{l.url}</a>
          </div>
        )}
      </div>
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
          <span className="ds-domain">{s.domain ? t('block.shift.domain', { domain: s.domain }) : t('block.shift.reroute')}</span>
          <span className="ds-tag">{t('block.shift.tag')}</span>
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
          <span className="ds-tag">{t('block.intentTag')}</span>
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
            <span className="ds-domain">{t('block.autonomyProgress')}</span>
            <span className="ds-tag">{t('block.turnNoPause', { turns })}</span>
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
          <span className="ds-domain">{t('block.autonomyCheckpoint')}</span>
          <span className="ds-tag">{t('block.paused')}</span>
        </div>
        <div className="ds-reason">
          {t('block.checkpointReason', { turns })}
        </div>
        {block.checkpointDigest && (
          <pre className="ds-digest">{block.checkpointDigest}</pre>
        )}
        {onContinue && (
          <button className="btn-sm watchdog-continue" onClick={onContinue}>{t('block.continue')}</button>
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
      ? (w.stopReason === 'session-total' ? t('block.watchdog.quotaExhausted')
        : w.stopReason === 'consecutive' ? t('block.watchdog.consecutiveLimit')
        : t('block.watchdog.stopped'))
      : t('block.watchdog.autoRecover')
    const quota = `${w.sessionTotal}/12`
    return (
      <div className={`decision-shift ${stopped ? 'warn' : 'info'}`}>
        <div className="ds-head">
          <span className="ds-glyph" aria-hidden>{stopped ? '⏹' : '⟳'}</span>
          <span className="ds-domain">{t('block.watchdog.title')}</span>
          <span className="ds-tag">{tag}</span>
        </div>
        <div className="ds-reason">
          {stopped
            ? t('block.watchdog.stoppedReason')
            : t('block.watchdog.recoveredReason')}
          {' '}
          <span className="watchdog-quota">{t('block.watchdog.quota', { quota, consecutive: w.consecutive })}</span>
        </div>
        {stopped && onContinue && (
          <button className="btn-sm watchdog-continue" onClick={onContinue}>{t('block.continue')}</button>
        )}
      </div>
    )
  }
  return (
    <MsgBlock
      role={domainName ?? STAR_DOMAINS.tianshu.name}
      roleGlyph={domainGlyph}
      onRegenerate={block.kind === 'assistant' && onRegenerate ? () => onRegenerate(block.key) : undefined}
    >
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
  const { t } = useTranslation('threadView')
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
        <span className="ds-domain">{t('block.watchdog.title')}</span>
        <span className="ds-tag">{cancelled ? t('block.watchdog.cancelled') : pending ? t('block.watchdog.countdown') : t('block.watchdog.autoRecover')}</span>
      </div>
      <div className="ds-reason">
        {cancelled
          ? t('block.watchdog.cancelledReason')
          : pending
            ? t('block.watchdog.pendingReason', { seconds: Math.ceil(remainMs / 1000) })
            : t('block.watchdog.countdownDone')}
        {' '}
        <span className="watchdog-quota">{t('block.watchdog.quota', { quota, consecutive: w.consecutive })}</span>
      </div>
      {pending && (
        <div style={{ display: 'flex', gap: '8px' }}>
          {onContinue && (
            <button className="btn-sm watchdog-continue" onClick={onContinue}>{t('block.continueNow')}</button>
          )}
          {onCancel && (
            <button className="btn-sm watchdog-continue" onClick={onCancel}>{t('block.cancel')}</button>
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

// W0: tail markdown render cost (parse + reconcile of the live tail subtree).
// React Profiler's actualDuration is scoped to exactly this subtree — unlike
// wrapping perfBegin/perfEnd around the parent render, it doesn't over-count
// sibling work in the same commit. Dev-only (perfRecord early-returns in prod).
const recordTailRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  perfRecord('tailMarkdown', actualDuration)
}

// Stable prefix + live tail (TUI StreamRenderer model, see stream-segments.ts):
// frozen segments render once as memoized <Markdown> and never re-parse; only
// the still-growing tail is re-parsed per throttle tick. Bounds per-tick
// markdown cost to O(tail) regardless of total reply length, so the previous
// STREAM_MARKDOWN_MAX plain-text bail-out for long replies is gone.
function AssistantText({ text, isStreaming, onFileClick }: { text: string; isStreaming: boolean; onFileClick?: (path: string) => void }) {
  const throttled = useThrottledStreamingSource(text, isStreaming)
  const segRef = useRef<StreamSegments>(EMPTY_SEGMENTS)
  useEffect(() => {
    // Drop the frozen prefix once the stream settles so a later regenerate
    // starts clean (the splitter also self-heals on non-append input).
    if (!isStreaming) segRef.current = EMPTY_SEGMENTS
  }, [isStreaming])

  // Completion snaps to ONE full-text parse (with math + async highlight) —
  // final rendering is identical to the pre-segmentation behaviour, covering
  // cross-segment constructs like reference-style links.
  if (!isStreaming) return <Markdown source={text} onFileClick={onFileClick} />

  const segs = splitStableSegments(throttled, segRef.current)
  segRef.current = segs
  const tailHeavy = segs.tail.length > STREAM_TAIL_MAX
  return (
    <div className="md-stream">
      {segs.stable.map((seg, i) => (
        <Markdown key={i} source={seg} highlight={false} onFileClick={onFileClick} />
      ))}
      {tailHeavy
        ? <StreamingText source={segs.tail} />
        : segs.tail.trim()
          ? (
            <Profiler id="tailMarkdown" onRender={recordTailRender}>
              <Markdown source={closeUnterminatedFence(segs.tail)} highlight={false} streaming onFileClick={onFileClick} />
            </Profiler>
          )
          : null}
    </div>
  )
}

// Above this size the live tail is windowed (see below).
const STREAM_TAIL_MAX = 8000

// Plain-text fallback for a live tail that has gone a long time without a
// safe segment boundary (e.g. one giant code fence): only the trailing window
// is rendered. The user is pinned to the bottom mid-stream (auto-scroll), so
// the tail is exactly what they read; the full text + Markdown render the
// instant streaming completes (AssistantText switches off this path).
function StreamingText({ source }: { source: string }) {
  const { t } = useTranslation('threadView')
  const tail = source.length > STREAM_TAIL_MAX ? source.slice(-STREAM_TAIL_MAX) : source
  const truncated = tail.length < source.length
  return (
    <div className="md md-streaming">
      {truncated && <div className="md-stream-more">{t('stream.longOutput')}</div>}
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
  canEdit?: boolean
  onEdit?: () => void
  onRegenerate?: () => void
}) {
  const { role, roleGlyph, isError, className, children, canEdit, onEdit, onRegenerate } = props
  const { t } = useTranslation('threadView')
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
    : isError ? ' error' : roleGlyph === 'steer' ? ' steer' : roleGlyph === 'user' ? ' user' : ' assistant'

  return (
    <div className={`msg${kind}`}>
      {role && (roleGlyph === 'user' || roleGlyph === 'steer') && (
        <div className="msg-role" title={role}>
          {roleGlyph === 'user' && <span className="msg-role-dot" />}
          {roleGlyph === 'steer' && <span className="msg-role-glyph">↳</span>}
          <span className="msg-role-label">{role}</span>
        </div>
      )}
      <div className="msg-body" ref={ref}>
        {children}
      </div>
      {/* Codex 对标（Wave 3）：消息底部动作行（悬停显现）——复制 / 编辑重发 /
          重新生成。原浮动角标按钮下移，处理器不变。 */}
      <div className="msg-action-row" aria-hidden={false}>
        <button
          className="msg-action-btn"
          onClick={copy}
          aria-label={copied ? t('copied') : t('copy')}
          title={copied ? t('copied') : t('copy')}
        >
          {copied ? '✓' : '⎘'}
        </button>
        {canEdit && onEdit && (
          <button
            className="msg-action-btn"
            onClick={onEdit}
            title={t('block.editTitle')}
            aria-label={t('block.edit')}
          >
            ✎
          </button>
        )}
        {onRegenerate && (
          <button
            className="msg-action-btn"
            onClick={onRegenerate}
            title={t('block.regenerateTitle')}
            aria-label={t('block.regenerate')}
          >
            ↻
          </button>
        )}
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
  const { t } = useTranslation('threadView')
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
  const summary = useMemo(() => summarizeThinking(shown, (n) => t('thinking.chars', { count: n })), [shown, t])

  return (
    <div className={`reasoning${open ? ' open' : ''}${streaming ? ' streaming' : ''}`}>
      <div className="reasoning-summary" onClick={toggle}>
        <span className={`reasoning-glyph${streaming ? ' streaming' : ''}`} aria-hidden>{streaming ? '⟳' : '✶'}</span>
        <span className="reasoning-label">{streaming ? t('thinking.reasoning') : t('thinking.reasoned')}</span>
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
function summarizeThinking(text: string, charsLabel: (n: number) => string): string {
  const firstLine = text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  const clean = firstLine.replace(/^[#>*\-\s]+/, '').slice(0, 80)
  const chars = text.replace(/\s/g, '').length
  if (!clean) return chars > 0 ? charsLabel(chars) : ''
  return `${clean}${firstLine.length > 80 ? '…' : ''} · ${charsLabel(chars)}`
}
