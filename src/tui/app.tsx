import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { Box, Text, useInput, Static } from 'ink'
import gradient from 'gradient-string'
import { StatusBar } from './status-bar.js'
import { InputBar } from './input.js'
import { StreamOutput } from './stream.js'
import { ThinkingCollapser } from './thinking.js'
import { ToolCard } from './tool-card.js'
import { AgentStatus, toolLabel, type ToolCallItem } from './agent-status.js'
import { SummaryBar, type SummaryState } from './summary-bar.js'
import { PhaseTracker } from './phase-tracker.js'
import { createRingBuffer } from './ring-buffer.js'
import { getTheme, setTheme, getActiveThemeName, type ThemeName } from './theme.js'
import { AgentLoop } from '../agent/loop.js'
import { SessionContext } from '../agent/context.js'
import { SessionPersist } from '../agent/session-persist.js'
import { microCompact, estimateTokens } from '../compact/micro.js'
import { rollbackToCheckpoint, getRollbackPreview } from '../agent/checkpoint.js'
import { createLogEntry, summarizeToolOutput, type LogEntry } from './log-state.js'
import { diagnoseCacheMiss } from '../prompt/cache-diagnostic.js'
import { runResumePreflight } from '../context/resume-preflight.js'
import type { McpManager } from '../mcp/manager.js'
import { CockpitRail, TracePanel, VerificationPanel, ContextPanel, SafetyPanel, ModelPanel, McpPanel } from './cockpit/index.js'
import { buildCockpitSnapshot } from './cockpit/state.js'
import type { Panel } from './cockpit/types.js'
import { PANEL_LABELS } from './cockpit/types.js'

interface PendingApproval {
  id: string
  name: string
  input: Record<string, unknown>
  resolve: (approved: boolean) => void
}

interface AppProps {
  agent: AgentLoop
  session: SessionContext
  persist: SessionPersist
  model: string
  maxTokens: number
  availableModels: Array<{ id: string; alias: string }>
  onModelSwitch: (modelId: string) => void
  currentSessionId: string
  initialInput?: string
  mcpManagerRef: React.MutableRefObject<McpManager | null>
}

const STREAM_FLUSH_MS = 80
const THINKING_FLUSH_MS = 200
const TOOL_FLUSH_MS = 120

// --- Slash command handler ---

interface SlashHandlerContext {
  parts: string[]
  agent: AgentLoop
  session: SessionContext
  persist: SessionPersist
  model: string
  maxTokens: number
  availableModels: Array<{ id: string; alias: string }>
  onModelSwitch: (modelId: string) => void
  currentSessionId: string
  cost: number
  cacheHitRate: number
  autoSafeRef: React.MutableRefObject<boolean>
  verboseRef: React.MutableRefObject<boolean>
  setVerbose: (v: boolean) => void
  setAutoSafe: (v: boolean) => void
  rollbackTokenRef: React.MutableRefObject<string | null>
  cockpitPanelRef: React.MutableRefObject<Panel | null>
  setCockpitPanel: (v: Panel | null | ((prev: Panel | null) => Panel | null)) => void
  pushStatic: (entry: LogEntry) => void
  setIsStreaming: (v: boolean) => void
  setCacheHitRate: (v: number) => void
  setSummaryState: (v: SummaryState | ((prev: SummaryState) => SummaryState)) => void
  mcpManagerRef: React.MutableRefObject<McpManager | null>
}

function handleSlashCommand(ctx: SlashHandlerContext): boolean {
  const { parts, pushStatic, setIsStreaming } = ctx
  const cmd = parts[0]!.toLowerCase()

  switch (cmd) {
    case '/help':
      pushStatic(createLogEntry({ type: 'text', content: `Available commands:
/help — Show this help
/exit — Exit Rivet
/quit — Exit
/compact — Compact conversation context
/model [name|list] — Show or switch model
/verbose — Toggle verbose tool output
/debug [prompt|fingerprint|cache|mcp] — Debug prefix cache, prompt, and MCP connections
/clear — Clear screen (visual only)
/sessions — List all saved sessions
/resume <number> — Restore a saved session
/memory [text] — Show or save session memory entries
/rollback — Preview changes since last checkpoint (/rollback confirm to execute)
/context — Show context ledger health, tokens, rounds, and compact events
/evidence — Show last turn evidence summary
/mcp — Show MCP server status
/auto — Toggle auto-approve (current: ${ctx.autoSafeRef.current ? 'auto-safe' : 'manual'})
/theme [pastel|cyberpunk|list] — Switch color theme
/cockpit [summary|trace|verify|context|safety|model|off] — Toggle or switch cockpit panel
Ctrl+C — Interrupt current turn (press twice to exit)` }))
      setIsStreaming(false)
      return true

    case '/exit':
    case '/quit':
      ctx.persist.compact(ctx.session.getMessages())
      pushStatic(createLogEntry({ type: 'text', content: 'Session saved. Goodbye!' }))
      process.exit(0)

    case '/compact':
      pushStatic(createLogEntry({ type: 'text', content: 'Compacting conversation...' }))
      { const msgs = ctx.session.getMessages()
        const { messages: compacted, truncated } = microCompact(msgs, ctx.maxTokens, estimateTokens(msgs))
        ctx.session.replaceMessages(compacted)
        ctx.session.recordCompactEvent({
          turn: ctx.session.getTurnCount(),
          tier: 1,
          reason: 'manual /compact command',
          beforeTokens: estimateTokens(msgs),
          afterTokens: estimateTokens(compacted),
          createdAt: Date.now(),
        })
        pushStatic(createLogEntry({ type: 'text', content: `Compacted: removed ${truncated} messages. ${compacted.length} remaining.` }))
        ctx.setSummaryState(prev => ({ ...prev, compactEvent: { beforeTokens: estimateTokens(msgs), afterTokens: estimateTokens(compacted) } }))
        setTimeout(() => ctx.setSummaryState(prev => ({ ...prev, compactEvent: null })), 5000)
      }
      setIsStreaming(false)
      ctx.setCacheHitRate(ctx.session.getCacheHitRate())
      return true

    case '/model': {
      const targetModel = parts[1]
      if (!targetModel || targetModel === 'list') {
        const list = ctx.availableModels.map(m =>
          `  ${m.alias} (${m.id})${m.alias === ctx.model ? ' ← current' : ''}`
        ).join('\n')
        pushStatic(createLogEntry({ type: 'text', content: `Available models:\n${list}\n\nCurrent: ${ctx.model}\nContext: ${ctx.maxTokens.toLocaleString()} tokens\nCost: ¥${ctx.cost.toFixed(4)}` }))
      } else {
        const found = ctx.availableModels.find(m => m.alias === targetModel || m.id === targetModel)
        if (found) {
          ctx.onModelSwitch(found.id)
          pushStatic(createLogEntry({ type: 'text', content: `Switched to ${found.alias} (${found.id})` }))
        } else {
          pushStatic(createLogEntry({ type: 'text', content: `Model "${targetModel}" not found. Use /model list to see available models.` }))
        }
      }
      setIsStreaming(false)
      return true
    }

    case '/verbose': {
      const nextVerbose = !ctx.verboseRef.current
      ctx.setVerbose(nextVerbose)
      pushStatic(createLogEntry({ type: 'text', content: nextVerbose ? 'Verbose mode: on (show 200 lines)' : 'Verbose mode: off (show 20 lines)' }))
      setIsStreaming(false)
      return true
    }

    case '/auto': {
      const next = !ctx.autoSafeRef.current
      ctx.setAutoSafe(next)
      ctx.agent.setApprovalMode(next ? 'auto-safe' : 'manual')
      pushStatic(createLogEntry({ type: 'text', content: next ? 'Auto-approve: on (auto-safe — high-risk still requires approval)' : 'Auto-approve: off (manual — all mutating tools require approval)' }))
      setIsStreaming(false)
      return true
    }

    case '/theme': {
      const raw = parts[1]?.toLowerCase()
      const validThemes: ThemeName[] = ['pastel', 'cyberpunk']
      if (!raw || raw === 'list') {
        const current = getActiveThemeName()
        const list = validThemes.map(t => `  ${t}${t === current ? ' ← current' : ''}`).join('\n')
        pushStatic(createLogEntry({ type: 'text', content: `Available themes:\n${list}\n\nUsage: /theme <name>` }))
      } else if ((validThemes as string[]).includes(raw)) {
        setTheme(raw as ThemeName)
        pushStatic(createLogEntry({ type: 'text', content: `Theme switched to: ${raw}` }))
      } else {
        pushStatic(createLogEntry({ type: 'text', content: `Theme "${raw}" not found. Available: ${validThemes.join(', ')}` }))
      }
      setIsStreaming(false)
      return true
    }

    case '/debug': {
      const subcmd = parts[1]
      const info = ctx.agent.getDebugInfo()
      if (subcmd === 'prompt') {
        pushStatic(createLogEntry({ type: 'text', content: `System prompt (${info.systemPromptLength} chars):\n${info.systemPromptPreview}\n\nTools (${info.toolCount}): ${info.toolNames.join(', ')}` }))
      } else if (subcmd === 'fingerprint') {
        const fp = info.fingerprint
        const drift = info.drift
        pushStatic(createLogEntry({ type: 'text', content: `Fingerprint:\n  system:  ${fp.systemSha256.slice(0, 16)}...\n  tools:   ${fp.toolsSha256.slice(0, 16)}...\n  combined: ${fp.combinedSha256.slice(0, 16)}...\n\nDrift: ${drift ? drift.message : 'none (cache stable)'}` }))
      } else if (subcmd === 'cache') {
        const usage = ctx.session.getTotalUsage()
        const hitRate = ctx.cacheHitRate
        const totalCached = usage.cache_read_input_tokens + usage.cache_creation_input_tokens
        pushStatic(createLogEntry({ type: 'text', content: `Cache:\n  hit rate: ${(hitRate * 100).toFixed(1)}%\n  read tokens: ${usage.cache_read_input_tokens.toLocaleString()}\n  write tokens: ${usage.cache_creation_input_tokens.toLocaleString()}\n  total cached: ${totalCached.toLocaleString()}\n  input tokens: ${usage.input_tokens.toLocaleString()}\n  output tokens: ${usage.output_tokens.toLocaleString()}\n  estimated: ${ctx.session.getEstimatedTokens().toLocaleString()}\n  cost: ¥${ctx.cost.toFixed(4)}\n  saved: ¥${((usage.cache_read_input_tokens * 0.9) / 1_000_000).toFixed(4)} (cache discount)` }))
      } else if (subcmd === 'mcp') {
        const mgr = ctx.mcpManagerRef.current
        if (!mgr) {
          pushStatic(createLogEntry({ type: 'text', content: 'MCP not initialized (no servers configured or MCP disabled).' }))
        } else {
          const states = mgr.getStates()
          const tools = mgr.getAllTools()
          const lines = [`MCP Status (${states.length} server(s), ${tools.length} tool(s)):`]
          for (const s of states) {
            const detail = s.status === 'connected'
              ? `connected — ${s.toolCount} tools`
              : s.status === 'error'
                ? `error: ${s.error}`
                : s.status
            lines.push(`  ${s.serverId}: ${detail}`)
          }
          if (tools.length > 0) {
            lines.push('Tools: ' + tools.map(t => t.definition.name).join(', '))
          }
          pushStatic(createLogEntry({ type: 'text', content: lines.join('\n') }))
        }
      } else {
        pushStatic(createLogEntry({ type: 'text', content: 'Usage: /debug [prompt|fingerprint|cache|mcp]' }))
      }
      setIsStreaming(false)
      return true
    }

    case '/rollback':
      // Async — handled in calling context
      return false

    case '/clear':
      setIsStreaming(false)
      return true

    case '/sessions': {
      const sessions = SessionPersist.listSessions()
      if (sessions.length === 0) {
        pushStatic(createLogEntry({ type: 'text', content: 'No saved sessions.' }))
      } else {
        const list = sessions.map((id, i) => {
          const marker = id === ctx.currentSessionId ? ' ← current' : ''
          return `${i + 1}. ${id.slice(0, 8)}...${marker}`
        }).join('\n')
        pushStatic(createLogEntry({ type: 'text', content: `Saved sessions:\n${list}\n\n/resume <number> to restore` }))
      }
      setIsStreaming(false)
      return true
    }

    case '/resume': {
      const sessions = SessionPersist.listSessions()
      const idx = parseInt(parts[1] ?? '', 10) - 1
      if (isNaN(idx) || idx < 0 || idx >= sessions.length) {
        pushStatic(createLogEntry({ type: 'text', content: `Invalid session number. Use /sessions to see available sessions.` }))
        setIsStreaming(false)
        return true
      }
      const targetId = sessions[idx]!
      const p = new SessionPersist(targetId)
      const rawMsgs = p.load()
      const preflight = runResumePreflight(rawMsgs)
      ctx.session.replaceMessages(preflight.messages)
      if (preflight.repaired) {
        p.compact(preflight.messages)
      }
      pushStatic(createLogEntry({ type: 'text', content: `Restored session ${targetId.slice(0, 8)}... (${preflight.messages.length} messages, apiSafe=${preflight.safe})` }))
      if (preflight.repaired) {
        pushStatic(createLogEntry({ type: 'text', content: `Resume preflight: repaired ${preflight.syntheticResultsInserted} orphan tool call(s).` }))
      }
      setIsStreaming(false)
      return true
    }

    case '/context': {
      const ledger = ctx.session.getContextLedger()
      if (!ledger) {
        pushStatic(createLogEntry({ type: 'text', content: 'Context ledger not available yet. Send a message to build the first ledger snapshot.' }))
        setIsStreaming(false)
        return true
      }

      const sections = ledger.tokenBudget
      const diagnostics = ledger.apiInvariantStatus.brokenRounds === 0
        ? 'API rounds: safe'
        : `⚠ ${ledger.apiInvariantStatus.brokenRounds} broken rounds`
      const compacts = ctx.session.getCompactEvents()
      const compactStr = compacts.length === 0
        ? 'No compact events.'
        : compacts.slice(-5).map(e => `- turn ${e.turn}: tier ${e.tier}, ${e.beforeTokens}→${e.afterTokens}`).join('\n')

      pushStatic(createLogEntry({
        type: 'text',
        content: `Context: ${sections.compactionState}\nTokens: ${sections.estimatedTokens.toLocaleString()}/${sections.maxTokens.toLocaleString()} (${Math.round(sections.estimatedTokens / sections.maxTokens * 100)}%)\nRounds: ${ledger.rounds.length}\n${diagnostics}\n\nCompaction:\n${compactStr}`,
      }))
      setIsStreaming(false)
      return true
    }

    case '/memory': {
      const text = parts.slice(1).join(' ').trim()
      if (!text) {
        const memory = ctx.persist.loadMemory()
        const content = memory.entries.length === 0
          ? 'Session memory is empty.'
          : memory.entries.map(entry => `- [${entry.source}] ${entry.text}`).join('\n')
        pushStatic(createLogEntry({ type: 'text', content }))
      } else {
        ctx.persist.appendMemory({ text, source: 'manual', createdAt: Date.now() })
        ctx.agent.updateSessionMemory(ctx.persist.buildMemoryBlock())
        pushStatic(createLogEntry({ type: 'text', content: 'Saved to session memory.' }))
      }
      setIsStreaming(false)
      return true
    }

    case '/mcp': {
      pushStatic(createLogEntry({ type: 'text', content: 'MCP status: use /debug mcp for detailed connection info, or check startup logs.' }))
      setIsStreaming(false)
      return true
    }

    case '/cockpit': {
      const subcmd = parts[1] as Panel | 'off' | undefined
      if (subcmd === 'off') {
        ctx.setCockpitPanel(null)
        pushStatic(createLogEntry({ type: 'text', content: 'Cockpit panel collapsed.' }))
      } else if (subcmd && subcmd in PANEL_LABELS) {
        ctx.setCockpitPanel(subcmd as Panel)
        pushStatic(createLogEntry({ type: 'text', content: `Cockpit: ${PANEL_LABELS[subcmd as Panel]} panel. /cockpit off to collapse.` }))
      } else {
        ctx.setCockpitPanel(prev => prev ? null : 'summary')
        pushStatic(createLogEntry({ type: 'text', content: ctx.cockpitPanelRef.current ? `Cockpit: ${PANEL_LABELS[ctx.cockpitPanelRef.current]} panel. /cockpit off to collapse.` : 'Cockpit panel collapsed.' }))
      }
      setIsStreaming(false)
      return true
    }
  }

  return false
}

// --- Static entry renderer ---

function renderStaticEntry(entry: LogEntry, verbose: boolean) {
  switch (entry.type) {
    case 'tool':
      return <ToolCard key={entry.id} name={entry.toolName ?? ''} result={entry.content} isError={entry.isError} verbose={verbose} rawPath={entry.rawPath} />
    case 'checkpoint':
      return <Box key={entry.id} paddingX={2}><Text dimColor color="yellow">⚑ {entry.content}</Text></Box>
    case 'evidence':
      return <Box key={entry.id} paddingX={2} marginBottom={1} borderStyle="single" borderColor="green"><Text color="green">{entry.content}</Text></Box>
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
}

function CockpitView({ panel, agent, session, model, cacheHitRate, cost, summaryState, mcpManager }: CockpitViewProps) {
  const theme = getTheme()
  const snap = useMemo(
    () => buildCockpitSnapshot({ agent, session, model, cacheHitRate, cost, mcpManager }),
    [agent, session, model, cacheHitRate, cost, mcpManager],
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
      {panel === 'model' && <ModelPanel model={snap.model.name} cacheHitRate={snap.model.cacheHitRate} inputTokens={snap.model.inputTokens} outputTokens={snap.model.outputTokens} cacheReadTokens={snap.model.cacheReadTokens} cacheWriteTokens={snap.model.cacheWriteTokens} cost={snap.model.cost} routingReason={snap.model.routingReason ?? undefined} />}
      {panel === 'mcp' && <McpPanel servers={snap.mcp.servers} totalTools={snap.mcp.totalTools} connectedServers={snap.mcp.connectedServers} />}
    </Box>
  )
}

// --- Main App ---

export function App({ agent, session, persist, model, maxTokens, availableModels, onModelSwitch, currentSessionId, initialInput, mcpManagerRef }: AppProps) {
  const [staticItems, setStaticItems] = useState<LogEntry[]>([])
  const [liveTools, setLiveTools] = useState<LogEntry[]>([])
  const staticBuf = useMemo(() => createRingBuffer<LogEntry>(500), [])

  const [streamingText, setStreamingText] = useState('')
  const [streamingThinking, setStreamingThinking] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [cost, setCost] = useState(0)
  const [cacheHitRate, setCacheHitRate] = useState(0)
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null)
  const [sessionPrompt, setSessionPrompt] = useState<'waiting' | 'done'>('done')

  const [verbose, _setVerbose] = useState(false)
  const [, _setAutoSafe] = useState(true)
  const verboseRef = useRef(false)
  const autoSafeRef = useRef(true)
  const setVerbose = useCallback((v: boolean) => { verboseRef.current = v; _setVerbose(v) }, [])
  const setAutoSafe = useCallback((v: boolean) => { autoSafeRef.current = v; _setAutoSafe(v) }, [])

  const phaseTracker = useRef(new PhaseTracker())
  const [summaryState, setSummaryState] = useState<SummaryState>({
    task: '', phase: 'idle', stepCount: 0, totalSteps: 0,
    contextPct: 0, elapsedMs: 0, lastAction: null, risk: 'none',
  })
  const [cockpitPanel, setCockpitPanel] = useState<Panel | null>(null)
  const cockpitPanelRef = useRef<Panel | null>(null)
  useEffect(() => { cockpitPanelRef.current = cockpitPanel }, [cockpitPanel])

  const pushStatic = useCallback((entry: LogEntry) => {
    staticBuf.push(entry)
    setStaticItems(staticBuf.items())
  }, [staticBuf])

  const streamStartRef = useRef(0)
  const thinkStartRef = useRef(0)
  const thinkTimeRef = useRef(0)
  const toolCallTracker = useRef<Map<string, ToolCallItem>>(new Map())
  const [toolCallsDisplay, setToolCallsDisplay] = useState<ToolCallItem[]>([])

  const streamBuf = useRef('')
  const thinkBuf = useRef('')
  const lastFlushedStream = useRef('')
  const lastFlushedThink = useRef('')
  const streamTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const thinkTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const toolAccum = useRef<Map<string, string>>(new Map())
  const toolNames = useRef<Map<string, string>>(new Map())
  const dirtyTools = useRef<Set<string>>(new Set())
  const toolTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const rollbackTokenRef = useRef<string | null>(null)
  const lastCtrlCRef = useRef(0)

  // Tool target tracking for SummaryBar
  const toolTargetMap = useRef<Map<string, string>>(new Map())

  const flushStream = useCallback(() => {
    streamTimer.current = null
    if (streamBuf.current !== lastFlushedStream.current) {
      lastFlushedStream.current = streamBuf.current
      setStreamingText(streamBuf.current)
    }
  }, [])

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
      setLiveTools(prev => prev.map(e => {
        const newContent = updates.get(e.id)
        return newContent ? { ...e, content: newContent } : e
      }))
    }
  }, [])

  useEffect(() => {
    const sessions = SessionPersist.listSessions().filter(id => id !== currentSessionId)
    if (sessions.length > 0) {
      setSessionPrompt('waiting')
    }
  }, [currentSessionId])

  useEffect(() => {
    const banner = gradient(['#00ffcc', '#7b2fff'])('◆ R I V E T')
    pushStatic(createLogEntry({ type: 'text', content: banner }))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (initialInput) {
      handleSubmit(initialInput)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useInput((_input, _key) => {
    // Ctrl+C — soft interrupt or exit
    if (_input === '\x03') {
      if (pendingApproval) {
        pendingApproval.resolve(false)
        setPendingApproval(null)
      }
      if (isStreaming) {
        agent.abort()
        lastCtrlCRef.current = Date.now()
        return
      }
      if (lastCtrlCRef.current && Date.now() - lastCtrlCRef.current < 2000) {
        process.exit(0)
      }
      lastCtrlCRef.current = Date.now()
      pushStatic(createLogEntry({ type: 'text', content: '(Ctrl+C again to exit)' }))
      return
    }

    if (_key.escape && cockpitPanel) {
      setCockpitPanel(null)
      return
    }
    if (sessionPrompt === 'waiting') {
      const sessions = SessionPersist.listSessions().filter(id => id !== currentSessionId)
      if (_input === 'r' && sessions.length > 0) {
        const p = new SessionPersist(sessions[0]!)
        const msgs = p.load()
        session.replaceMessages(msgs)
        pushStatic(createLogEntry({ type: 'text', content: `Restored session ${sessions[0]!.slice(0, 8)}... (${msgs.length} messages)` }))
      }
      setSessionPrompt('done')
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

  const handleSubmit = useCallback(async (userInput: string) => {
    setIsStreaming(true)
    setStreamingText('')
    setStreamingThinking('')
    setLiveTools([])

    streamBuf.current = ''
    thinkBuf.current = ''
    lastFlushedStream.current = ''
    lastFlushedThink.current = ''
    toolAccum.current.clear()
    dirtyTools.current.clear()
    toolNames.current.clear()
    toolTargetMap.current.clear()

    streamStartRef.current = Date.now()
    thinkStartRef.current = 0
    thinkTimeRef.current = 0
    toolCallTracker.current.clear()
    setToolCallsDisplay([])

    const taskDesc = userInput.length > 30 ? userInput.slice(0, 29) + '…' : userInput
    phaseTracker.current = new PhaseTracker()
    setSummaryState({ task: taskDesc, phase: 'idle', stepCount: 0, totalSteps: 0, contextPct: Math.min(session.getEstimatedTokens() / maxTokens, 1), elapsedMs: 0, lastAction: null, risk: 'none' })

    for (const ref of [streamTimer, thinkTimer, toolTimer]) {
      if (ref.current) {
        clearTimeout(ref.current)
        ref.current = null
      }
    }

    if (userInput.startsWith('/')) {
      const parts = userInput.split(/\s+/)
      const cmd = parts[0]!.toLowerCase()

      if (cmd === '/rollback') {
        const subcmd = parts[1]
        if (subcmd === 'confirm') {
          const result = await rollbackToCheckpoint(process.cwd(), rollbackTokenRef.current ?? undefined)
          rollbackTokenRef.current = null
          pushStatic(createLogEntry({ type: 'text', content: result.success ? `Rolled back to checkpoint ${result.hash}. Agent-owned changes reverted.` : 'Rollback failed. No valid checkpoint or confirmation token.' }))
        } else {
          const preview = await getRollbackPreview(process.cwd())
          if (preview) {
            rollbackTokenRef.current = preview.confirmationToken
            pushStatic(createLogEntry({ type: 'text', content: `⚠️  Agent-owned changes to revert:\n${preview.text}\n\nType /rollback confirm to proceed.` }))
          } else {
            pushStatic(createLogEntry({ type: 'text', content: 'No agent-owned changes to rollback.' }))
          }
        }
        setIsStreaming(false)
        return
      }

      const slashCtx: SlashHandlerContext = {
        parts, agent, session, persist, model, maxTokens, availableModels, onModelSwitch,
        currentSessionId, cost, cacheHitRate, autoSafeRef, verboseRef,
        setVerbose, setAutoSafe, rollbackTokenRef, cockpitPanelRef,
        setCockpitPanel, pushStatic, setIsStreaming, setCacheHitRate, setSummaryState,
        mcpManagerRef,
      }
      if (handleSlashCommand(slashCtx)) return
    }

    pushStatic(createLogEntry({ type: 'text', content: `> ${userInput}` }))

    await agent.run(userInput, {
      onTextDelta: (text) => {
        streamBuf.current += text
        if (!streamTimer.current) {
          streamTimer.current = setTimeout(flushStream, STREAM_FLUSH_MS)
        }
      },
      onThinkingDelta: (thinking) => {
        if (thinkStartRef.current === 0) thinkStartRef.current = Date.now()
        thinkBuf.current += thinking
        if (!thinkTimer.current) {
          thinkTimer.current = setTimeout(flushThink, THINKING_FLUSH_MS)
        }
      },
      onToolUse: (id, name, input) => {
        toolNames.current.set(id, name)

        const target = typeof input?.file_path === 'string' ? input.file_path
          : typeof input?.path === 'string' ? input.path
          : typeof input?.command === 'string' ? input.command.slice(0, 30)
          : name
        toolTargetMap.current.set(id, target)

        if (thinkStartRef.current > 0) {
          thinkTimeRef.current = Date.now() - thinkStartRef.current
          thinkStartRef.current = 0
        }

        setLiveTools(prev => [...prev, createLogEntry({ type: 'tool', id, content: 'Running...', toolName: name })])

        toolCallTracker.current.set(id, { id, name, label: toolLabel(name, input), done: false, error: false })
        setToolCallsDisplay([...toolCallTracker.current.values()])

        phaseTracker.current.onToolUse(name, target)
        setSummaryState(prev => ({
          ...prev,
          phase: phaseTracker.current.current(),
          stepCount: agent.getTrajectoryStats().totalTools,
          contextPct: Math.min(session.getEstimatedTokens() / maxTokens, 1),
          elapsedMs: Date.now() - streamStartRef.current,
        }))
      },
      onToolResult: (id: string, name: string, result: string, isError?: boolean, rawPath?: string, uiContent?: string) => {
        if (isError === undefined) {
          toolAccum.current.set(id, (toolAccum.current.get(id) ?? '') + result)
          dirtyTools.current.add(id)
          if (!toolTimer.current) {
            toolTimer.current = setTimeout(flushTools, TOOL_FLUSH_MS)
          }
          return
        }

        if (toolTimer.current) {
          clearTimeout(toolTimer.current)
          toolTimer.current = null
        }
        dirtyTools.current.delete(id)
        toolAccum.current.delete(id)
        toolNames.current.delete(id)

        const finalContent = uiContent ?? result
        setLiveTools(prev => prev.filter(e => e.id !== id))
        pushStatic(createLogEntry({ type: 'tool', id, toolName: name, content: finalContent, isError, rawPath }))

        const tcEntry = toolCallTracker.current.get(id)
        if (tcEntry) {
          tcEntry.done = true
          tcEntry.error = !!isError
          setToolCallsDisplay([...toolCallTracker.current.values()])
        }

        phaseTracker.current.onToolResult(name, !!isError)
        const risk = (name === 'bash' && !autoSafeRef.current) ? 'medium' as const : 'none' as const
        setSummaryState(prev => ({
          ...prev,
          lastAction: phaseTracker.current.lastAction(),
          risk,
          elapsedMs: Date.now() - streamStartRef.current,
          approvalNeeded: null,
        }))
      },
      onCheckpoint: (hash) => {
        pushStatic(createLogEntry({ type: 'checkpoint', content: `Checkpoint saved: ${hash.slice(0, 7)} — /rollback to restore` }))
      },
      onTurnComplete: (_usage, turnNumber) => {
        if (dirtyTools.current.size > 0) {
          flushTools()
        }

        if (thinkStartRef.current > 0) {
          thinkTimeRef.current = Date.now() - thinkStartRef.current
          thinkStartRef.current = 0
        }

        if (streamTimer.current) {
          clearTimeout(streamTimer.current)
          streamTimer.current = null
        }
        const finalText = streamBuf.current
        if (finalText) {
          pushStatic(createLogEntry({ type: 'text', content: finalText }))
        }
        streamBuf.current = ''
        lastFlushedStream.current = ''
        setStreamingText('')

        if (thinkTimer.current) {
          clearTimeout(thinkTimer.current)
          thinkTimer.current = null
        }
        lastFlushedThink.current = thinkBuf.current
        setStreamingThinking(thinkBuf.current)
        thinkBuf.current = ''

        setLiveTools(prev => {
          for (const entry of prev) {
            pushStatic(entry)
          }
          return []
        })

        setIsStreaming(false)
        setCacheHitRate(session.getCacheHitRate())
        phaseTracker.current.onTurnComplete()
        setSummaryState(prev => ({ ...prev, phase: 'idle', elapsedMs: Date.now() - streamStartRef.current }))

        const usage = session.getTotalUsage()
        const normalInput = usage.input_tokens - usage.cache_read_input_tokens
        const estimatedCost = (normalInput * 1 + usage.cache_read_input_tokens * 0.1 + usage.output_tokens * 4) / 1_000_000
        setCost(estimatedCost)

        session.recordTurnCache(turnNumber, usage)
        const drift = agent.getDebugInfo().drift
        const diag = diagnoseCacheMiss(
          session.getCacheHistory(),
          turnNumber,
          drift,
          session.wasCompactedAt(turnNumber),
        )
        if (diag && diag.severity !== 'info') {
          pushStatic(createLogEntry({ type: 'text', content: `${diag.severity === 'error' ? '⚠️' : '💡'} ${diag.message}` }))
        }
      },
      onError: (error) => {
        pushStatic(createLogEntry({ type: 'text', content: `Error: ${error.message}` }))
        setIsStreaming(false)
      },
      onAbort: () => {
        pushStatic(createLogEntry({ type: 'text', content: '⏹ Interrupted.' }))
        setIsStreaming(false)
      },
      onApprovalRequired: async (id, name, input) => {
        const target = String(input?.path ?? input?.command ?? name)
        setSummaryState(prev => ({ ...prev, approvalNeeded: { tool: name, target } }))
        return new Promise<boolean>((resolve) => {
          setPendingApproval({ id, name, input, resolve })
        })
      },
    })
  }, [agent, session, pushStatic, flushStream, flushThink, flushTools, model, maxTokens, availableModels, onModelSwitch, currentSessionId, cost, cacheHitRate, setVerbose, setAutoSafe])

  const currentTokens = session.getEstimatedTokens()
  const tokenEstimate = Math.floor(streamingText.length / 4)

  return (
    <>
      <Static items={staticItems}>
        {(item) => renderStaticEntry(item, verbose)}
      </Static>
      <Box flexDirection="column">
        <StatusBar
          model={model}
          cacheHitRate={cacheHitRate}
          totalCost={cost.toFixed(2)}
          currentTokens={currentTokens}
          maxTokens={maxTokens}
          contextHealth={session.getContextLedger()?.tokenBudget.compactionState ?? 'healthy'}
          apiSafe={(session.getContextLedger()?.apiInvariantStatus.brokenRounds ?? 0) === 0}
        />
        {isStreaming && !cockpitPanel && <SummaryBar state={summaryState} />}
        {cockpitPanel && <CockpitView panel={cockpitPanel} agent={agent} session={session} model={model} cacheHitRate={cacheHitRate} cost={cost} summaryState={summaryState} mcpManager={mcpManagerRef.current} />}
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
        <ThinkingCollapser thinking={streamingThinking} isStreaming={isStreaming && !!streamingThinking} focused={false} />
        <AgentStatus
          isStreaming={isStreaming}
          startMs={streamStartRef.current || Date.now()}
          tokenEstimate={tokenEstimate}
          thinkingTime={thinkTimeRef.current}
          tools={toolCallsDisplay}
        />
        {pendingApproval && (
          <Box paddingX={2} borderStyle="single" borderColor="yellow">
            <Text bold color="yellow">Approve tool: {pendingApproval.name}?</Text>
            <Text> [y/n] </Text>
          </Box>
        )}
        <InputBar onSubmit={handleSubmit} disabled={isStreaming || !!pendingApproval} />
      </Box>
    </>
  )
}
