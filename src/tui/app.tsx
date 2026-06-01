import React, { useState, useCallback, useRef, useEffect, useMemo, type RefObject } from 'react'
import { spawnSync } from 'node:child_process'
import { Box, Text, useInput, Static, useStdout } from 'ink'
import { WelcomeScreen } from './onboarding.js'
import { PHASE_GLYPHS, PHASE_SHORT_LABELS, type StarPhase } from '../agent/star-event.js'
import { StarmapView } from './starmap-view.js'
import { ChronicleView } from './chronicle-view.js'
import { Chronicle } from '../agent/chronicle.js'
import { InputBar } from './input.js'
import { StreamOutput } from './stream.js'
import { ThinkingCollapser } from './thinking.js'
import { ToolCard } from './tool-card.js'
import { QuestionCard } from './question-card.js'
import { UserMessage } from './user-message.js'
import { SystemMessage } from './system-message.js'
import { ToolGroup } from './tool-group.js'
import { AssistantMessage } from './assistant-message.js'
import { groupLogs } from './group-logs.js'
import { toolLabel, type ToolCallItem } from './tool-status.js'
import { phaseFromSummary, type SummaryState } from './summary-state.js'
import { formatTurnSummary } from './turn-summary.js'
import type { InterviewState } from './status-types.js'
import { PhaseTracker } from './phase-tracker.js'
import { phaseStatusLabel } from './phase-status.js'
import { FluencyTracker } from './fluency-hook.js'
import { getTheme } from './theme.js'
import { viewportLines } from './viewport.js'
import { useTerminalSize } from './use-terminal-size.js'
import { AgentLoop } from '../agent/loop.js'
import { formatIntentPreview, type IntentPreview, type IntentPreviewAction } from '../agent/intent-preview.js'
import { SessionContext } from '../agent/context.js'
import { SessionPersist } from '../agent/session-persist.js'
import { selectRestorableSessions } from './restore-session.js'
import { rollbackToCheckpoint, getRollbackPreview } from '../agent/checkpoint.js'
import { parseSensoriumLog, generateRetrospect } from '../agent/retrospect.js'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createLogEntry, summarizeToolOutput, type LogEntry } from './log-state.js'
import type { McpManager } from '../mcp/manager.js'
import { CockpitRail, TracePanel, VerificationPanel, ContextPanel, SafetyPanel, ModelPanel, McpPanel } from './cockpit/index.js'
import { buildCockpitSnapshot } from './cockpit/state.js'
import type { Panel } from './cockpit/types.js'
import { CommandPalette, getPaletteCommands } from './command-palette.js'
import { RewindList, type RewindEntry } from './rewind-list.js'
import { openInEditor } from './external-editor.js'
import { handleSlashCommand, resolveAppPromptInput, type SlashHandlerContext } from './slash-commands.js'
import { BlockStreamWriter } from './block-stream-writer.js'
import { createSurfaceRouter } from './surface/router.js'
import { useSurface } from './surface/use-surface.js'
import { createSurfaceDefinitions } from './surface/registry.js'
import { createGlanceBus } from './surface/glance-bus.js'
import { glanceOnToolStart, glanceOnToolResult } from './surface/tool-domain.js'
import { GlanceBar } from './glance-bar.js'
import { appendStreamWindow } from './stream-window.js'
import { createRingBuffer, type RingBuffer } from './ring-buffer.js'
import { RenderBatcher } from './render-batch.js'
import { SteerBuffer } from './steer-buffer.js'
import { replayMessagesToLogEntries } from './history-replay.js'
import {
  beginActivity,
  heartbeatActivity,
  completeActivity,
  clearActivity,
  failActivity,
  createIdleActivity,
  formatActivitySummary,
  formatThinkingSize,
  shouldProjectActivity,
  classifyToolActivity,
  shouldBeginAnalyzing,
  toolActivityLabel,
  analysisLabelForTool,
  type ActivityState,
} from './activity-status.js'

interface PendingApproval {
  id: string
  name: string
  input: Record<string, unknown>
  resolve: (approved: boolean) => void
}

interface PendingIntentPreview {
  intent: IntentPreview
  resolve: (action: IntentPreviewAction) => void
}

interface AppProps {
  agent: AgentLoop
  session: SessionContext
  persist: SessionPersist
  model: string
  maxTokens: number
  availableModels: Array<{ id: string; alias: string }>
  onModelSwitch: (modelId: string) => { ok: boolean; error?: string }
  allProviders: Record<string, { models: Array<{ id: string; alias: string }> }>
  currentProvider: string
  currentSessionId: string
  initialInput?: string
  mcpManagerRef: RefObject<McpManager | null>
  claimStoreRef: RefObject<import('../context/claim-store.js').ContextClaimStore | null>
  approvalMode?: 'auto-accept' | 'auto-safe' | 'suggest' | 'manual'
}

const THINKING_FLUSH_MS = 1000
const TOOL_FLUSH_MS = 120
const LIVE_STREAM_MAX_CHARS = 50_000
const HISTORY_MAX_ITEMS = 1000
const STATIC_THINKING_CAP = 10_000

/** Detect GLM-style promote: reasoning_content promoted verbatim to visible text.
 *  When thinking and text share >80% content, archiving both is redundant. */
function isThinkingPromotedToText(thinking: string, text: string): boolean {
  if (!thinking || !text) return false
  // Exact prefix: thinking is a prefix of text (or vice versa)
  if (text.startsWith(thinking.slice(0, 200)) || thinking.startsWith(text.slice(0, 200))) return true
  // Overlap ratio: check if the shorter string is >80% contained in the longer
  const shorter = thinking.length < text.length ? thinking : text
  const longer = thinking.length < text.length ? text : thinking
  if (shorter.length < 100) return false
  const windowSize = Math.min(200, shorter.length)
  const sample = shorter.slice(0, windowSize)
  return longer.includes(sample)
}

// --- Static entry renderer (imported from render-entry.tsx) ---
import { renderStaticEntry, renderMemoKey } from './render-entry.js'
import { Pager } from './pager.js'

// --- Cockpit panel view ---

interface CockpitViewProps {
  panel: Panel
  agent: AgentLoop
  session: SessionContext
  model: string
  cacheHitRate: number
  cost: number
  summaryState: SummaryState
  mcpManager: McpManager | null
  claimStoreRef: RefObject<import('../context/claim-store.js').ContextClaimStore | null>
}

function CockpitView({ panel, agent, session, model, cacheHitRate, cost, summaryState, mcpManager, claimStoreRef }: CockpitViewProps) {
  const theme = getTheme()
  const snap = useMemo(
    () => buildCockpitSnapshot({ agent, session, model, cacheHitRate, cost, mcpManager, claimCounts: claimStoreRef.current?.getStatusCounts() }),
    [agent, session, model, cacheHitRate, cost, mcpManager, claimStoreRef],
  )
  const compactEvents = useMemo(() => session.getCompactEvents(), [session])

  return (
    <Box flexDirection="column" paddingX={1} borderStyle="single" borderColor={theme.dim}>
      <Text color={theme.primary} bold>cockpit</Text>
      <CockpitRail activePanel={panel} panelStatuses={snap.panelStatuses} onSelect={() => {}} />
      {panel === 'trace' && <TracePanel events={snap.trace.events} />}
      {panel === 'verify' && <VerificationPanel filesRead={snap.verification.filesRead} filesModified={snap.verification.filesModified} verifications={snap.verification.runs} deliveryStatus={snap.verification.deliveryStatus} impactedFiles={snap.verification.impactedFiles} impactedTests={snap.verification.impactedTests} />}
      {panel === 'context' && snap.context && <ContextPanel estimatedTokens={snap.context.estimatedTokens} maxTokens={snap.context.maxTokens} rounds={snap.context.rounds} compactionState={snap.context.compactionState} brokenRounds={snap.context.brokenRounds} compactEvents={compactEvents.map(e => ({ turn: e.turn, tier: e.tier, beforeTokens: e.beforeTokens, afterTokens: e.afterTokens }))} layers={snap.context.layers} />}
      {panel === 'safety' && <SafetyPanel doomLoopLevel={snap.safety.doomLoopLevel} riskLevel={snap.safety.riskLevel} riskReasons={snap.safety.riskReasons} suggestedAction={snap.safety.suggestedAction} recentFingerprints={snap.safety.recentFingerprints} />}
      {panel === 'model' && <ModelPanel model={snap.model.name} cacheHitRate={snap.model.cacheHitRate} inputTokens={snap.model.inputTokens} outputTokens={snap.model.outputTokens} cacheReadTokens={snap.model.cacheReadTokens} cacheWriteTokens={snap.model.cacheWriteTokens} cost={snap.model.cost} routingReason={snap.model.routingReason ?? undefined} perTurnHitRate={snap.model.perTurnHitRate} recentTurnHitRate={snap.model.recentTurnHitRate} prewarmHits={snap.model.prewarmHits} prewarmMisses={snap.model.prewarmMisses} prewarmHitRate={snap.model.prewarmHitRate} cacheDiagnostic={snap.model.cacheDiagnostic} reasoningEffort={snap.model.reasoningEffort} />}
      {panel === 'mcp' && <McpPanel servers={snap.mcp.servers} totalTools={snap.mcp.totalTools} connectedServers={snap.mcp.connectedServers} />}
    </Box>
  )
}

const INTERVIEW_MARKER_RE = /<!-- interview:(\{.*?\}) -->/

function parseInterviewMarker(text: string): { state: InterviewState; cleanText: string } | null {
  const match = text.match(INTERVIEW_MARKER_RE)
  if (!match) return null
  try {
    const raw = JSON.parse(match[1]!)
    const clarity = Math.max(0, Math.min(1, typeof raw.clarity === 'number' ? raw.clarity : 0))
    const state: InterviewState = {
      intent: String(raw.intent ?? ''),
      clarity,
      round: Number(raw.round ?? 0),
      maxRounds: Number(raw.maxRounds ?? 5),
      tokensUsed: Number(raw.tokensUsed ?? 0),
      confirmed: clarity >= 0.8,
    }
    const cleanText = text.replace(INTERVIEW_MARKER_RE, '').trimEnd()
    return { state, cleanText }
  } catch {
    return null
  }
}

/**
 * A stream run may end (success / error / abort) after a newer run has already
 * started. Only the run whose captured generation is still current may flip
 * isStreaming off — otherwise a stale run kills a live one, or (the inverse bug)
 * a guard keyed on the wrong ref never flips and freezes the UI in streaming.
 */
export function isCurrentGeneration(runGen: number, currentGen: number): boolean {
  return runGen === currentGen
}

export function shouldUseStaticHistory(isStreaming: boolean, supportsAnsiEscapes: boolean): boolean {
  return !isStreaming || supportsAnsiEscapes
}

// --- Main App ---

export function App({ agent, session, persist, model, maxTokens, availableModels, onModelSwitch, allProviders, currentProvider, currentSessionId, initialInput, mcpManagerRef, claimStoreRef, approvalMode }: AppProps) {
  const { stdout } = useStdout()
  const supportsAnsiEscapes = (stdout as NodeJS.WriteStream & { supportsAnsiEscapes?: boolean }).supportsAnsiEscapes ?? process.stdout.isTTY
  const { rows: termRows } = useTerminalSize()
  const historyBufferRef = useRef<RingBuffer<LogEntry>>(createRingBuffer(HISTORY_MAX_ITEMS))
  const [historyVersion, setHistoryVersion] = useState(0)
  const historyItems = useMemo(() => historyBufferRef.current.items(), [historyVersion])
  /**
   * Monotonically increasing counter of total items ever pushed into the ring buffer.
   * Used to compute new items for Ink's <Static> component, which tracks an internal
   * index equal to items.length. If we pass a sliding window (e.g., slice(-200)),
   * items.length stays constant once the window is full, and Static silently drops
   * new items because items.slice(index) → []. Using totalItemsPushed ensures we
   * always pass an array whose length grows, so Static's index advances correctly.
   */
  const totalItemsPushedRef = useRef(0)
  const staticItemsForInk = useMemo(() => {
    const all = historyItems
    const start = Math.max(0, totalItemsPushedRef.current - all.length)
    return all.slice(start)
  }, [historyItems])
  const [liveTools, setLiveTools] = useState<LogEntry[]>([])
  const liveToolsRef = useRef<LogEntry[]>([])

  // Identity markers for GlanceBar: git branch (read once — stable per session) + active star domain
  const gitBranch = useMemo(() => {
    try {
      return spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: process.cwd(), encoding: 'utf-8', timeout: 5000 }).stdout.trim() || undefined
    } catch { return undefined }
  }, [])
  const [starDomain, setStarDomain] = useState<string | undefined>(() => agent.getSessionDomain()?.name)

  const [streamingText, setStreamingText] = useState('')
  const [streamingThinking, setStreamingThinking] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [isThinkingActive, setIsThinkingActive] = useState(false)
  /** Generation counter: incremented on each new stream start. A run's onAbort/onError/catch only flips isStreaming when its captured generation still matches — prevents a stale run from killing a newer one. */
  const streamGenRef = useRef(0)
  const [fluencyStale, setFluencyStale] = useState<{ message: string; level: 'info' | 'warn' | 'action' } | null>(null)
  const theme = getTheme()
  const [heartbeatStatus, setHeartbeatStatus] = useState<string | null>(null)
  const [cost, setCost] = useState(0)
  const [cacheHitRate, setCacheHitRate] = useState(0)
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null)
  const [pendingIntent, setPendingIntent] = useState<PendingIntentPreview | null>(null)
  const [sessionPrompt, setSessionPrompt] = useState<'waiting' | 'done'>('done')
  const [verbose, _setVerbose] = useState(false)
  const [, _setAutoSafe] = useState(true)
  const verboseRef = useRef(false)
  const autoSafeRef = useRef(true)
  const setVerbose = useCallback((v: boolean) => { verboseRef.current = v; _setVerbose(v) }, [])
  const setAutoSafe = useCallback((v: boolean) => { autoSafeRef.current = v; _setAutoSafe(v) }, [])

  const phaseTracker = useRef(new PhaseTracker())
  const fluencyRef = useRef(new FluencyTracker())
  const foldedCountRef = useRef(0)
  const turnCountRef = useRef(0)
  const maxTurnsRef = useRef(50)
  const [summaryState, setSummaryState] = useState<SummaryState>({
    task: '', phase: 'idle', stepCount: 0, totalSteps: 0,
    contextPct: 0, elapsedMs: 0, lastAction: null, risk: 'none',
    phaseDurationMs: 0, turnCount: 0, maxTurns: 50,
  })
  const [cockpitPanel, setCockpitPanel] = useState<Panel>('summary')
  const chronicleRef = useRef(new Chronicle())
  const [interviewState, setInterviewState] = useState<InterviewState | null>(null)
  const [clarityHistory, setClarityHistory] = useState<number[]>([])

  // --- SurfaceRouter (unified navigation state machine) ---
  const surfaceRouterRef = useRef(createSurfaceRouter())
  const surfaceRouter = surfaceRouterRef.current
  const surfaceInitRef = useRef(false)
  if (!surfaceInitRef.current) {
    surfaceInitRef.current = true
    for (const def of createSurfaceDefinitions()) surfaceRouter.register(def)
  }
  const { activeOverlay, isVisible: isSurfaceVisible, push: surfacePush, pop: surfacePop } = useSurface(surfaceRouter)

  const glanceBusRef = useRef(createGlanceBus())
  const glanceBus = glanceBusRef.current
  const [glancePulses, setGlancePulses] = useState(glanceBus.snapshot())
  useEffect(() => glanceBus.subscribe(() => setGlancePulses(glanceBus.snapshot())), [glanceBus])

  /** Microtask-batched static updates — coalesces multiple pushStatic calls
   *  within the same tick into 1 setHistoryVersion bump → 1 Ink render.
   *  Ring buffer writes are immediate (data never lost); only the setState
   *  notification is deferred to the next microtask. */
  const staticBatchRef = useRef<LogEntry[]>([])
  const staticBatchScheduled = useRef(false)

  const pushStatic = useCallback((entry: LogEntry) => {
    historyBufferRef.current.push(entry)
    totalItemsPushedRef.current++
    staticBatchRef.current.push(entry)
    if (!staticBatchScheduled.current) {
      staticBatchScheduled.current = true
      queueMicrotask(() => {
        staticBatchScheduled.current = false
        if (staticBatchRef.current.length > 0) {
          staticBatchRef.current = []
          setHistoryVersion(v => v + 1)
        }
      })
    }
  }, [])

  /** Synchronously flush any pending microtask-batched static entries.
   *  Called at turn-end / error / abort to ensure all Static updates are
   *  committed before isStreaming flips. */
  const flushStaticBatch = useCallback(() => {
    if (staticBatchScheduled.current) {
      staticBatchScheduled.current = false
      staticBatchRef.current = []
      setHistoryVersion(v => v + 1)
    }
  }, [])

  /** Intentionally immediate (not microtask-batched): used for turn-end
   *  assistant/thinking archival where the render must happen before
   *  isStreaming flips. For streaming intermediate updates, use pushStatic(). */
  const pushStaticBatch = useCallback((entries: readonly LogEntry[]) => {
    const grouped = groupLogs(entries)
    for (const entry of grouped) {
      historyBufferRef.current.push(entry)
      totalItemsPushedRef.current++
    }
    setHistoryVersion(v => v + 1)
  }, [])

  /**
   * Chunk threshold — kept in sync with AssistantMessage.MAX_STATIC_LINES (200).
   * Replies exceeding this are split into multiple Static entries so each unit
   * stays under the event-loop safety ceiling while preserving full content
   * in terminal scrollback.
   */
  const ASSISTANT_CHUNK_LINES = 200

  /** Push assistant content + thinking as separate LogEntries.
   *  Thinking rendered in its own box (ThinkingMessage), content in AssistantMessage.
   *  Long replies are chunked so the user can mouse-wheel through the full response. */
  const pushAssistantEntry = useCallback((content: string, thinking?: string) => {
    const entries: LogEntry[] = []
    if (thinking) {
      const capped = appendStreamWindow('', thinking, STATIC_THINKING_CAP)
      entries.push(createLogEntry({ type: 'thinking_message', content: capped }))
    }
    if (content) {
      const lines = content.split('\n')
      if (lines.length > ASSISTANT_CHUNK_LINES) {
        // Split into multiple assistant_message entries so none exceeds the cap.
        for (let i = 0; i < lines.length; i += ASSISTANT_CHUNK_LINES) {
          const chunk = lines.slice(i, i + ASSISTANT_CHUNK_LINES).join('\n')
          entries.push(createLogEntry({ type: 'assistant_message', content: chunk }))
        }
      } else {
        entries.push(createLogEntry({ type: 'assistant_message', content }))
      }
    }
    if (entries.length > 0) {
      pushStaticBatch(entries)
    }
  }, [pushStaticBatch])

  const streamStartRef = useRef(0)
  const thinkStartRef = useRef(0)
  const thinkTimeRef = useRef(0)
  const toolCallTracker = useRef<Map<string, ToolCallItem>>(new Map())

  const streamBuf = useRef('')
  const thinkBuf = useRef('')
  const lastFlushedThink = useRef('')
  const streamLiveBuf = useRef('')
  const blockWriterRef = useRef<BlockStreamWriter | null>(null)
  const textBatcher = useRef(new RenderBatcher<string>((texts) => {
    const combined = texts.join('')
    streamBuf.current += combined
    streamLiveBuf.current = appendStreamWindow(streamLiveBuf.current, combined, LIVE_STREAM_MAX_CHARS)
    setStreamingText(streamLiveBuf.current)
  }))
  const thinkTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const toolAccum = useRef<Map<string, string>>(new Map())
  const toolNames = useRef<Map<string, string>>(new Map())
  const dirtyTools = useRef<Set<string>>(new Set())
  const toolTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Activity status projection refs
  const activityRef = useRef<ActivityState>(createIdleActivity(Date.now()))
  const activityTextRef = useRef<string | undefined>(undefined)
  const activityProjectedAtRef = useRef(0)
  const activityIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [completedThinkingDurationMs, setCompletedThinkingDurationMs] = useState<number | undefined>(undefined)
  const thinkingStartedAtRef = useRef(0)

  const rollbackTokenRef = useRef<string | null>(null)
  const lastCtrlCRef = useRef(0)
  const lastEscRef = useRef(0)

  // Tool target tracking for GlanceBar and phase summaries
  const toolTargetMap = useRef<Map<string, string>>(new Map())
  const toolStartMap = useRef<Map<string, number>>(new Map())
  const recentToolLabels = useRef<string[]>([])
  const restorableRef = useRef<string[]>([])

  // Braille sparkline token history
  const tokenHistoryRef = useRef<number[]>([])
  const pushTokenHistory = useCallback((pct: number): number[] => {
    tokenHistoryRef.current.push(Math.max(0, Math.min(1, pct)))
    if (tokenHistoryRef.current.length > 20) {
      tokenHistoryRef.current = tokenHistoryRef.current.slice(-20)
    }
    return tokenHistoryRef.current
  }, [])

  const promptQueueRef = useRef({ running: false })
  const steerBuffer = useRef(new SteerBuffer())
  const [steerPending, setSteerPending] = useState(false)
  const inputBarRef = useRef<{ clear: () => void; hasContent: () => boolean; setValue: (v: string) => void }>({ clear() {}, hasContent() { return false }, setValue() {} })

  const flushThink = useCallback(() => {
    thinkTimer.current = null
    if (thinkBuf.current !== lastFlushedThink.current) {
      lastFlushedThink.current = thinkBuf.current
      // 推理流可无界增长（GLM/MiMo 长 thinking）。渲染全量会让主线程随长度线性变慢，
      // 卡住输入框与对话框。复用 text 流的滑动窗口：只把尾部窗口塞进 state，渲染成本封顶。
      // thinkBuf 仍保留全量，供完成时归档。
      setStreamingThinking(appendStreamWindow('', thinkBuf.current, LIVE_STREAM_MAX_CHARS))
    }
  }, [])

  const flushTools = useCallback(() => {
    toolTimer.current = null
    const limit = verboseRef.current ? 200 : 8
    const updates = new Map<string, string>()
    for (const tid of dirtyTools.current) {
      const accumulated = toolAccum.current.get(tid)
      if (accumulated !== undefined) {
        updates.set(tid, summarizeToolOutput(accumulated, limit))
      }
    }
    dirtyTools.current.clear()
    if (updates.size > 0) {
      const updated = liveToolsRef.current.map(e => {
        const newContent = updates.get(e.id)
        return newContent ? { ...e, content: newContent } : e
      })
      liveToolsRef.current = updated
      setLiveTools(updated)
    }
  }, [])

  const projectActivity = useCallback((now = Date.now()) => {
    const nextText = formatActivitySummary(activityRef.current, now)
    if (!shouldProjectActivity({
      previousText: activityTextRef.current,
      nextText,
      previousAt: activityProjectedAtRef.current,
      now,
    })) return

    activityTextRef.current = nextText
    activityProjectedAtRef.current = now
  }, [])

  useEffect(() => {
    const sessions = selectRestorableSessions(SessionPersist.listSessions(), currentSessionId)
    restorableRef.current = sessions
    if (sessions.length > 0) {
      setSessionPrompt('waiting')
    }
  }, [currentSessionId])

  useEffect(() => {
    // Welcome screen is rendered inline, no banner needed
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (initialInput) {
      handleSubmit(initialInput)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Steer buffer subscription — updates pending indicator
  useEffect(() => {
    return steerBuffer.current.subscribe(() => {
      setSteerPending(steerBuffer.current.hasPending())
    })
  }, [])

  // Low-frequency activity projection timer (1Hz while streaming)
  useEffect(() => {
    if (!isStreaming) {
      if (activityIntervalRef.current) {
        clearInterval(activityIntervalRef.current)
        activityIntervalRef.current = null
      }
      return
    }
    activityIntervalRef.current = setInterval(() => {
      const now = Date.now()
      projectActivity(now)
      // Also feed phase duration + turn count into GlanceBar/Starmap state for live heartbeat
      const phaseMs = now - activityRef.current.startedAt
      setSummaryState(prev => {
        if (prev.phaseDurationMs === phaseMs && prev.turnCount === turnCountRef.current) return prev
        return { ...prev, phaseDurationMs: phaseMs, turnCount: turnCountRef.current, maxTurns: maxTurnsRef.current }
      })
      // Sync active star domain (bound on first run during streaming)
      const dn = agent.getSessionDomain()?.name
      setStarDomain(prev => (prev === dn ? prev : dn))
    }, 1000)
    return () => {
      if (activityIntervalRef.current) {
        clearInterval(activityIntervalRef.current)
        activityIntervalRef.current = null
      }
    }
  }, [isStreaming, projectActivity])

  // Fluency stale detection (2Hz while streaming)
  useEffect(() => {
    if (!isStreaming) { setFluencyStale(null); return }
    const id = setInterval(() => {
      const policy = fluencyRef.current.getPolicy()
      setFluencyStale(policy.staleMessage ? { message: policy.staleMessage, level: policy.staleLevel ?? 'info' } : null)
    }, 2000)
    return () => clearInterval(id)
  }, [isStreaming])

  useInput((_input, _key) => {
    // Ctrl+C — clear input, soft interrupt, or exit
    if (_input === 'c' && _key.ctrl) {
      if (pendingApproval) {
        pendingApproval.resolve(false)
        setPendingApproval(null)
      }
      if (pendingIntent) {
        pendingIntent.resolve('veto')
        setPendingIntent(null)
      }
      if (isStreaming) {
        agent.abort()
        steerBuffer.current.clear()
        setIsStreaming(false)
        pushStatic(createLogEntry({ type: 'system', content: '⏹ Interrupted.' }))
        lastCtrlCRef.current = Date.now()
        return
      }
      // Clear input first if it has content
      if (inputBarRef.current.hasContent()) {
        inputBarRef.current.clear()
        return
      }
      if (lastCtrlCRef.current && Date.now() - lastCtrlCRef.current < 2000) {
        if (process.stdin.isTTY && process.stdin.setRawMode) {
          process.stdin.setRawMode(false)
        }
        process.emit('SIGINT')
      }
      lastCtrlCRef.current = Date.now()
      pushStatic(createLogEntry({ type: 'system', content: '(Ctrl+C again to exit)' }))
      return
    }

    // Escape — close surface overlay/popup, double-press to interrupt streaming or open rewind
    if (_key.escape) {
      if (activeOverlay || surfaceRouter.activeOf('popup')) {
        surfacePop()
        return
      }
      const now = Date.now()
      if (isStreaming) {
        if (lastEscRef.current && now - lastEscRef.current < 1000) {
          agent.abort()
          steerBuffer.current.clear()
          setIsStreaming(false)
          pushStatic(createLogEntry({ type: 'system', content: '⏹ Interrupted.' }))
          lastEscRef.current = 0
          surfacePush('rewind')
        } else {
          lastEscRef.current = now
          pushStatic(createLogEntry({ type: 'system', content: '(Esc again to rewind)' }))
        }
        return
      }
      // Idle: double-ESC opens rewind
      if (lastEscRef.current && now - lastEscRef.current < 1000) {
        lastEscRef.current = 0
        surfacePush('rewind')
      } else {
        lastEscRef.current = now
      }
      return
    }
    // Starbridge mode switching via SurfaceRouter (during streaming, no pending prompts)
    if (isStreaming && !pendingApproval && !pendingIntent) {
    }
    if (sessionPrompt === 'waiting') {
      const sessions = restorableRef.current
      if (_input === 'r' && sessions.length > 0) {
        const id = sessions[0]!
        setSessionPrompt('done')
        pushStatic(createLogEntry({ type: 'system', content: `Restoring session ${id.slice(0, 8)}...` }))
        // Defer restore to next tick so the "Restoring..." message renders first
        void Promise.resolve().then(() => {
          const p = new SessionPersist(id)
          const messages = p.loadOai()
          session.replaceMessages(messages)
          const { entries, toolCount, turnCount } = replayMessagesToLogEntries(session.getMessages())
          pushStaticBatch(entries)
          const tcPct = Math.min(session.getEstimatedTokens() / maxTokens, 1)
          setCacheHitRate(session.getCacheHitRate())
          setSummaryState(prev => ({ ...prev, contextPct: tcPct, tokenHistory: pushTokenHistory(tcPct) }))
          pushStatic(createLogEntry({ type: 'system', content: `Restored session ${id.slice(0, 8)}... (${turnCount} turns, ${toolCount} tools)` }))
        })
        return
      }
      setSessionPrompt('done')
      return
    }

    if (_key.ctrl && _input === '\x0b') {
      isSurfaceVisible('command-palette') ? surfacePop() : surfacePush('command-palette')
      return
    }
    if (_key.ctrl && _input === '\x10') {
      isSurfaceVisible('pager') ? surfacePop() : surfacePush('pager')
      return
    }
    if (_key.ctrl && _input === '\x0f') {
      const edited = openInEditor('')
      if (edited) {
        handleSubmit(edited.trim())
      }
      return
    }

    if (pendingIntent) {
      if (_key.return || _input.toLowerCase() === 'y') {
        pendingIntent.resolve('continue')
        setPendingIntent(null)
      } else if (_input.toLowerCase() === 'n') {
        pendingIntent.resolve('veto')
        setPendingIntent(null)
      } else if (_input.toLowerCase() === 'a') {
        pendingIntent.resolve('alternative')
        setPendingIntent(null)
      }
      return
    }

    if (!pendingApproval) return
    if (_input.toLowerCase() === 'y') {
      pendingApproval.resolve(true)
      setPendingApproval(null)
    } else if (_input.toLowerCase() === 'n') {
      pendingApproval.resolve(false)
      setPendingApproval(null)
    }
  })

  // --- Rewind ---
  const getRewindEntries = useCallback((): RewindEntry[] => {
    const msgs = session.getMessages()
    const entries: RewindEntry[] = []
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!
      if (m.role === 'user' && typeof m.content === 'string') {
        entries.push({ index: i, content: m.content })
      }
    }
    return entries
  }, [session])

  const handleRewind = useCallback((entry: RewindEntry) => {
    // Truncate messages to before the selected user message
    const msgs = session.getMessages()
    session.replaceMessages(msgs.slice(0, entry.index))

    // Truncate log history: remove entries from the corresponding user_message onward
    const items = historyBufferRef.current.items()
    // Find the log entry matching this user message (search from the end)
    let cutIdx = items.length
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i]!.type === 'user_message' && items[i]!.content === entry.content) {
        cutIdx = i
        break
      }
    }
    historyBufferRef.current.clear()
    for (let i = 0; i < cutIdx; i++) {
      historyBufferRef.current.push(items[i]!)
    }
    setHistoryVersion(v => v + 1)

    // Restore text to input bar
    inputBarRef.current.setValue(entry.content)
    pushStatic(createLogEntry({ type: 'system', content: `⏪ Rewound — message restored to input.` }))
  }, [session, pushStatic])

  const handleSubmit = useCallback((_userInput: string) => {
    let userInput = _userInput
    // Bump generation so any in-flight onAbort from a previous run can detect staleness.
    streamGenRef.current++
    const myGen = streamGenRef.current
    const run = async () => {
    setIsStreaming(true)
    setIsThinkingActive(false)
    setStreamingText('')
    setStreamingThinking('')
    setLiveTools([])
    liveToolsRef.current = []
    setFluencyStale(null)
    setHeartbeatStatus(null)
    fluencyRef.current.onTurnComplete()
    foldedCountRef.current = 0

    streamBuf.current = ''
    streamLiveBuf.current = ''
    thinkBuf.current = ''
    lastFlushedThink.current = ''
    toolAccum.current.clear()
    dirtyTools.current.clear()
    toolNames.current.clear()
    toolTargetMap.current.clear()
    toolStartMap.current.clear()
    activityRef.current = clearActivity(activityRef.current, Date.now())
    activityTextRef.current = undefined
    activityProjectedAtRef.current = 0
    setCompletedThinkingDurationMs(undefined)
    thinkingStartedAtRef.current = 0

    blockWriterRef.current = new BlockStreamWriter({}, (text) => {
      textBatcher.current.push(text)
    })

    streamStartRef.current = Date.now()
    thinkStartRef.current = 0
    thinkTimeRef.current = 0
    toolCallTracker.current.clear()

    const taskDesc = userInput.length > 30 ? userInput.slice(0, 29) + '…' : userInput
    const initPct = Math.min(session.getEstimatedTokens() / maxTokens, 1)

    if (interviewState?.confirmed) {
      setInterviewState(null)
      setClarityHistory([])
    }

    phaseTracker.current = new PhaseTracker()
    setSummaryState({ task: taskDesc, phase: 'idle', stepCount: 0, totalSteps: 0, contextPct: initPct, elapsedMs: 0, lastAction: null, risk: 'none', tokenHistory: pushTokenHistory(initPct), phaseDurationMs: 0, turnCount: 0, maxTurns: maxTurnsRef.current })

    for (const ref of [thinkTimer, toolTimer]) {
      if (ref.current) {
        clearTimeout(ref.current)
        ref.current = null
      }
    }

    // Save original input before any slash-command transformation for display
    const originalUserInput = userInput

    if (userInput.startsWith('/')) {
      const parts = userInput.split(/\s+/)
      const cmd = parts[0]!.toLowerCase()

      if (cmd === '/interview') {
        const topic = parts.slice(1).join(' ').trim()
        if (!topic) {
          pushStatic(createLogEntry({ type: 'system', content: 'Usage: /interview <topic>' }))
          setIsStreaming(false)
          return
        }
        pushStatic(createLogEntry({ type: 'system', content: `⚡ Interview mode activated for: ${topic}` }))
        setInterviewState({ intent: topic, clarity: 0, round: 0, maxRounds: 5, tokensUsed: 0, confirmed: false })
        // Transform input and fall through to shared agent.run below
        // The long interview prompt is sent to the model only, not displayed to the user
        const interviewInput = `[interview-mode] ${topic}\n\n[interview-instructions]\nActivate interview mode:\n1. Save my original intent verbatim\n2. Ask ONE clarifying question at a time (prefer A/B/C choices). Keep your reasoning brief — output the question directly.\n3. Track clarity across: intent clarity, constraints, success criteria, edge cases\n4. After each round, append: <!-- interview:{"intent":"<summary>","clarity":<0-1>,"round":<n>,"maxRounds":5,"tokensUsed":<estimate>} -->\n5. When clarity >= 0.8 OR after 5 rounds, present a cognitive sync summary\n6. Wait for user confirmation before proceeding\n\nIMPORTANT: Keep thinking minimal. Do not repeat the same analysis across rounds. Just ask the question concisely.`
        userInput = interviewInput
      } else
      if (cmd === '/rollback') {
        const subcmd = parts[1]
        if (subcmd === 'confirm') {
          const result = await rollbackToCheckpoint(process.cwd(), rollbackTokenRef.current ?? undefined, currentSessionId)
          rollbackTokenRef.current = null
          pushStatic(createLogEntry({ type: 'system', content: result.success ? `Rolled back to checkpoint ${result.hash}. Agent-owned changes reverted.` : 'Rollback failed. No valid checkpoint or confirmation token.' }))
        } else {
          const preview = await getRollbackPreview(process.cwd(), currentSessionId)
          if (preview) {
            rollbackTokenRef.current = preview.confirmationToken
            pushStatic(createLogEntry({ type: 'system', content: `⚠️  Agent-owned changes to revert:\n${preview.text}\n\nType /rollback confirm to proceed.` }))
          } else {
            pushStatic(createLogEntry({ type: 'system', content: 'No agent-owned changes to rollback.' }))
          }
        }
        setIsStreaming(false)
        return
      }

      if (cmd === '/retrospect') {
        const cwd = process.cwd()
        const sensoriumPath = join(cwd, '.rivet', 'sensorium.jsonl')
        if (!existsSync(sensoriumPath)) {
          pushStatic(createLogEntry({ type: 'system', content: '无 sensorium 数据。请先运行一个 session。' }))
          setIsStreaming(false)
          return
        }
        try {
          const raw = readFileSync(sensoriumPath, 'utf-8')
          if (!raw.trim()) {
            pushStatic(createLogEntry({ type: 'system', content: 'Sensorium 日志为空。请先运行一个 session。' }))
            setIsStreaming(false)
            return
          }
          const entries = parseSensoriumLog(raw)
          const traceStore = agent.getTraceStore()
          const evidenceState = agent.getEvidenceState()
          const toolEvents = traceStore.events
            .filter(e => e.kind === 'tool')
            .map(e => ({
              turn: e.turn,
              name: e.name,
              status: e.status === 'passed' ? 'passed' as const : 'failed' as const,
            }))
          const report = generateRetrospect({
            sensoriumEntries: entries,
            gitLog: [], // git log can be added later via child_process
            toolEvents,
            evidenceSummary: {
              filesModified: evidenceState.filesModified.size,
              verifiedCount: evidenceState.verifications.filter(v => v.status === 'passed').length,
            },
          })
          pushStatic(createLogEntry({ type: 'system', content: report }))
        } catch (err) {
          pushStatic(createLogEntry({ type: 'system', content: `Retrospect 生成失败: ${err instanceof Error ? err.message : String(err)}` }))
        }
        setIsStreaming(false)
        return
      }

      const slashCtx: SlashHandlerContext = {
        parts, agent, session, persist, model, maxTokens, availableModels, onModelSwitch,
        allProviders, currentProvider,
        currentSessionId, cost, cacheHitRate, autoSafeRef, verboseRef,
        setVerbose, setAutoSafe, rollbackTokenRef,
        setCockpitPanel, pushStatic, setIsStreaming, setCacheHitRate, setSummaryState,
        mcpManagerRef, claimStoreRef,
        activeOverlay,
        surfacePush, surfacePop,
        setReasoningEffort: (effort) => {
          agent.setReasoningEffort(effort)
        },
        reasoningEffort: agent.getReasoningEffort() ?? 'medium',
      }
      if (handleSlashCommand(slashCtx)) return
    }

    const promptInput = resolveAppPromptInput(userInput, process.cwd())

    // Guard: block unrecognized slash commands from reaching the LLM
    // Prevents typos like /mdel being misinterpreted as dangerous instructions
    if (promptInput === null) {
      const cmdName = userInput.split(/\s/)[0] ?? userInput
      pushStatic(createLogEntry({
        type: 'system',
        content: `⚠️  Unknown command: ${cmdName}\n\nType /help to see available commands.`,
      }))
      setIsStreaming(false)
      return
    }

    pushStatic(createLogEntry({ type: 'user_message', content: originalUserInput }))

    await agent.run(promptInput, {
      onTextDelta: (text) => {
        setHeartbeatStatus(null)
        const now = Date.now()
        fluencyRef.current.setPhase('streaming')
        if (activityRef.current.phase === 'thinking') {
          const completedAt = now
          activityRef.current = completeActivity(activityRef.current, completedAt, {
            sizeHint: formatThinkingSize(thinkBuf.current.length),
          })
          // Only mark thinking as completed if thinking was actually received
          if (thinkingStartedAtRef.current > 0) {
            setCompletedThinkingDurationMs(completedAt - thinkingStartedAtRef.current)
          }
          projectActivity(now)
          activityRef.current = beginActivity(activityRef.current, 'streaming', 'Streaming answer', now)
        } else if (activityRef.current.phase !== 'streaming') {
          activityRef.current = beginActivity(activityRef.current, 'streaming', 'Streaming answer', now)
        } else {
          activityRef.current = heartbeatActivity(activityRef.current, now)
        }
        projectActivity(now)
        blockWriterRef.current?.push(text)
      },
      onThinkingDelta: (thinking) => {
        setHeartbeatStatus(null)
        const now = Date.now()
        fluencyRef.current.setPhase('thinking')
        if (thinkStartRef.current === 0) {
          thinkStartRef.current = now
          thinkingStartedAtRef.current = now
          setIsThinkingActive(true)
          activityRef.current = beginActivity(activityRef.current, 'thinking', 'Thinking', now)
        } else {
          activityRef.current = heartbeatActivity(activityRef.current, now, {
            sizeHint: formatThinkingSize(thinkBuf.current.length + thinking.length),
          })
        }
        thinkBuf.current += thinking
        projectActivity(now)
        // First chunk: delay 200ms to batch with early content and avoid
        // layout突变 from ThinkingCollapser suddenly appearing.
        // isThinkingActive (set above) shows a minimal indicator immediately.
        // Trade-off: GLM can finish thinking in <200ms — user sees the indicator
        // for the full 200ms before content appears. Acceptable: the indicator
        // provides immediate feedback, and 200ms is below perception threshold.
        if (lastFlushedThink.current === '' && !thinkTimer.current) {
          thinkTimer.current = setTimeout(flushThink, 200)
        } else if (!thinkTimer.current) {
          thinkTimer.current = setTimeout(flushThink, THINKING_FLUSH_MS)
        }
      },
      onToolUse: (id, name, input) => {
        setHeartbeatStatus(null)
        toolNames.current.set(id, name)
        toolStartMap.current.set(id, Date.now())
        setIsThinkingActive(false)

        const target = typeof input?.file_path === 'string' ? input.file_path
          : typeof input?.path === 'string' ? input.path
          : typeof input?.command === 'string' ? input.command.slice(0, 30)
          : name
        toolTargetMap.current.set(id, target)

        if (thinkStartRef.current > 0) {
          thinkTimeRef.current = Date.now() - thinkStartRef.current
          thinkStartRef.current = 0
        }

        const entry = createLogEntry({ type: 'tool', id, content: 'Running...', toolName: name })
        liveToolsRef.current = [...liveToolsRef.current, entry]
        setLiveTools(liveToolsRef.current)

        const label = toolLabel(name, input)
        glanceOnToolStart(glanceBus, name)
        toolCallTracker.current.set(id, { id, name, label, done: false, error: false })

        // Begin tool activity for status bar
        const now = Date.now()
        const classified = classifyToolActivity(name, toolActivityLabel(name, label))
        fluencyRef.current.setPhase(classified.phase)
        activityRef.current = beginActivity(activityRef.current, classified.phase, classified.label, now)
        projectActivity(now)

        phaseTracker.current.onToolUse(name, target)
        const basename = (target ?? '').split('/').pop() ?? target ?? name
        const shortLabel = `${name === 'read_file' ? 'read' : name === 'edit_file' ? 'edit' : name === 'write_file' ? 'write' : name === 'bash' ? 'run' : name} ${basename}`.slice(0, 25)
        recentToolLabels.current = [...recentToolLabels.current.slice(-2), shortLabel]
        const tuPct = Math.min(session.getEstimatedTokens() / maxTokens, 1)
        setSummaryState(prev => ({
          ...prev,
          phase: phaseTracker.current.current(),
          stepCount: agent.getTrajectoryStats().totalTools,
          contextPct: tuPct,
          elapsedMs: Date.now() - streamStartRef.current,
          tokenHistory: pushTokenHistory(tuPct),
          recentToolSummary: recentToolLabels.current,
        }))
      },
      onToolResult: (id: string, name: string, result: string, isError?: boolean, rawPath?: string, uiContent?: string) => {
        setHeartbeatStatus(null)
        if (isError === undefined) {
          toolAccum.current.set(id, (toolAccum.current.get(id) ?? '') + result)
          dirtyTools.current.add(id)
          if (!toolTimer.current) {
            toolTimer.current = setTimeout(flushTools, TOOL_FLUSH_MS)
          }

          // Heartbeat tool activity during live output
          if (activityRef.current.phase === 'tool' || activityRef.current.phase === 'mcp') {
            const now = Date.now()
            fluencyRef.current.setPhase(activityRef.current.phase)
            activityRef.current = heartbeatActivity(activityRef.current, now)
            projectActivity(now)
          }
          return
        }

        if (toolTimer.current) {
          clearTimeout(toolTimer.current)
          toolTimer.current = null
        }
        const toolName = toolNames.current.get(id) ?? name
        dirtyTools.current.delete(id)
        toolAccum.current.delete(id)
        toolNames.current.delete(id)
        toolStartMap.current.delete(id)

        const finalContent = uiContent ?? result
        liveToolsRef.current = liveToolsRef.current.filter(e => e.id !== id)
        setLiveTools(liveToolsRef.current)

        // Fluency: fold routine tools when policy says so
        fluencyRef.current.recordToolResult({ name: toolName, isError: !!isError, resultLength: result.length })
        const fluencyPolicy = fluencyRef.current.getPolicy()
        if (fluencyPolicy.foldRoutine && fluencyRef.current.isRoutineTool(toolName, !!isError)) {
          foldedCountRef.current++
          pushStatic(createLogEntry({ type: 'tool', id, toolName, content: summarizeToolOutput(finalContent, verboseRef.current ? 80 : 8), isError, rawPath }))
        } else {
          if (foldedCountRef.current > 0) {
            pushStatic(createLogEntry({ type: 'system', content: `… ${foldedCountRef.current} routine tool calls folded` }))
            foldedCountRef.current = 0
          }
          // P5: smart summarization for large tool results to prevent screen overflow
          const resultLines = finalContent.split('\n').length
          const maxLines = resultLines > 100 ? 30 : resultLines > 50 ? 20 : verboseRef.current ? 200 : 8
          const displayContent = resultLines > maxLines ? summarizeToolOutput(finalContent, maxLines) : finalContent
          pushStatic(createLogEntry({ type: 'tool', id, toolName, content: displayContent, isError, rawPath }))
        }

        const tcEntry = toolCallTracker.current.get(id)
        if (tcEntry) {
          tcEntry.done = true
          tcEntry.error = !!isError
        }
        glanceOnToolResult(glanceBus, toolName, !!isError)

        phaseTracker.current.onToolResult(name, !!isError)
        const risk = (name === 'bash' && !autoSafeRef.current) ? 'medium' as const : 'none' as const
        const trPct = Math.min(session.getEstimatedTokens() / maxTokens, 1)
        fluencyRef.current.setContextPressure(trPct)
        setSummaryState(prev => ({
          ...prev,
          lastAction: phaseTracker.current.lastAction(),
          risk,
          elapsedMs: Date.now() - streamStartRef.current,
          approvalNeeded: null,
          tokenHistory: pushTokenHistory(trPct),
        }))

        // Complete/fail tool activity
        const toolNow = Date.now()
        const resolvedLabel = toolCallTracker.current.get(id)?.label ?? toolName
        const resultLength = result.length

        if (isError) {
          activityRef.current = failActivity(activityRef.current, toolNow)
        } else {
          activityRef.current = completeActivity(activityRef.current, toolNow)
        }
        projectActivity(toolNow)

        // Begin analyzing activity for large results
        if (!isError && shouldBeginAnalyzing({ toolName, resultLength })) {
          activityRef.current = beginActivity(activityRef.current, 'analyzing', analysisLabelForTool(toolName, resolvedLabel), toolNow)
          projectActivity(toolNow)
        }
      },
      onCheckpoint: (hash) => {
        pushStatic(createLogEntry({ type: 'checkpoint', content: `Checkpoint saved: ${hash.slice(0, 7)} — /rollback to restore` }))
      },
      onTurnComplete: (_usage, turnNumber, isFinal) => {
        setHeartbeatStatus(null)

        if (dirtyTools.current.size > 0) {
          flushTools()
        }

        turnCountRef.current = turnNumber

        // Intermediate turn: update activity, freeze tools, reset thinking — but keep writer alive
        if (isFinal === false) {
          textBatcher.current.flushNow()
          // Archive intermediate turn text to Static and clear stream buffers
          // to prevent cross-turn text accumulation in StreamOutput (P2 fix).
          const midText = streamBuf.current
          if (midText) {
            const midThinking = thinkBuf.current || undefined
            pushAssistantEntry(midText, midThinking)
          }
          streamBuf.current = ''
          streamLiveBuf.current = ''
          setStreamingText('')
          if (thinkStartRef.current > 0) {
            thinkTimeRef.current = Date.now() - thinkStartRef.current
            thinkStartRef.current = 0
          }
          const midNow = Date.now()
          if (activityRef.current.phase !== 'idle') {
            activityRef.current = completeActivity(activityRef.current, midNow)
            projectActivity(midNow)
          }
          // Signal that we're waiting for the next LLM response
          activityRef.current = beginActivity(activityRef.current, 'waiting', 'Waiting for LLM', midNow)
          fluencyRef.current.setPhase('waiting')
          projectActivity(midNow)
          // Freeze live tools into static log
          const midTools = liveToolsRef.current
          if (midTools.length > 0) {
            pushStaticBatch(midTools)
          }
          liveToolsRef.current = []
          setLiveTools([])
          // Reset thinking for next turn
          thinkBuf.current = ''
          setStreamingThinking('')
          setIsThinkingActive(false)
          if (thinkTimer.current) {
            clearTimeout(thinkTimer.current)
            thinkTimer.current = null
          }
          lastFlushedThink.current = ''
          return
        }

        if (thinkStartRef.current > 0) {
          thinkTimeRef.current = Date.now() - thinkStartRef.current
          thinkStartRef.current = 0
        }

        // Complete any active activity and project final summary
        const turnNow = Date.now()
        if (activityRef.current.phase !== 'idle') {
          activityRef.current = completeActivity(activityRef.current, turnNow)
          projectActivity(turnNow)
        }

        textBatcher.current.flushNow()

        const writer = blockWriterRef.current
        if (writer) {
          writer.flush()
          blockWriterRef.current = null
        }
        // Flush again — writer.flush() may have pushed new items into the batcher
        textBatcher.current.flushNow()
        const finalText = streamBuf.current
        // GLM promote guard: if thinking was promoted verbatim to visible text,
        // skip archiving thinking to avoid duplicate content in <Static>.
        const thinkingForArchive = (finalText && thinkBuf.current && isThinkingPromotedToText(thinkBuf.current, finalText))
          ? undefined
          : (thinkBuf.current || undefined)
        // Stop streaming FIRST so StreamOutput unmounts before Static entry appears,
        // preventing duplicate content visible simultaneously in terminal.
        setIsStreaming(false)
        if (finalText || thinkBuf.current) {
          if (finalText) {
            const parsed = parseInterviewMarker(finalText)
            if (parsed) {
              setInterviewState(parsed.state)
              setClarityHistory(prev => [...prev.slice(-49), parsed.state.clarity])
              if (parsed.state.confirmed) {
                setSummaryState(prev => ({ ...prev, phase: 'interview' }))
              }
              if (parsed.cleanText) {
                pushAssistantEntry(parsed.cleanText, thinkingForArchive)
              }
            } else {
              pushAssistantEntry(finalText, thinkingForArchive)
            }
          } else {
            // Only thinking, no visible text — push thinking-only entry
            pushAssistantEntry('', thinkBuf.current)
          }
        }
        setStreamingText('')

        if (thinkTimer.current) {
          clearTimeout(thinkTimer.current)
          thinkTimer.current = null
        }
        lastFlushedThink.current = ''
        setStreamingThinking('')
        thinkBuf.current = ''

        const remaining = liveToolsRef.current
        if (remaining.length > 0) {
          pushStaticBatch(remaining)
        }
        liveToolsRef.current = []
        setLiveTools([])

        // Turn-level cache hit rate for GlanceBar (last 3 turns)
        const recentHitRate = session.getRecentTurnHitRate(3) ?? session.getCacheHitRate()
        setCacheHitRate(recentHitRate)

        // Detect cache degradation after compaction
        const latestHitRate = session.getLatestTurnHitRate()
        const wasCompacted = turnNumber > 1 && session.wasCompactedAt(turnNumber - 1)
        if (latestHitRate !== null && latestHitRate < 0.4 && turnNumber > 1) {
          if (wasCompacted) {
            pushStatic(createLogEntry({ type: 'system', content: `Cache degraded (${(latestHitRate * 100).toFixed(0)}%) — compaction restructured prefix. Normal on next turn.` }))
          }
        }

        phaseTracker.current.onTurnComplete()
        fluencyRef.current.onTurnComplete()
        setFluencyStale(null)
        // Drain any remaining steer guidance at turn boundary (pure-text turns)
        const turnSteer = steerBuffer.current.drain()
        if (turnSteer) {
          agent.addAnchor('user_constraint', turnSteer)
          pushStatic(createLogEntry({ type: 'system', content: 'Steering guidance will be applied on next turn.' }))
        }
        // Flush any remaining folded tools
        if (foldedCountRef.current > 0) {
          pushStatic(createLogEntry({ type: 'system', content: `… ${foldedCountRef.current} routine tool calls folded` }))
          foldedCountRef.current = 0
        }
        const tcPct = Math.min(session.getEstimatedTokens() / maxTokens, 1)
        setSummaryState(prev => ({ ...prev, phase: 'idle', elapsedMs: Date.now() - streamStartRef.current, tokenHistory: pushTokenHistory(tcPct) }))

        const usage = session.getTotalUsage()
        const normalInput = Math.max(0, usage.input_tokens - usage.cache_read_input_tokens)
        const estimatedCost = (normalInput * 1 + usage.cache_read_input_tokens * 0.1 + usage.output_tokens * 4) / 1_000_000
        setCost(estimatedCost)

        const evidence = agent.getEvidenceState()
        const turnSummary = formatTurnSummary({
          segments: chronicleRef.current.getPhaseSegments(),
          filesRead: evidence.filesRead.size,
          filesModified: evidence.filesModified.size,
          verifiedCount: evidence.verifications.filter(v => v.status === 'passed').length,
          elapsedMs: Date.now() - streamStartRef.current,
        })
        pushStatic(createLogEntry({ type: 'turn_summary', content: turnSummary }))
        // Atomically commit all microtask-batched entries before isStreaming flips
        flushStaticBatch()
      },
      onPhaseChange: (phase, detail) => {
        // Phase → heartbeat status label (preparing, working, tool-hint, heartbeat)
        const statusLabel = phaseStatusLabel(phase, detail)
        if (statusLabel !== null) {
          setHeartbeatStatus(statusLabel)
          if (phase === 'heartbeat') return
        }
        if (phase === 'tianshu-radio' && detail?.reason) {
          chronicleRef.current.addRadio(detail.reason, turnCountRef.current)
        }
        const knownPhases: readonly string[] = [
          'tianshu-planning', 'tianxuan-locating', 'tianji-decomposing',
          'tianquan-contracting', 'yuheng-implementing', 'kaiyang-testing',
          'yaoguang-delivering', 'tianshu-encore',
        ]
        if (knownPhases.includes(phase)) {
          const starPhase = phase as StarPhase
          setSummaryState(prev => ({
            ...prev,
            starPhaseGlyph: PHASE_GLYPHS[starPhase],
            starPhaseLabel: PHASE_SHORT_LABELS[starPhase],
          }))
        }
      },
      onError: (error) => {
        // Mark current activity as failed and project before cleanup
        const errorNow = Date.now()
        if (activityRef.current.phase !== 'idle') {
          activityRef.current = failActivity(activityRef.current, errorNow)
          projectActivity(errorNow)
        }
        // Clean up stale timers and writer on error
        if (thinkTimer.current) { clearTimeout(thinkTimer.current); thinkTimer.current = null }
        if (toolTimer.current) { clearTimeout(toolTimer.current); toolTimer.current = null }
        blockWriterRef.current?.flush()
        blockWriterRef.current = null
        textBatcher.current.flushNow()
        foldedCountRef.current = 0
        fluencyRef.current.onTurnComplete()
        setFluencyStale(null)
        // Preserve any partial text/thinking before clearing
        if (streamBuf.current || thinkBuf.current) {
          pushAssistantEntry(streamBuf.current, thinkBuf.current || undefined)
        }
        streamBuf.current = ''
        streamLiveBuf.current = ''
        // Stop streaming FIRST, then clear text — prevents flash frame on error.
        // Guard on myGen (this run): only flip if no newer run has started since.
        if (isCurrentGeneration(myGen, streamGenRef.current)) {
          setIsStreaming(false)
        }
        setStreamingText('')
        thinkBuf.current = ''
        setStreamingThinking('')
        // Clear tool state from failed run
        toolAccum.current.clear()
        toolNames.current.clear()
        dirtyTools.current.clear()
        toolTargetMap.current.clear()
        toolStartMap.current.clear()
        toolCallTracker.current.clear()
        const preservedSteer = steerBuffer.current.drain()
        if (preservedSteer) {
          pushStatic(createLogEntry({ type: 'system', content: `📨 ${preservedSteer.split('\n').length} queued message(s) preserved for next turn.` }))
        }
        liveToolsRef.current = []
        setLiveTools([])
        pushStatic(createLogEntry({ type: 'system', content: `Error: ${error.message}`, isError: true }))
        flushStaticBatch()
      },
      onAbort: () => {
        // Mark current activity as failed and project before cleanup
        const abortNow = Date.now()
        if (activityRef.current.phase !== 'idle') {
          activityRef.current = failActivity(activityRef.current, abortNow)
          projectActivity(abortNow)
        }
        if (thinkTimer.current) { clearTimeout(thinkTimer.current); thinkTimer.current = null }
        if (toolTimer.current) { clearTimeout(toolTimer.current); toolTimer.current = null }
        blockWriterRef.current?.flush()
        blockWriterRef.current = null
        textBatcher.current.flushNow()
        foldedCountRef.current = 0
        fluencyRef.current.onTurnComplete()
        setFluencyStale(null)
        // Preserve any partial text/thinking before clearing
        if (streamBuf.current || thinkBuf.current) {
          pushAssistantEntry(streamBuf.current, thinkBuf.current || undefined)
        }
        streamBuf.current = ''
        streamLiveBuf.current = ''
        // Stop streaming FIRST, then clear text — prevents flash frame on abort.
        // Guard on myGen (this run): only flip if no newer run has started since.
        if (isCurrentGeneration(myGen, streamGenRef.current)) {
          setIsStreaming(false)
        }
        setStreamingText('')
        thinkBuf.current = ''
        setStreamingThinking('')
        // Clear tool state from aborted run
        toolAccum.current.clear()
        toolNames.current.clear()
        dirtyTools.current.clear()
        toolTargetMap.current.clear()
        toolStartMap.current.clear()
        toolCallTracker.current.clear()
        steerBuffer.current.clear()
        liveToolsRef.current = []
        setLiveTools([])
        pushStatic(createLogEntry({ type: 'system', content: '⏹ Interrupted.' }))
        flushStaticBatch()
      },
      onApprovalRequired: async (id, name, input) => {
        fluencyRef.current.recordApproval()
        // Auto-approve in auto-accept mode — no user confirmation needed
        if (approvalMode === 'auto-accept') {
          return true
        }
        const target = String(input?.path ?? input?.command ?? name)
        setSummaryState(prev => ({ ...prev, approvalNeeded: { tool: name, target } }))
        return new Promise<boolean>((resolve) => {
          setPendingApproval({ id, name, input, resolve })
        })
      },
      onIntentPreview: async (intent) => {
        pushStatic(createLogEntry({ type: 'system', content: formatIntentPreview(intent) }))
        // Auto-continue in auto-accept mode — no user confirmation needed
        if (approvalMode === 'auto-accept') {
          return 'continue'
        }
        return new Promise<IntentPreviewAction>((resolve) => {
          setPendingIntent({ intent, resolve })
        })
      },
      onSteerDrain: () => {
        const steerText = steerBuffer.current.drain()
        if (steerText) {
          pushStatic(createLogEntry({ type: 'system', content: 'Steering guidance injected into agent context.' }))
        }
        return steerText
      },
    })
    } // end run

    // Serialize via flag — if a run is already in progress, guard against double-submit
    if (promptQueueRef.current.running) {
      return
    }
    promptQueueRef.current.running = true
    run().catch((err: Error) => {
      pushStatic(createLogEntry({ type: 'system', content: `Queue error: ${err.message}`, isError: true }))
      // Only flip if no newer run has started since this one
      if (isCurrentGeneration(myGen, streamGenRef.current)) {
        setIsStreaming(false)
      }
    }).finally(() => {
      promptQueueRef.current.running = false
    })
  }, [agent, session, pushStatic, pushStaticBatch, flushStaticBatch, flushThink, flushTools, projectActivity, model, maxTokens, availableModels, onModelSwitch, currentSessionId, cost, cacheHitRate, setVerbose, setAutoSafe, pushTokenHistory])

  return (
    <>
      {historyItems.length === 0 && !isStreaming && (
        <WelcomeScreen model={model} cwd={process.cwd()} />
      )}
      <Static
        items={shouldUseStaticHistory(isStreaming, supportsAnsiEscapes) ? staticItemsForInk : []}
        key="static-history"
      >
        {(item) => <React.Fragment key={renderMemoKey(item)}>{renderStaticEntry(item, verbose)}</React.Fragment>}
      </Static>
      <Box flexDirection="column">
        {activeOverlay === 'starmap' && (
          <StarmapView
            activePhase={phaseFromSummary(summaryState)}
            turnCount={summaryState.turnCount ?? 0}
            maxTurns={summaryState.maxTurns ?? 50}
            elapsedMs={summaryState.elapsedMs}
            recentRadio={chronicleRef.current.getRecentRadio(5)}
          />
        )}
        {activeOverlay === 'chronicle' && (
          <ChronicleView
            segments={chronicleRef.current.getPhaseSegments()}
            elapsedMs={summaryState.elapsedMs}
          />
        )}
        {activeOverlay === 'cockpit' && <CockpitView panel={cockpitPanel} agent={agent} session={session} model={model} cacheHitRate={cacheHitRate} cost={cost} summaryState={summaryState} mcpManager={mcpManagerRef.current} claimStoreRef={claimStoreRef} />}
        {activeOverlay === 'pager' && <Pager entries={historyItems} verbose={verbose} onExit={() => { surfacePop() }} />}
        {sessionPrompt === 'waiting' && (
          <Box paddingX={2} borderStyle="single" borderColor="cyan">
            <Text bold color="cyan">Previous session found.</Text>
            <Text> Press <Text bold>r</Text> to restore, any other key to start fresh </Text>
          </Box>
        )}
        {/* liveTools elapsedMs relies on the 1s activity tick (activityIntervalRef) for re-render — see app.tsx:398 */}
        {liveTools.map(log => (
          log.toolName === 'ask_user_question'
            ? <QuestionCard key={log.id} question={log.content} />
            : <ToolCard key={log.id} name={log.toolName ?? ''} result={log.content} isStreaming verbose={verbose} elapsedMs={Date.now() - (toolStartMap.current.get(log.id) ?? Date.now())} />
        ))}
        <ThinkingCollapser thinking={streamingThinking} isStreaming={isStreaming && (!!streamingThinking || isThinkingActive)} focused={!!streamingThinking && !streamingText} completedDurationMs={completedThinkingDurationMs} />
        {(streamingText || isStreaming) && (
          <StreamOutput text={streamingText} isStreaming={isStreaming} />
        )}
        {heartbeatStatus && !streamingText && liveTools.length === 0 && !streamingThinking && (
          <Box paddingX={2}>
            <Text>◌ {heartbeatStatus}</Text>
          </Box>
        )}
        {/* Status base: GlanceBar + contextual footer stay adjacent to InputBar so long stream output above never separates them */}
        <GlanceBar
          pulses={glancePulses}
          phase={phaseFromSummary(summaryState)}
          cacheHitRate={cacheHitRate}
          cost={cost}
          model={model}
          isStreaming={isStreaming}
          historyCount={historyItems.length}
          domain={starDomain}
          branch={gitBranch}
          estimatedTokens={session.getEstimatedTokens()}
          maxTokens={maxTokens}
        />
        {fluencyStale && termRows >= 24 && (
          <Box paddingX={1}>
            <Text color={fluencyStale.level === 'action' ? theme.error : fluencyStale.level === 'warn' ? theme.warning : theme.dim}>
              {fluencyStale.level === 'action' ? '⚠ ' : fluencyStale.level === 'warn' ? '› ' : '· '}{fluencyStale.message}
            </Text>
          </Box>
        )}
        {pendingIntent && (
          <Box paddingX={2} borderStyle="single" borderColor="cyan">
            <Text bold color="cyan">{formatIntentPreview(pendingIntent.intent)}</Text>
          </Box>
        )}
        {pendingApproval && (
          <Box paddingX={2} borderStyle="single" borderColor="yellow">
            <Text bold color="yellow">Approve tool: {pendingApproval.name}?</Text>
            <Text> [y/n] </Text>
          </Box>
        )}
        {isSurfaceVisible('command-palette') && (
          <CommandPalette
            commands={getPaletteCommands()}
            onSelect={(name) => {
              surfacePop()
              if (name.startsWith('__surface:')) {
                surfacePush(name.slice('__surface:'.length))
                return
              }
              handleSubmit(name)
            }}
            onCancel={() => surfacePop()}
          />
        )}
        {isSurfaceVisible('rewind') && (
          <RewindList
            entries={getRewindEntries()}
            onSelect={(entry) => {
              surfacePop()
              handleRewind(entry)
            }}
            onCancel={() => surfacePop()}
          />
        )}
        <InputBar onSubmit={isStreaming ? (text: string) => {
          steerBuffer.current.push(text)
          pushStatic(createLogEntry({ type: 'system', content: `Guidance queued: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}" — will be injected at next opportunity` }))
        } : handleSubmit} disabled={!!pendingApproval || !!pendingIntent} vimEnabled={false} steerMode={isStreaming} inputRef={inputBarRef} />
        {steerPending && isStreaming && (
          <Box paddingX={2} borderStyle="round" borderColor="yellow">
            <Text color="yellow">📨 Queued ({steerBuffer.current.getPending().length}): </Text>
            <Text>{steerBuffer.current.getPending().slice(-1)[0]?.slice(0, 60)}{(steerBuffer.current.getPending().slice(-1)[0]?.length ?? 0) > 60 ? '...' : ''}</Text>
          </Box>
        )}
      </Box>
    </>
  )
}
