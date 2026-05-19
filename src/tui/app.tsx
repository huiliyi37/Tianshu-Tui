import { useState, useCallback, useRef, useEffect, useMemo, type RefObject } from 'react'
import { Box, Text, useInput, Static } from 'ink'
import gradient from 'gradient-string'
import { StatusBar } from './status-bar.js'
import { PHASE_GLYPHS, PHASE_SHORT_LABELS, type StarPhase } from '../agent/star-event.js'
import { InputBar } from './input.js'
import { StreamOutput } from './stream.js'
import { ThinkingCollapser } from './thinking.js'
import { ToolCard } from './tool-card.js'
import { UserMessage } from './user-message.js'
import { SystemMessage } from './system-message.js'
import { ToolGroup } from './tool-group.js'
import { AssistantMessage } from './assistant-message.js'
import { groupLogs } from './group-logs.js'
import { AgentStatus, toolLabel, type ToolCallItem } from './agent-status.js'
import { SummaryBar, type SummaryState } from './summary-bar.js'
import type { InterviewState } from './status-bar.js'
import { PhaseTracker } from './phase-tracker.js'
import { FluencyTracker } from './fluency-hook.js'
import { createRingBuffer } from './ring-buffer.js'
import { getTheme } from './theme.js'
import { AgentLoop } from '../agent/loop.js'
import { formatIntentPreview, type IntentPreview, type IntentPreviewAction } from '../agent/intent-preview.js'
import { SessionContext } from '../agent/context.js'
import { SessionPersist } from '../agent/session-persist.js'
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
import { openInEditor } from './external-editor.js'
import { handleSlashCommand, resolveAppPromptInput, type SlashHandlerContext } from './slash-commands.js'
import { BlockStreamWriter } from './block-stream-writer.js'
import { appendStreamWindow } from './stream-window.js'
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

const THINKING_FLUSH_MS = 200
const TOOL_FLUSH_MS = 120
const ACTIVE_THRESHOLD = 20
const LIVE_STREAM_MAX_CHARS = 50_000

// --- Static entry renderer ---

function renderStaticEntry(entry: LogEntry, verbose: boolean) {
  switch (entry.type) {
    case 'user_message':
      return <UserMessage key={entry.id} content={entry.content} />
    case 'assistant_message':
      return <AssistantMessage key={entry.id} content={entry.content} thinking={entry.thinking} />
    case 'tool':
      return <ToolCard key={entry.id} name={entry.toolName ?? ''} result={entry.content} isError={entry.isError} verbose={verbose} rawPath={entry.rawPath} />
    case 'tool_group':
      return <ToolGroup key={entry.id} tools={entry.children ?? []} verbose={verbose} />
    case 'checkpoint':
      return <Box key={entry.id} paddingX={2}><Text dimColor color="yellow">⚑ {entry.content}</Text></Box>
    case 'evidence':
      return <Box key={entry.id} paddingX={2} marginBottom={1} borderStyle="single" borderColor="green"><Text color="green">{entry.content}</Text></Box>
    case 'system':
      return <SystemMessage key={entry.id} content={entry.content} isError={entry.isError} />
    default:
      return <StreamOutput key={entry.id} text={entry.content} isStreaming={false} />
  }
}

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
    <Box flexDirection="column" paddingX={1} borderStyle="round" borderColor={theme.primary}>
      <Text color={theme.primary} bold>─── COCKPIT ───</Text>
      <CockpitRail activePanel={panel} panelStatuses={snap.panelStatuses} onSelect={() => {}} />
      {panel === 'summary' && <SummaryBar state={summaryState} />}
      {panel === 'trace' && <TracePanel events={snap.trace.events} />}
      {panel === 'verify' && <VerificationPanel filesRead={snap.verification.filesRead} filesModified={snap.verification.filesModified} verifications={snap.verification.runs} deliveryStatus={snap.verification.deliveryStatus} impactedFiles={snap.verification.impactedFiles} impactedTests={snap.verification.impactedTests} />}
      {panel === 'context' && snap.context && <ContextPanel estimatedTokens={snap.context.estimatedTokens} maxTokens={snap.context.maxTokens} rounds={snap.context.rounds} compactionState={snap.context.compactionState} brokenRounds={snap.context.brokenRounds} compactEvents={compactEvents.map(e => ({ turn: e.turn, tier: e.tier, beforeTokens: e.beforeTokens, afterTokens: e.afterTokens }))} layers={snap.context.layers} />}
      {panel === 'safety' && <SafetyPanel doomLoopLevel={snap.safety.doomLoopLevel} riskLevel={snap.safety.riskLevel} riskReasons={snap.safety.riskReasons} suggestedAction={snap.safety.suggestedAction} recentFingerprints={snap.safety.recentFingerprints} />}
      {panel === 'model' && <ModelPanel model={snap.model.name} cacheHitRate={snap.model.cacheHitRate} inputTokens={snap.model.inputTokens} outputTokens={snap.model.outputTokens} cacheReadTokens={snap.model.cacheReadTokens} cacheWriteTokens={snap.model.cacheWriteTokens} cost={snap.model.cost} routingReason={snap.model.routingReason ?? undefined} perTurnHitRate={snap.model.perTurnHitRate} recentTurnHitRate={snap.model.recentTurnHitRate} prewarmHits={snap.model.prewarmHits} prewarmMisses={snap.model.prewarmMisses} prewarmHitRate={snap.model.prewarmHitRate} cacheDiagnostic={snap.model.cacheDiagnostic} />}
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

// --- Main App ---

export function App({ agent, session, persist, model, maxTokens, availableModels, onModelSwitch, allProviders, currentProvider, currentSessionId, initialInput, mcpManagerRef, claimStoreRef, approvalMode }: AppProps) {
  const [frozenItems, setFrozenItems] = useState<LogEntry[]>([])
  const [activeItems, setActiveItems] = useState<LogEntry[]>([])
  const [liveTools, setLiveTools] = useState<LogEntry[]>([])
  const staticBuf = useMemo(() => createRingBuffer<LogEntry>(500), [])
  const frozenBuf = useMemo(() => createRingBuffer<LogEntry>(500), [])
  const liveToolsRef = useRef<LogEntry[]>([])

  const [streamingText, setStreamingText] = useState('')
  const [streamingThinking, setStreamingThinking] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [isThinkingActive, setIsThinkingActive] = useState(false)
  const [fluencyStale, setFluencyStale] = useState<string | null>(null)
  const [cost, setCost] = useState(0)
  const [cacheHitRate, setCacheHitRate] = useState(0)
  const [cacheStatus, setCacheStatus] = useState<import('./status-bar.js').CacheStatus>('healthy')
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null)
  const [pendingIntent, setPendingIntent] = useState<PendingIntentPreview | null>(null)
  const [sessionPrompt, setSessionPrompt] = useState<'waiting' | 'done'>('done')
  const [showPalette, setShowPalette] = useState(false)
  const [reasoningEffort, setReasoningEffortState] = useState<string>('')
  const reasoningSyncedRef = useRef(false)

  // Sync initial reasoning effort from agent config
  if (!reasoningSyncedRef.current) {
    reasoningSyncedRef.current = true
    const initial = agent.getReasoningEffort()
    if (initial) setReasoningEffortState(initial)
  }

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
  const [cockpitPanel, setCockpitPanel] = useState<Panel | null>(null)
  const cockpitPanelRef = useRef<Panel | null>(null)
  const [interviewState, setInterviewState] = useState<InterviewState | null>(null)
  const [clarityHistory, setClarityHistory] = useState<number[]>([])
  useEffect(() => { cockpitPanelRef.current = cockpitPanel }, [cockpitPanel])

  const pushStatic = useCallback((entry: LogEntry) => {
    staticBuf.push(entry)
    setActiveItems(staticBuf.items())
  }, [staticBuf])

  const pushStaticBatch = useCallback((entries: readonly LogEntry[]) => {
    for (const entry of entries) staticBuf.push(entry)
    setActiveItems(staticBuf.items())
  }, [staticBuf])

  const migrateToFrozen = useCallback(() => {
    const active = staticBuf.items()
    if (active.length <= ACTIVE_THRESHOLD) return
    const migrateCount = active.length - ACTIVE_THRESHOLD
    const toFreeze = staticBuf.drain(migrateCount)
    for (const item of toFreeze) frozenBuf.push(item)
    setFrozenItems(frozenBuf.items())
    setActiveItems(staticBuf.items())
  }, [staticBuf, frozenBuf])

  const streamStartRef = useRef(0)
  const thinkStartRef = useRef(0)
  const thinkTimeRef = useRef(0)
  const toolCallTracker = useRef<Map<string, ToolCallItem>>(new Map())
  const [toolCallsDisplay, setToolCallsDisplay] = useState<ToolCallItem[]>([])

  const streamBuf = useRef('')
  const thinkBuf = useRef('')
  const lastFlushedThink = useRef('')
  const blockWriterRef = useRef<BlockStreamWriter | null>(null)
  const textBatcher = useRef(new RenderBatcher<string>((texts) => {
    const combined = texts.join('')
    streamBuf.current += combined
    setStreamingText(prev => appendStreamWindow(prev, combined, LIVE_STREAM_MAX_CHARS))
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
  const [activitySummary, setActivitySummary] = useState<string | undefined>(undefined)
  const [completedThinkingDurationMs, setCompletedThinkingDurationMs] = useState<number | undefined>(undefined)
  const thinkingStartedAtRef = useRef(0)

  const rollbackTokenRef = useRef<string | null>(null)
  const lastCtrlCRef = useRef(0)
  const lastEscRef = useRef(0)

  // Tool target tracking for SummaryBar
  const toolTargetMap = useRef<Map<string, string>>(new Map())
  const recentToolLabels = useRef<string[]>([])

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

  const flushThink = useCallback(() => {
    thinkTimer.current = null
    if (thinkBuf.current !== lastFlushedThink.current) {
      lastFlushedThink.current = thinkBuf.current
      setStreamingThinking(thinkBuf.current)
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
    setActivitySummary(nextText)
  }, [])

  useEffect(() => {
    const sessions = SessionPersist.listSessions().filter(id => id !== currentSessionId)
    if (sessions.length > 0) {
      setSessionPrompt('waiting')
    }
  }, [currentSessionId])

  useEffect(() => {
    const t = getTheme()
    const banner = gradient([t.primary, t.secondary])('◆ R I V E T')
    pushStatic(createLogEntry({ type: 'system', content: banner }))
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
      // Also feed phase duration + turn count into SummaryBar for live heartbeat
      const phaseMs = now - activityRef.current.startedAt
      setSummaryState(prev => {
        if (prev.phaseDurationMs === phaseMs && prev.turnCount === turnCountRef.current) return prev
        return { ...prev, phaseDurationMs: phaseMs, turnCount: turnCountRef.current, maxTurns: maxTurnsRef.current }
      })
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
      setFluencyStale(policy.staleMessage ?? null)
    }, 2000)
    return () => clearInterval(id)
  }, [isStreaming])

  useInput((_input, _key) => {
    // Ctrl+C — soft interrupt or exit
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
        setIsStreaming(false)
        pushStatic(createLogEntry({ type: 'system', content: '⏹ Interrupted.' }))
        lastCtrlCRef.current = Date.now()
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

    // Escape — close cockpit or double-press to interrupt streaming
    if (_key.escape) {
      if (cockpitPanel) {
        setCockpitPanel(null)
        return
      }
      if (isStreaming) {
        const now = Date.now()
        if (lastEscRef.current && now - lastEscRef.current < 1000) {
          agent.abort()
          setIsStreaming(false)
          pushStatic(createLogEntry({ type: 'system', content: '⏹ Interrupted.' }))
          lastEscRef.current = 0
        } else {
          lastEscRef.current = now
          pushStatic(createLogEntry({ type: 'system', content: '(Esc again to interrupt)' }))
        }
        return
      }
      return
    }
    if (sessionPrompt === 'waiting') {
      const sessions = SessionPersist.listSessions().filter(id => id !== currentSessionId)
      if (_input === 'r' && sessions.length > 0) {
        const id = sessions[0]!
        const p = new SessionPersist(id)
        const recovery = p.loadRecoverableMessages()
        const msgs = recovery.messages
        session.loadMessages(msgs)
        const { entries, toolCount, turnCount } = replayMessagesToLogEntries(msgs)
        for (const entry of entries) frozenBuf.push(entry)
        setFrozenItems(frozenBuf.items())
        const tcPct = Math.min(session.getEstimatedTokens() / maxTokens, 1)
        setCacheHitRate(session.getCacheHitRate())
        setSummaryState(prev => ({ ...prev, contextPct: tcPct, tokenHistory: pushTokenHistory(tcPct) }))
        const recoveryNote = recovery.usedSnapshot
          ? `, rolled back to turn ${recovery.snapshotTurn}`
          : recovery.preflight.repaired
            ? `, repaired ${recovery.preflight.syntheticResultsInserted} missing tool result(s)`
            : ''
        pushStatic(createLogEntry({ type: 'system', content: `Restored session ${id.slice(0, 8)}... (${turnCount} turns, ${toolCount} tools${recoveryNote})` }))
      }
      setSessionPrompt('done')
      return
    }

    if (_key.ctrl && _input === '\x0b') {
      setShowPalette(prev => !prev)
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

  const handleSubmit = useCallback((_userInput: string) => {
    let userInput = _userInput
    const run = async () => {
    setIsStreaming(true)
    setIsThinkingActive(false)
    setStreamingText('')
    setStreamingThinking('')
    setLiveTools([])
    liveToolsRef.current = []
    setFluencyStale(null)
    fluencyRef.current.onTurnComplete()
    foldedCountRef.current = 0
    migrateToFrozen()

    streamBuf.current = ''
    thinkBuf.current = ''
    lastFlushedThink.current = ''
    toolAccum.current.clear()
    dirtyTools.current.clear()
    toolNames.current.clear()
    toolTargetMap.current.clear()

    // Reset activity projection state
    activityRef.current = clearActivity(activityRef.current, Date.now())
    activityTextRef.current = undefined
    activityProjectedAtRef.current = 0
    setActivitySummary(undefined)
    setCompletedThinkingDurationMs(undefined)
    thinkingStartedAtRef.current = 0

    blockWriterRef.current = new BlockStreamWriter({}, (text) => {
      textBatcher.current.push(text)
    })

    streamStartRef.current = Date.now()
    thinkStartRef.current = 0
    thinkTimeRef.current = 0
    toolCallTracker.current.clear()
    setToolCallsDisplay([])

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
        setVerbose, setAutoSafe, rollbackTokenRef, cockpitPanelRef,
        setCockpitPanel, pushStatic, setIsStreaming, setCacheHitRate, setSummaryState,
        mcpManagerRef, claimStoreRef,
        setReasoningEffort: (effort) => {
          agent.setReasoningEffort(effort)
          setReasoningEffortState(effort)
        },
        reasoningEffort,
      }
      if (handleSlashCommand(slashCtx)) return
    }

    const promptInput = resolveAppPromptInput(userInput, process.cwd())
    pushStatic(createLogEntry({ type: 'user_message', content: originalUserInput }))

    await agent.run(promptInput, {
      onTextDelta: (text) => {
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
        if (!thinkTimer.current) {
          thinkTimer.current = setTimeout(flushThink, THINKING_FLUSH_MS)
        }
      },
      onToolUse: (id, name, input) => {
        toolNames.current.set(id, name)
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
        toolCallTracker.current.set(id, { id, name, label, done: false, error: false })
        setToolCallsDisplay([...toolCallTracker.current.values()])

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
          pushStatic(createLogEntry({ type: 'tool', id, toolName, content: finalContent, isError, rawPath }))
        }

        const tcEntry = toolCallTracker.current.get(id)
        if (tcEntry) {
          tcEntry.done = true
          tcEntry.error = !!isError
          setToolCallsDisplay([...toolCallTracker.current.values()])
        }

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
        // Sync reasoning effort from agent (auto-reasoning may have changed it)
        const currentEffort = agent.getReasoningEffort()
        if (currentEffort && currentEffort !== reasoningEffort) {
          setReasoningEffortState(currentEffort)
        }

        if (dirtyTools.current.size > 0) {
          flushTools()
        }

        turnCountRef.current = turnNumber

        // Intermediate turn: update activity, freeze tools, reset thinking — but keep writer alive
        if (isFinal === false) {
          textBatcher.current.flushNow()
          if (thinkStartRef.current > 0) {
            thinkTimeRef.current = Date.now() - thinkStartRef.current
            thinkStartRef.current = 0
          }
          const midNow = Date.now()
          if (activityRef.current.phase !== 'idle') {
            activityRef.current = completeActivity(activityRef.current, midNow)
            projectActivity(midNow)
          }
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
                pushStatic(createLogEntry({ type: 'assistant_message', content: parsed.cleanText, thinking: thinkBuf.current || undefined }))
              }
            } else {
              pushStatic(createLogEntry({ type: 'assistant_message', content: finalText, thinking: thinkBuf.current || undefined }))
            }
          } else {
            // Only thinking, no visible text — still preserve for history
            pushStatic(createLogEntry({ type: 'assistant_message', content: '', thinking: thinkBuf.current }))
          }
        }
        // Stop streaming FIRST so StreamOutput unmounts while text is still present,
        // then clear text — prevents blank-cursor flash frame on turn completion.
        setIsStreaming(false)
        setStreamingText('')

        if (thinkTimer.current) {
          clearTimeout(thinkTimer.current)
          thinkTimer.current = null
        }
        lastFlushedThink.current = thinkBuf.current
        setStreamingThinking(thinkBuf.current)
        thinkBuf.current = ''

        const remaining = liveToolsRef.current
        if (remaining.length > 0) {
          pushStaticBatch(remaining)
        }
        liveToolsRef.current = []
        setLiveTools([])

        // Turn-level cache hit rate for StatusBar (last 3 turns)
        const recentHitRate = session.getRecentTurnHitRate(3) ?? session.getCacheHitRate()
        setCacheHitRate(recentHitRate)

        // Detect cache degradation after compaction
        const latestHitRate = session.getLatestTurnHitRate()
        const wasCompacted = turnNumber > 1 && session.wasCompactedAt(turnNumber - 1)
        if (latestHitRate !== null && latestHitRate < 0.4 && turnNumber > 1) {
          if (wasCompacted) {
            setCacheStatus('degraded')
            pushStatic(createLogEntry({ type: 'system', content: `Cache degraded (${(latestHitRate * 100).toFixed(0)}%) — compaction restructured prefix. Normal on next turn.` }))
          } else {
            setCacheStatus('degraded')
          }
        } else if (latestHitRate !== null && latestHitRate >= 0.6) {
          setCacheStatus(cacheStatus === 'degraded' ? 'recovering' : 'healthy')
        } else {
          setCacheStatus('healthy')
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


      },
      onPhaseChange: (phase, detail) => {
        if (phase === 'tianshu-radio' && detail?.reason) {
          pushStatic(createLogEntry({ type: 'system', content: detail.reason }))
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
          pushStatic(createLogEntry({ type: 'assistant_message', content: streamBuf.current, thinking: thinkBuf.current || undefined }))
        }
        streamBuf.current = ''
        // Stop streaming FIRST, then clear text — prevents flash frame on error.
        setIsStreaming(false)
        setStreamingText('')
        thinkBuf.current = ''
        setStreamingThinking('')
        // Clear tool state from failed run
        toolAccum.current.clear()
        toolNames.current.clear()
        dirtyTools.current.clear()
        toolTargetMap.current.clear()
        toolCallTracker.current.clear()
        liveToolsRef.current = []
        setLiveTools([])
        pushStatic(createLogEntry({ type: 'system', content: `Error: ${error.message}`, isError: true }))
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
          pushStatic(createLogEntry({ type: 'assistant_message', content: streamBuf.current, thinking: thinkBuf.current || undefined }))
        }
        streamBuf.current = ''
        // Stop streaming FIRST, then clear text — prevents flash frame on abort.
        setIsStreaming(false)
        setStreamingText('')
        thinkBuf.current = ''
        setStreamingThinking('')
        // Clear tool state from aborted run
        toolAccum.current.clear()
        toolNames.current.clear()
        dirtyTools.current.clear()
        toolTargetMap.current.clear()
        toolCallTracker.current.clear()
        liveToolsRef.current = []
        setLiveTools([])
        pushStatic(createLogEntry({ type: 'system', content: '⏹ Interrupted.' }))
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
      setIsStreaming(false)
    }).finally(() => {
      promptQueueRef.current.running = false
    })
  }, [agent, session, pushStatic, pushStaticBatch, migrateToFrozen, flushThink, flushTools, projectActivity, model, maxTokens, availableModels, onModelSwitch, currentSessionId, cost, cacheHitRate, setVerbose, setAutoSafe, pushTokenHistory])

  const currentTokens = session.getEstimatedTokens()
  const tokenEstimate = Math.floor(streamingText.length / 4)
  const groupedActive = useMemo(() => groupLogs(activeItems), [activeItems])

  return (
    <>
      <Static items={frozenItems}>
        {(item) => renderStaticEntry(item, verbose)}
      </Static>
      <Static items={groupedActive}>
        {(item) => renderStaticEntry(item, verbose)}
      </Static>
      <Box flexDirection="column">
        <StatusBar
          model={model}
          cacheHitRate={cacheHitRate}
          cacheStatus={cacheStatus}
          totalCost={cost.toFixed(2)}
          currentTokens={currentTokens}
          maxTokens={maxTokens}
          contextHealth={session.getContextLedger()?.tokenBudget.compactionState ?? 'healthy'}
          apiSafe={(session.getContextLedger()?.apiInvariantStatus.brokenRounds ?? 0) === 0}
          interview={interviewState}
          clarityHistory={clarityHistory}
          reasoningEffort={reasoningEffort}
        />
        {isStreaming && !cockpitPanel && <SummaryBar state={summaryState} />}
        {cockpitPanel && <CockpitView panel={cockpitPanel} agent={agent} session={session} model={model} cacheHitRate={cacheHitRate} cost={cost} summaryState={summaryState} mcpManager={mcpManagerRef.current} claimStoreRef={claimStoreRef} />}
        {sessionPrompt === 'waiting' && (
          <Box paddingX={2} borderStyle="single" borderColor="cyan">
            <Text bold color="cyan">Previous session found.</Text>
            <Text> Press <Text bold>r</Text> to restore, any other key to start fresh </Text>
          </Box>
        )}
        {liveTools.map(log => (
          <ToolCard key={log.id} name={log.toolName ?? ''} result={log.content} isStreaming verbose={verbose} />
        ))}
        {(streamingText || isStreaming) && (
          <StreamOutput text={streamingText} isStreaming={isStreaming} />
        )}
        {fluencyStale && !streamingText && (
          <Box paddingX={2}>
            <Text dimColor color="yellow">⚠ {fluencyStale}</Text>
          </Box>
        )}
        <ThinkingCollapser thinking={streamingThinking} isStreaming={isStreaming && !!streamingThinking} focused={!!streamingThinking} completedDurationMs={completedThinkingDurationMs} />
        <AgentStatus
          isStreaming={isStreaming}
          startMs={streamStartRef.current || Date.now()}
          tokenEstimate={tokenEstimate}
          thinkingTime={thinkTimeRef.current}
          hasActiveThinking={isThinkingActive}
          tools={toolCallsDisplay}
          activitySummary={activitySummary}
        />
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
        {showPalette && (
          <CommandPalette
            commands={getPaletteCommands()}
            onSelect={(name) => {
              setShowPalette(false)
              handleSubmit(name)
            }}
            onCancel={() => setShowPalette(false)}
          />
        )}
        <InputBar onSubmit={isStreaming ? (text: string) => {
          steerBuffer.current.push(text)
          pushStatic(createLogEntry({ type: 'system', content: `Guidance queued: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}" — will be injected at next opportunity` }))
        } : handleSubmit} disabled={!!pendingApproval || !!pendingIntent} vimEnabled={false} />
        {steerPending && isStreaming && (
          <Box paddingX={2}>
            <Text dimColor color="cyan">Pending guidance queued for injection</Text>
          </Box>
        )}
      </Box>
    </>
  )
}
