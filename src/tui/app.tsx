import { useState, useCallback, useRef, useEffect } from 'react'
import { Box, Text, useInput } from 'ink'
import { StatusBar } from './status-bar.js'
import { InputBar } from './input.js'
import { StreamOutput } from './stream.js'
import { ThinkingCollapser } from './thinking.js'
import { ToolCard } from './tool-card.js'
import { AgentLoop } from '../agent/loop.js'
import { SessionContext } from '../agent/context.js'
import { SessionPersist } from '../agent/session-persist.js'
import { microCompact, estimateTokens } from '../compact/micro.js'
import { rollbackToCheckpoint, getRollbackPreview } from '../agent/checkpoint.js'
import { appendLog, updateToolLog, visibleLogs, type LogEntry } from './log-state.js'
import { diagnoseCacheMiss } from '../prompt/cache-diagnostic.js'

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

const MAX_VISIBLE_LOGS = 30

export function App({ agent, session, persist, model, maxTokens, availableModels, onModelSwitch, currentSessionId, initialInput }: AppProps) {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [streamingText, setStreamingText] = useState('')
  const [streamingThinking, setStreamingThinking] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [cost, setCost] = useState(0)
  const [cacheHitRate, setCacheHitRate] = useState(0)
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null)
  const [sessionPrompt, setSessionPrompt] = useState<'waiting' | 'done'>('done')
  const [verbose, setVerbose] = useState(false)
  const [autoSafe, setAutoSafe] = useState(true)
  const logRef = useRef<LogEntry[]>([])
  const streamBufferRef = useRef('')
  const streamFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const thinkingBufferRef = useRef('')
  const thinkingFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rollbackTokenRef = useRef<string | null>(null)
  const toolOutputAccumRef = useRef<Map<string, string>>(new Map())
  const toolFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirtyToolIdsRef = useRef<Set<string>>(new Set())
  const toolNamesRef = useRef<Map<string, string>>(new Map())

  // Session recovery: check for previous sessions on mount
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
    // Session recovery prompt
    if (sessionPrompt === 'waiting') {
      const sessions = SessionPersist.listSessions().filter(id => id !== currentSessionId)
      if (_input === 'r' && sessions.length > 0) {
        const p = new SessionPersist(sessions[0]!)
        const msgs = p.load()
        session.replaceMessages(msgs)
        addLog({ type: 'text', content: `Restored session ${sessions[0]!.slice(0, 8)}... (${msgs.length} messages)` })
      }
      setSessionPrompt('done')
      return
    }

    // Tool approval
    if (!pendingApproval) return
    if (_input.toLowerCase() === 'y') {
      pendingApproval.resolve(true)
      setPendingApproval(null)
    } else if (_input.toLowerCase() === 'n') {
      pendingApproval.resolve(false)
      setPendingApproval(null)
    }
  })

  const addLog = useCallback((entry: LogEntry) => {
    logRef.current = appendLog(logRef.current, entry)
    setLogs(visibleLogs(logRef.current, MAX_VISIBLE_LOGS))
  }, [])

  const updateLogEntry = useCallback((id: string, toolName: string, content: string, isError?: boolean, rawPath?: string) => {
    logRef.current = updateToolLog(logRef.current, id, toolName, content, isError, rawPath)
    setLogs(visibleLogs(logRef.current, MAX_VISIBLE_LOGS))
  }, [])

  const handleSubmit = useCallback(async (userInput: string) => {
    setIsStreaming(true)
    setStreamingText('')
    setStreamingThinking('')

    streamBufferRef.current = ''
    thinkingBufferRef.current = ''
    toolOutputAccumRef.current.clear()
    dirtyToolIdsRef.current.clear()
    toolNamesRef.current.clear()

    for (const ref of [streamFlushRef, thinkingFlushRef, toolFlushRef]) {
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
          addLog({ type: 'text', content: `Available commands:
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
/auto — Toggle auto-approve (current: ${autoSafe ? 'auto-safe' : 'manual'})` })
          setIsStreaming(false)
          return

        case '/exit':
        case '/quit':
          persist.compact(session.getMessages())
          addLog({ type: 'text', content: 'Session saved. Goodbye!' })
          process.exit(0)

        case '/compact':
          addLog({ type: 'text', content: 'Compacting conversation...' })
          const msgs = session.getMessages()
          const { messages: compacted, truncated } = microCompact(msgs, maxTokens, estimateTokens(msgs))
          session.replaceMessages(compacted)
          addLog({ type: 'text', content: `Compacted: removed ${truncated} messages. ${compacted.length} remaining.` })
          setIsStreaming(false)
          setCacheHitRate(session.getCacheHitRate())
          return

        case '/model': {
          const targetModel = parts[1]
          if (!targetModel || targetModel === 'list') {
            const list = availableModels.map(m =>
              `  ${m.alias} (${m.id})${m.alias === model ? ' ← current' : ''}`
            ).join('\n')
            addLog({ type: 'text', content: `Available models:\n${list}\n\nCurrent: ${model}\nContext: ${maxTokens.toLocaleString()} tokens\nCost: ¥${cost.toFixed(4)}` })
          } else {
            const found = availableModels.find(m => m.alias === targetModel || m.id === targetModel)
            if (found) {
              onModelSwitch(found.id)
              addLog({ type: 'text', content: `Switched to ${found.alias} (${found.id})` })
            } else {
              addLog({ type: 'text', content: `Model "${targetModel}" not found. Use /model list to see available models.` })
            }
          }
          setIsStreaming(false)
          return
        }

        case '/verbose': {
          const nextVerbose = !verbose
          setVerbose(nextVerbose)
          addLog({ type: 'text', content: nextVerbose ? 'Verbose mode: on (show 200 lines)' : 'Verbose mode: off (show 20 lines)' })
          setIsStreaming(false)
          return
        }

        case '/auto': {
          const next = !autoSafe
          setAutoSafe(next)
          agent.setApprovalMode(next ? 'auto-safe' : 'manual')
          addLog({ type: 'text', content: next ? 'Auto-approve: on (auto-safe — high-risk still requires approval)' : 'Auto-approve: off (manual — all mutating tools require approval)' })
          setIsStreaming(false)
          return
        }

        case '/debug': {
          const subcmd = parts[1]
          const info = agent.getDebugInfo()
          if (subcmd === 'prompt') {
            addLog({ type: 'text', content: `System prompt (${info.systemPromptLength} chars):\n${info.systemPromptPreview}\n\nTools (${info.toolCount}): ${info.toolNames.join(', ')}` })
          } else if (subcmd === 'fingerprint') {
            const fp = info.fingerprint
            const drift = info.drift
            addLog({ type: 'text', content: `Fingerprint:\n  system:  ${fp.systemSha256.slice(0, 16)}...\n  tools:   ${fp.toolsSha256.slice(0, 16)}...\n  combined: ${fp.combinedSha256.slice(0, 16)}...\n\nDrift: ${drift ? drift.message : 'none (cache stable)'}` })
          } else if (subcmd === 'cache') {
            const usage = session.getTotalUsage()
            const hitRate = cacheHitRate
            const totalCached = usage.cache_read_input_tokens + usage.cache_creation_input_tokens
            addLog({ type: 'text', content: `Cache:\n  hit rate: ${(hitRate * 100).toFixed(1)}%\n  read tokens: ${usage.cache_read_input_tokens.toLocaleString()}\n  write tokens: ${usage.cache_creation_input_tokens.toLocaleString()}\n  total cached: ${totalCached.toLocaleString()}\n  input tokens: ${usage.input_tokens.toLocaleString()}\n  output tokens: ${usage.output_tokens.toLocaleString()}\n  estimated: ${session.getEstimatedTokens().toLocaleString()}\n  cost: ¥${cost.toFixed(4)}\n  saved: ¥${((usage.cache_read_input_tokens * 0.9) / 1_000_000).toFixed(4)} (cache discount)` })
          } else {
            addLog({ type: 'text', content: 'Usage: /debug [prompt|fingerprint|cache]' })
          }
          setIsStreaming(false)
          return
        }

        case '/rollback': {
          const subcmd = parts[1]
          if (subcmd === 'confirm') {
            const result = await rollbackToCheckpoint(process.cwd(), rollbackTokenRef.current ?? undefined)
            rollbackTokenRef.current = null
            if (result.success) {
              addLog({ type: 'text', content: `Rolled back to checkpoint ${result.hash}. Agent-owned changes reverted.` })
            } else {
              addLog({ type: 'text', content: 'Rollback failed. No valid checkpoint or confirmation token.' })
            }
          } else {
            const preview = await getRollbackPreview(process.cwd())
            if (preview) {
              rollbackTokenRef.current = preview.confirmationToken
              addLog({ type: 'text', content: `⚠️  Agent-owned changes to revert:\n${preview.text}\n\nType /rollback confirm to proceed.` })
            } else {
              addLog({ type: 'text', content: 'No agent-owned changes to rollback.' })
            }
          }
          setIsStreaming(false)
          return
        }

        case '/clear':
          logRef.current = []
          setLogs([])
          setIsStreaming(false)
          return

        case '/sessions': {
          const sessions = SessionPersist.listSessions()
          if (sessions.length === 0) {
            addLog({ type: 'text', content: 'No saved sessions.' })
          } else {
            const list = sessions.map((id, i) => {
              const marker = id === currentSessionId ? ' ← current' : ''
              return `${i + 1}. ${id.slice(0, 8)}...${marker}`
            }).join('\n')
            addLog({ type: 'text', content: `Saved sessions:\n${list}\n\n/resume <number> to restore` })
          }
          setIsStreaming(false)
          return
        }

        case '/resume': {
          const sessions = SessionPersist.listSessions()
          const idx = parseInt(parts[1] ?? '', 10) - 1
          if (isNaN(idx) || idx < 0 || idx >= sessions.length) {
            addLog({ type: 'text', content: `Invalid session number. Use /sessions to see available sessions.` })
            setIsStreaming(false)
            return
          }
          const targetId = sessions[idx]!
          const p = new SessionPersist(targetId)
          const msgs = p.load()
          session.replaceMessages(msgs)
          addLog({ type: 'text', content: `Restored session ${targetId.slice(0, 8)}... (${msgs.length} messages)` })
          logRef.current = []
          setLogs([])
          setIsStreaming(false)
          return
        }
      }
    }

    addLog({ type: 'text', content: `> ${userInput}` })

    await agent.run(userInput, {
      onTextDelta: (text) => {
        streamBufferRef.current += text
        if (!streamFlushRef.current) {
          streamFlushRef.current = setTimeout(() => {
            setStreamingText(streamBufferRef.current)
            streamFlushRef.current = null
          }, 50)
        }
      },
      onThinkingDelta: (thinking) => {
        thinkingBufferRef.current += thinking
        if (!thinkingFlushRef.current) {
          thinkingFlushRef.current = setTimeout(() => {
            setStreamingThinking(thinkingBufferRef.current)
            thinkingFlushRef.current = null
          }, 150)
        }
      },
      onToolUse: (id, name) => {
        toolNamesRef.current.set(id, name)
        addLog({ type: 'tool', id, content: 'Running...', toolName: name })
      },
      onToolResult: (id, name, result, isError, rawPath, uiContent) => {
        // Intermediate streaming chunks: batch at 50ms for smooth live display.
        // Final result: isError is defined, flush immediately.
        if (isError === undefined) {
          toolOutputAccumRef.current.set(id, (toolOutputAccumRef.current.get(id) ?? '') + result)
          dirtyToolIdsRef.current.add(id)
          if (!toolFlushRef.current) {
            toolFlushRef.current = setTimeout(() => {
              for (const tid of dirtyToolIdsRef.current) {
                const accumulated = toolOutputAccumRef.current.get(tid)
                if (accumulated !== undefined) {
                  const tname = toolNamesRef.current.get(tid) ?? ''
                  updateLogEntry(tid, tname, accumulated)
                }
              }
              dirtyToolIdsRef.current.clear()
              toolFlushRef.current = null
            }, 50)
          }
          return
        }
        // Final result — flush any pending chunks then show final output
        if (toolFlushRef.current) {
          clearTimeout(toolFlushRef.current)
          toolFlushRef.current = null
        }
        dirtyToolIdsRef.current.delete(id)
        toolOutputAccumRef.current.delete(id)
        // Use uiContent for TUI display when available (e.g. read_file line-numbered preview)
        updateLogEntry(id, name, uiContent ?? result, isError, rawPath)
      },
      onCheckpoint: (hash) => {
        addLog({ type: 'checkpoint', content: `Checkpoint saved: ${hash.slice(0, 7)} — /rollback to restore` })
      },
      onTurnComplete: (_usage, turnNumber) => {
        if (streamFlushRef.current) {
          clearTimeout(streamFlushRef.current)
          streamFlushRef.current = null
        }
        const finalText = streamBufferRef.current
        if (finalText) {
          addLog({ type: 'text', content: finalText })
        }
        streamBufferRef.current = ''
        setStreamingText('')

        if (thinkingFlushRef.current) {
          clearTimeout(thinkingFlushRef.current)
          thinkingFlushRef.current = null
        }
        setStreamingThinking(thinkingBufferRef.current)
        thinkingBufferRef.current = ''

        if (toolFlushRef.current) {
          clearTimeout(toolFlushRef.current)
          toolFlushRef.current = null
        }
        dirtyToolIdsRef.current.clear()
        toolOutputAccumRef.current.clear()

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
          addLog({ type: 'text', content: `${diag.severity === 'error' ? '⚠️' : '💡'} ${diag.message}` })
        }
      },
      onError: (error) => {
        addLog({ type: 'text', content: `Error: ${error.message}`, isError: true })
        setIsStreaming(false)
      },
      onAbort: () => {
        addLog({ type: 'text', content: '[Aborted]' })
        setIsStreaming(false)
      },
      onApprovalRequired: async (id, name, input) => {
        return new Promise<boolean>((resolve) => {
          setPendingApproval({ id, name, input, resolve })
        })
      },
    })
  }, [agent, session, addLog, model, maxTokens, availableModels, onModelSwitch, currentSessionId])

  const currentTokens = session.getTotalUsage().input_tokens

  return (
    <Box flexDirection="column" height={process.stdout.rows}>
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
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {logs.map((log, i) => {
          if (log.type === 'tool') {
            return <ToolCard key={`${log.id ?? i}`} name={log.toolName ?? ''} result={log.content} isError={log.isError} verbose={verbose} rawPath={log.rawPath} />
          }
          if (log.type === 'checkpoint') {
            return <Box key={i} paddingX={2}><Text dimColor color="yellow">⚑ {log.content}</Text></Box>
          }
          if (log.type === 'evidence') {
            return <Box key={i} paddingX={2} marginBottom={1} borderStyle="single" borderColor="green"><Text color="green">{log.content}</Text></Box>
          }
          return <StreamOutput key={i} text={log.content} isStreaming={false} />
        })}
        {isStreaming && streamingThinking && (
          <ThinkingCollapser thinking={streamingThinking} isStreaming={isStreaming} focused={isStreaming} />
        )}
        {isStreaming && (
          <StreamOutput text={streamingText} isStreaming={isStreaming} />
        )}
      </Box>
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
