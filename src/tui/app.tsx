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
import { getTheme } from './theme.js'
import { AgentLoop } from '../agent/loop.js'
import { SessionContext } from '../agent/context.js'
import { SessionPersist } from '../agent/session-persist.js'
import { rollbackToCheckpoint, getRollbackPreview } from '../agent/checkpoint.js'
import { createLogEntry, summarizeToolOutput, type LogEntry } from './log-state.js'
import { diagnoseCacheMiss } from '../prompt/cache-diagnostic.js'
import type { McpManager } from '../mcp/manager.js'
import { CockpitRail, TracePanel, VerificationPanel, ContextPanel, SafetyPanel, ModelPanel, McpPanel } from './cockpit/index.js'
import { buildCockpitSnapshot } from './cockpit/state.js'
import type { Panel } from './cockpit/types.js'
import type { Usage } from '../api/types.js'
import { dismissOnboarding, getOnboardingState, shouldHandleOnboardingInput } from '../onboarding.js'
import { OnboardingPanel } from './onboarding.js'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { CommandPalette, getPaletteCommands } from './command-palette.js'
import { openInEditor } from './external-editor.js'
import { handleSlashCommand, resolveAppPromptInput, type SlashHandlerContext } from './slash-commands.js'

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
  const [showOnboarding, setShowOnboarding] = useState(() => getOnboardingState().shouldShow)
  const [vimEnabled, setVimEnabled] = useState(false)
  const [showPalette, setShowPalette] = useState(false)

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

  // Braille sparkline token history
  const tokenHistoryRef = useRef<number[]>([])
  const pushTokenHistory = useCallback((pct: number): number[] => {
    tokenHistoryRef.current.push(Math.max(0, Math.min(1, pct)))
    if (tokenHistoryRef.current.length > 20) {
      tokenHistoryRef.current = tokenHistoryRef.current.slice(-20)
    }
    return tokenHistoryRef.current
  }, [])

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
    const t = getTheme()
    const banner = gradient([t.primary, t.secondary])('◆ R I V E T')
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

    if (_key.ctrl && _input === '') {
      setShowPalette(prev => !prev)
      return
    }
    if (_key.ctrl && _input === '') {
      const edited = openInEditor('')
      if (edited) {
        handleSubmit(edited.trim())
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
    const initPct = Math.min(session.getEstimatedTokens() / maxTokens, 1)
    phaseTracker.current = new PhaseTracker()
    setSummaryState({ task: taskDesc, phase: 'idle', stepCount: 0, totalSteps: 0, contextPct: initPct, elapsedMs: 0, lastAction: null, risk: 'none', tokenHistory: pushTokenHistory(initPct) })

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
          const result = await rollbackToCheckpoint(process.cwd(), rollbackTokenRef.current ?? undefined, currentSessionId)
          rollbackTokenRef.current = null
          pushStatic(createLogEntry({ type: 'text', content: result.success ? `Rolled back to checkpoint ${result.hash}. Agent-owned changes reverted.` : 'Rollback failed. No valid checkpoint or confirmation token.' }))
        } else {
          const preview = await getRollbackPreview(process.cwd(), currentSessionId)
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

    const promptInput = resolveAppPromptInput(userInput, process.cwd())
    pushStatic(createLogEntry({ type: 'text', content: `> ${userInput}` }))

    await agent.run(promptInput, {
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
        const tuPct = Math.min(session.getEstimatedTokens() / maxTokens, 1)
        setSummaryState(prev => ({
          ...prev,
          phase: phaseTracker.current.current(),
          stepCount: agent.getTrajectoryStats().totalTools,
          contextPct: tuPct,
          elapsedMs: Date.now() - streamStartRef.current,
          tokenHistory: pushTokenHistory(tuPct),
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
        const trPct = Math.min(session.getEstimatedTokens() / maxTokens, 1)
        setSummaryState(prev => ({
          ...prev,
          lastAction: phaseTracker.current.lastAction(),
          risk,
          elapsedMs: Date.now() - streamStartRef.current,
          approvalNeeded: null,
          tokenHistory: pushTokenHistory(trPct),
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
        const tcPct = Math.min(session.getEstimatedTokens() / maxTokens, 1)
        setSummaryState(prev => ({ ...prev, phase: 'idle', elapsedMs: Date.now() - streamStartRef.current, tokenHistory: pushTokenHistory(tcPct) }))

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
  }, [agent, session, pushStatic, flushStream, flushThink, flushTools, model, maxTokens, availableModels, onModelSwitch, currentSessionId, cost, cacheHitRate, setVerbose, setAutoSafe, pushTokenHistory])

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
        <InputBar onSubmit={handleSubmit} disabled={isStreaming || !!pendingApproval} vimEnabled={vimEnabled} />
      </Box>
    </>
  )
}
