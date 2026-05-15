import { useState, useCallback, useRef, useEffect, memo } from 'react'
import { Box, Text, useInput } from 'ink'
import { StatusBar } from './status-bar.js'
import { InputBar } from './input.js'
import { StreamOutput } from './stream.js'
import { ThinkingCollapser } from './thinking.js'
import { ToolCard } from './tool-card.js'
import { AgentStatus, toolLabel, type ToolCallItem } from './agent-status.js'
import { AgentLoop } from '../agent/loop.js'
import { SessionContext } from '../agent/context.js'
import { SessionPersist } from '../agent/session-persist.js'
import { microCompact, estimateTokens } from '../compact/micro.js'
import { rollbackToCheckpoint, getRollbackPreview } from '../agent/checkpoint.js'
import { createLogEntry, appendLogInPlace, updateToolLog, summarizeToolOutput, visibleLogs, type LogEntry } from './log-state.js'
import { diagnoseCacheMiss } from '../prompt/cache-diagnostic.js'
import { useTerminalSize } from './use-terminal-size.js'

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
}

const STREAM_FLUSH_MS = 80
const THINKING_FLUSH_MS = 200
const TOOL_FLUSH_MS = 120

// Rows reserved for non-log UI elements
const STATUS_BAR_ROWS = 3
const INPUT_BAR_ROWS = 1
const APPROVAL_PROMPT_ROWS = 3
const AGENT_STATUS_BASE_ROWS = 2
const STREAMING_ROWS = 2

// Estimated rows per log entry (avg)
const ROWS_PER_LOG = 3

// --- Memoized sub-components ---

const LogList = memo(function LogList({ logs, verbose, maxHeight }: { logs: LogEntry[]; verbose: boolean; maxHeight: number }) {
  const maxLogs = Math.max(1, Math.floor(maxHeight / ROWS_PER_LOG))
  const display = logs.slice(-maxLogs)
  const hidden = logs.length - display.length

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {hidden > 0 && (
        <Box paddingX={1}>
          <Text dimColor>↕ {hidden} earlier messages scrolled up</Text>
        </Box>
      )}
      {display.map(log => {
        switch (log.type) {
          case 'tool':
            return <ToolCard key={log.id} name={log.toolName ?? ''} result={log.content} isError={log.isError} verbose={verbose} rawPath={log.rawPath} />
          case 'checkpoint':
            return <Box key={log.id} paddingX={2}><Text dimColor color="yellow">⚑ {log.content}</Text></Box>
          case 'evidence':
            return <Box key={log.id} paddingX={2} marginBottom={1} borderStyle="single" borderColor="green"><Text color="green">{log.content}</Text></Box>
          default:
            return <StreamOutput key={log.id} text={log.content} isStreaming={false} />
        }
      })}
    </Box>
  )
})

const StreamingPanel = memo(function StreamingPanel({ text, thinking, isStreaming }: { text: string; thinking: string; isStreaming: boolean }) {
  return (
    <>
      {isStreaming && thinking && (
        <ThinkingCollapser thinking={thinking} isStreaming={isStreaming} focused={isStreaming} />
      )}
      {isStreaming && (
        <StreamOutput text={text} isStreaming={isStreaming} />
      )}
    </>
  )
})

// --- Main App ---

export function App({ agent, session, persist, model, maxTokens, availableModels, onModelSwitch, currentSessionId, initialInput }: AppProps) {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [streamingText, setStreamingText] = useState('')
  const [streamingThinking, setStreamingThinking] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [cost, setCost] = useState(0)
  const [cacheHitRate, setCacheHitRate] = useState(0)
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null)
  const [sessionPrompt, setSessionPrompt] = useState<'waiting' | 'done'>('done')

  // State + ref pairs for values used inside async callbacks
  const [verbose, _setVerbose] = useState(false)
  const [, _setAutoSafe] = useState(true)
  const verboseRef = useRef(false)
  const autoSafeRef = useRef(true)

  const setVerbose = useCallback((v: boolean) => { verboseRef.current = v; _setVerbose(v) }, [])
  const setAutoSafe = useCallback((v: boolean) => { autoSafeRef.current = v; _setAutoSafe(v) }, [])

  const logRef = useRef<LogEntry[]>([])

  // Agent status tracking
  const streamStartRef = useRef(0)
  const thinkStartRef = useRef(0)
  const thinkTimeRef = useRef(0)
  const toolCallTracker = useRef<Map<string, ToolCallItem>>(new Map())
  const [toolCallsDisplay, setToolCallsDisplay] = useState<ToolCallItem[]>([])

  // Streaming buffers — mutated in place, flushed to React state on timer
  const streamBuf = useRef('')
  const thinkBuf = useRef('')
  const lastFlushedStream = useRef('')
  const lastFlushedThink = useRef('')
  const streamTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const thinkTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Tool output accumulator
  const toolAccum = useRef<Map<string, string>>(new Map())
  const toolNames = useRef<Map<string, string>>(new Map())
  const dirtyTools = useRef<Set<string>>(new Set())
  const toolTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const rollbackTokenRef = useRef<string | null>(null)

  // Batch multiple log mutations into a single React update
  const logDirty = useRef(false)
  const flushLogs = useCallback(() => {
    if (logDirty.current) {
      logDirty.current = false
      setLogs(visibleLogs(logRef.current, logRef.current.length))
    }
  }, [])

  const addLog = useCallback((entry: LogEntry) => {
    appendLogInPlace(logRef.current, entry)
    logDirty.current = true
  }, [])

  const updateLogEntry = useCallback((id: string, toolName: string, content: string, isError?: boolean, rawPath?: string) => {
    const prev = logRef.current
    logRef.current = updateToolLog(prev, id, toolName, content, isError, rawPath)
    if (logRef.current !== prev) {
      logDirty.current = true
    }
  }, [])

  // Streaming flush helpers — only update React state if text actually changed
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
    const limit = verboseRef.current ? 200 : 12
    let changed = false
    for (const tid of dirtyTools.current) {
      const accumulated = toolAccum.current.get(tid)
      if (accumulated !== undefined) {
        const tname = toolNames.current.get(tid) ?? ''
        const prev = logRef.current
        logRef.current = updateToolLog(prev, tid, tname, summarizeToolOutput(accumulated, limit))
        if (logRef.current !== prev) changed = true
      }
    }
    dirtyTools.current.clear()
    if (changed) {
      logDirty.current = true
      flushLogs()
    }
  }, [flushLogs])

  // Session recovery
  useEffect(() => {
    const sessions = SessionPersist.listSessions().filter(id => id !== currentSessionId)
    if (sessions.length > 0) {
      setSessionPrompt('waiting')
    }
  }, [currentSessionId])

  // Auto-submit piped stdin
  useEffect(() => {
    if (initialInput) {
      handleSubmit(initialInput)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useInput((_input, _key) => {
    if (sessionPrompt === 'waiting') {
      const sessions = SessionPersist.listSessions().filter(id => id !== currentSessionId)
      if (_input === 'r' && sessions.length > 0) {
        const p = new SessionPersist(sessions[0]!)
        const msgs = p.load()
        session.replaceMessages(msgs)
        addLog(createLogEntry({ type: 'text', content: `Restored session ${sessions[0]!.slice(0, 8)}... (${msgs.length} messages)` }))
        flushLogs()
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

    streamBuf.current = ''
    thinkBuf.current = ''
    lastFlushedStream.current = ''
    lastFlushedThink.current = ''
    toolAccum.current.clear()
    dirtyTools.current.clear()
    toolNames.current.clear()

    // Reset agent status tracking
    streamStartRef.current = Date.now()
    thinkStartRef.current = 0
    thinkTimeRef.current = 0
    toolCallTracker.current.clear()
    setToolCallsDisplay([])

    for (const ref of [streamTimer, thinkTimer, toolTimer]) {
      if (ref.current) {
        clearTimeout(ref.current)
        ref.current = null
      }
    }

    // Slash command routing
    if (userInput.startsWith('/')) {
      const parts = userInput.split(/\s+/)
      const cmd = parts[0]!.toLowerCase()

      switch (cmd) {
        case '/help':
          addLog(createLogEntry({ type: 'text', content: `Available commands:
/help — Show this help
/exit — Exit Rivet
/quit — Exit
/compact — Compact conversation context
/model [name|list] — Show or switch model
/verbose — Toggle verbose tool output
/debug [prompt|fingerprint|cache] — Debug prefix cache and prompt
/clear — Clear screen (visual only)
/sessions — List all saved sessions
/resume <number> — Restore a saved session
/rollback — Preview changes since last checkpoint (/rollback confirm to execute)
/evidence — Show last turn evidence summary
/auto — Toggle auto-approve (current: ${autoSafeRef.current ? 'auto-safe' : 'manual'})` }))
          flushLogs()
          setIsStreaming(false)
          return

        case '/exit':
        case '/quit':
          persist.compact(session.getMessages())
          addLog(createLogEntry({ type: 'text', content: 'Session saved. Goodbye!' }))
          flushLogs()
          process.exit(0)

        case '/compact':
          addLog(createLogEntry({ type: 'text', content: 'Compacting conversation...' }))
          const msgs = session.getMessages()
          const { messages: compacted, truncated } = microCompact(msgs, maxTokens, estimateTokens(msgs))
          session.replaceMessages(compacted)
          addLog(createLogEntry({ type: 'text', content: `Compacted: removed ${truncated} messages. ${compacted.length} remaining.` }))
          flushLogs()
          setIsStreaming(false)
          setCacheHitRate(session.getCacheHitRate())
          return

        case '/model': {
          const targetModel = parts[1]
          if (!targetModel || targetModel === 'list') {
            const list = availableModels.map(m =>
              `  ${m.alias} (${m.id})${m.alias === model ? ' ← current' : ''}`
            ).join('\n')
            addLog(createLogEntry({ type: 'text', content: `Available models:\n${list}\n\nCurrent: ${model}\nContext: ${maxTokens.toLocaleString()} tokens\nCost: ¥${cost.toFixed(4)}` }))
          } else {
            const found = availableModels.find(m => m.alias === targetModel || m.id === targetModel)
            if (found) {
              onModelSwitch(found.id)
              addLog(createLogEntry({ type: 'text', content: `Switched to ${found.alias} (${found.id})` }))
            } else {
              addLog(createLogEntry({ type: 'text', content: `Model "${targetModel}" not found. Use /model list to see available models.` }))
            }
          }
          flushLogs()
          setIsStreaming(false)
          return
        }

        case '/verbose': {
          const nextVerbose = !verboseRef.current
          setVerbose(nextVerbose)
          addLog(createLogEntry({ type: 'text', content: nextVerbose ? 'Verbose mode: on (show 200 lines)' : 'Verbose mode: off (show 20 lines)' }))
          flushLogs()
          setIsStreaming(false)
          return
        }

        case '/auto': {
          const next = !autoSafeRef.current
          setAutoSafe(next)
          agent.setApprovalMode(next ? 'auto-safe' : 'manual')
          addLog(createLogEntry({ type: 'text', content: next ? 'Auto-approve: on (auto-safe — high-risk still requires approval)' : 'Auto-approve: off (manual — all mutating tools require approval)' }))
          flushLogs()
          setIsStreaming(false)
          return
        }

        case '/debug': {
          const subcmd = parts[1]
          const info = agent.getDebugInfo()
          if (subcmd === 'prompt') {
            addLog(createLogEntry({ type: 'text', content: `System prompt (${info.systemPromptLength} chars):\n${info.systemPromptPreview}\n\nTools (${info.toolCount}): ${info.toolNames.join(', ')}` }))
          } else if (subcmd === 'fingerprint') {
            const fp = info.fingerprint
            const drift = info.drift
            addLog(createLogEntry({ type: 'text', content: `Fingerprint:\n  system:  ${fp.systemSha256.slice(0, 16)}...\n  tools:   ${fp.toolsSha256.slice(0, 16)}...\n  combined: ${fp.combinedSha256.slice(0, 16)}...\n\nDrift: ${drift ? drift.message : 'none (cache stable)'}` }))
          } else if (subcmd === 'cache') {
            const usage = session.getTotalUsage()
            const hitRate = cacheHitRate
            const totalCached = usage.cache_read_input_tokens + usage.cache_creation_input_tokens
            addLog(createLogEntry({ type: 'text', content: `Cache:\n  hit rate: ${(hitRate * 100).toFixed(1)}%\n  read tokens: ${usage.cache_read_input_tokens.toLocaleString()}\n  write tokens: ${usage.cache_creation_input_tokens.toLocaleString()}\n  total cached: ${totalCached.toLocaleString()}\n  input tokens: ${usage.input_tokens.toLocaleString()}\n  output tokens: ${usage.output_tokens.toLocaleString()}\n  estimated: ${session.getEstimatedTokens().toLocaleString()}\n  cost: ¥${cost.toFixed(4)}\n  saved: ¥${((usage.cache_read_input_tokens * 0.9) / 1_000_000).toFixed(4)} (cache discount)` }))
          } else {
            addLog(createLogEntry({ type: 'text', content: 'Usage: /debug [prompt|fingerprint|cache]' }))
          }
          flushLogs()
          setIsStreaming(false)
          return
        }

        case '/rollback': {
          const subcmd = parts[1]
          if (subcmd === 'confirm') {
            const result = await rollbackToCheckpoint(process.cwd(), rollbackTokenRef.current ?? undefined)
            rollbackTokenRef.current = null
            if (result.success) {
              addLog(createLogEntry({ type: 'text', content: `Rolled back to checkpoint ${result.hash}. Agent-owned changes reverted.` }))
            } else {
              addLog(createLogEntry({ type: 'text', content: 'Rollback failed. No valid checkpoint or confirmation token.' }))
            }
          } else {
            const preview = await getRollbackPreview(process.cwd())
            if (preview) {
              rollbackTokenRef.current = preview.confirmationToken
              addLog(createLogEntry({ type: 'text', content: `⚠️  Agent-owned changes to revert:\n${preview.text}\n\nType /rollback confirm to proceed.` }))
            } else {
              addLog(createLogEntry({ type: 'text', content: 'No agent-owned changes to rollback.' }))
            }
          }
          flushLogs()
          setIsStreaming(false)
          return
        }

        case '/clear':
          logRef.current = []
          logDirty.current = false
          setLogs([])
          setIsStreaming(false)
          return

        case '/sessions': {
          const sessions = SessionPersist.listSessions()
          if (sessions.length === 0) {
            addLog(createLogEntry({ type: 'text', content: 'No saved sessions.' }))
          } else {
            const list = sessions.map((id, i) => {
              const marker = id === currentSessionId ? ' ← current' : ''
              return `${i + 1}. ${id.slice(0, 8)}...${marker}`
            }).join('\n')
            addLog(createLogEntry({ type: 'text', content: `Saved sessions:\n${list}\n\n/resume <number> to restore` }))
          }
          flushLogs()
          setIsStreaming(false)
          return
        }

        case '/resume': {
          const sessions = SessionPersist.listSessions()
          const idx = parseInt(parts[1] ?? '', 10) - 1
          if (isNaN(idx) || idx < 0 || idx >= sessions.length) {
            addLog(createLogEntry({ type: 'text', content: `Invalid session number. Use /sessions to see available sessions.` }))
            flushLogs()
            setIsStreaming(false)
            return
          }
          const targetId = sessions[idx]!
          const p = new SessionPersist(targetId)
          const msgs = p.load()
          session.replaceMessages(msgs)
          addLog(createLogEntry({ type: 'text', content: `Restored session ${targetId.slice(0, 8)}... (${msgs.length} messages)` }))
          logRef.current = []
          logDirty.current = false
          setLogs([])
          setIsStreaming(false)
          return
        }
      }
    }

    addLog(createLogEntry({ type: 'text', content: `> ${userInput}` }))
    flushLogs()

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
        addLog(createLogEntry({ type: 'tool', id, content: 'Running...', toolName: name }))

        // Track thinking time up to this point
        if (thinkStartRef.current > 0) {
          thinkTimeRef.current = Date.now() - thinkStartRef.current
          thinkStartRef.current = 0
        }

        // Update agent status tool call list
        toolCallTracker.current.set(id, { id, name, label: toolLabel(name, input), done: false, error: false })
        setToolCallsDisplay([...toolCallTracker.current.values()])

        flushLogs()
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
        // Final result — cancel pending flush for this tool, write immediately
        if (toolTimer.current) {
          clearTimeout(toolTimer.current)
          toolTimer.current = null
        }
        dirtyTools.current.delete(id)
        toolAccum.current.delete(id)
        toolNames.current.delete(id)
        updateLogEntry(id, name, uiContent ?? result, isError, rawPath)

        // Update agent status
        const tcEntry = toolCallTracker.current.get(id)
        if (tcEntry) {
          tcEntry.done = true
          tcEntry.error = !!isError
          setToolCallsDisplay([...toolCallTracker.current.values()])
        }

        flushLogs()
      },
      onCheckpoint: (hash) => {
        addLog(createLogEntry({ type: 'checkpoint', content: `Checkpoint saved: ${hash.slice(0, 7)} — /rollback to restore` }))
        flushLogs()
      },
      onTurnComplete: (_usage, turnNumber) => {
        // Flush any remaining buffered tool output before clearing
        if (dirtyTools.current.size > 0) {
          flushTools()
        }

        // Finalize thinking time
        if (thinkStartRef.current > 0) {
          thinkTimeRef.current = Date.now() - thinkStartRef.current
          thinkStartRef.current = 0
        }

        // Flush any remaining streaming buffers
        if (streamTimer.current) {
          clearTimeout(streamTimer.current)
          streamTimer.current = null
        }
        const finalText = streamBuf.current
        if (finalText) {
          addLog(createLogEntry({ type: 'text', content: finalText }))
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

        setIsStreaming(false)
        setCacheHitRate(session.getCacheHitRate())

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
          addLog(createLogEntry({ type: 'text', content: `${diag.severity === 'error' ? '⚠️' : '💡'} ${diag.message}` }))
        }
        flushLogs()
      },
      onError: (error) => {
        addLog(createLogEntry({ type: 'text', content: `Error: ${error.message}` }))
        flushLogs()
        setIsStreaming(false)
      },
      onAbort: () => {
        addLog(createLogEntry({ type: 'text', content: '[Aborted]' }))
        flushLogs()
        setIsStreaming(false)
      },
      onApprovalRequired: async (id, name, input) => {
        return new Promise<boolean>((resolve) => {
          setPendingApproval({ id, name, input, resolve })
        })
      },
    })
  }, [agent, session, addLog, flushLogs, flushStream, flushThink, flushTools, model, maxTokens, availableModels, onModelSwitch, currentSessionId, cost, cacheHitRate, setVerbose, setAutoSafe])

  const currentTokens = session.getTotalUsage().input_tokens
  const termSize = useTerminalSize()
  const tokenEstimate = Math.floor(streamingText.length / 4)

  // Calculate reserved rows for bottom UI elements
  const bottomReserved =
    STATUS_BAR_ROWS +
    INPUT_BAR_ROWS +
    (pendingApproval ? APPROVAL_PROMPT_ROWS : 0) +
    (isStreaming ? STREAMING_ROWS + AGENT_STATUS_BASE_ROWS + Math.min(toolCallsDisplay.length, 6) : 0)

  const logAreaHeight = Math.max(5, termSize.rows - bottomReserved)

  return (
    <Box flexDirection="column" height={termSize.rows}>
      <StatusBar
        model={model}
        cacheHitRate={cacheHitRate}
        totalCost={cost.toFixed(2)}
        currentTokens={currentTokens}
        maxTokens={maxTokens}
      />
      {sessionPrompt === 'waiting' && (
        <Box paddingX={2} marginBottom={1} borderStyle="single" borderColor="cyan">
          <Text bold color="cyan">Previous session found.</Text>
          <Text> Press <Text bold>r</Text> to restore, any other key to start fresh </Text>
        </Box>
      )}
      <LogList logs={logs} verbose={verbose} maxHeight={logAreaHeight} />
      <StreamingPanel text={streamingText} thinking={streamingThinking} isStreaming={isStreaming} />
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
  )
}
