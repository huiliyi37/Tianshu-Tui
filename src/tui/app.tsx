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
import { appendLog, summarizeToolOutput, updateToolLog, visibleLogs, type LogEntry } from './log-state.js'

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

const MAX_VISIBLE_LOGS = 50

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
  const logRef = useRef<LogEntry[]>([])
  const streamBufferRef = useRef('')
  const streamFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toolOutputAccumRef = useRef<Map<string, string>>(new Map())
  const thinkingBufferRef = useRef('')
  const thinkingFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toolFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirtyToolIdsRef = useRef<Set<string>>(new Set())

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

  const updateLogEntry = useCallback((id: string, toolName: string, content: string, isError?: boolean) => {
    logRef.current = updateToolLog(logRef.current, id, toolName, content, isError)
    setLogs(visibleLogs(logRef.current, MAX_VISIBLE_LOGS))
  }, [])

  const handleSubmit = useCallback(async (userInput: string) => {
    setIsStreaming(true)
    setStreamingText('')
    setStreamingThinking('')

    // Reset stream buffer
    streamBufferRef.current = ''
    thinkingBufferRef.current = ''
    toolOutputAccumRef.current.clear()
    dirtyToolIdsRef.current.clear()

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
/rollback — Preview changes since last checkpoint (/rollback confirm to execute)` })
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

        case '/verbose':
          setVerbose(v => !v)
          addLog({ type: 'text', content: verbose ? 'Verbose mode: off (show 20 lines)' : 'Verbose mode: on (show 200 lines)' })
          setIsStreaming(false)
          return

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
            addLog({ type: 'text', content: `Cache:\n  hit rate: ${(hitRate * 100).toFixed(1)}%\n  read tokens: ${usage.cache_read_input_tokens.toLocaleString()}\n  write tokens: ${usage.cache_creation_input_tokens.toLocaleString()}\n  total cached: ${totalCached.toLocaleString()}\n  input tokens: ${usage.input_tokens.toLocaleString()}\n  output tokens: ${usage.output_tokens.toLocaleString()}\n  estimated: ${session.getEstimatedTokens().toLocaleString()}\n  cost: ¥${cost.toFixed(4)}` })
          } else {
            addLog({ type: 'text', content: 'Usage: /debug [prompt|fingerprint|cache]' })
          }
          setIsStreaming(false)
          return
        }

        case '/rollback': {
          const subcmd = parts[1]
          if (subcmd === 'confirm') {
            const result = rollbackToCheckpoint(process.cwd())
            if (result.success) {
              addLog({ type: 'text', content: `Rolled back to checkpoint ${result.hash}. Working tree restored.` })
            } else {
              addLog({ type: 'text', content: 'Rollback failed. No checkpoint found.' })
            }
          } else {
            const preview = getRollbackPreview(process.cwd())
            if (preview) {
              addLog({ type: 'text', content: `⚠️  This will discard ALL changes since the checkpoint:\n${preview}\n\nType /rollback confirm to proceed.` })
            } else {
              addLog({ type: 'text', content: 'No checkpoint found or nothing to rollback.' })
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
          // Trigger full re-render
          addLog({ type: 'text', content: `Restored session ${targetId.slice(0, 8)}... (${msgs.length} messages)` })
          // Redraw: clear logs and reload from messages
          logRef.current = []
          setLogs([])
          setIsStreaming(false)
          return
        }
      }
    }

    addLog({ type: 'text', content: `> ${userInput}` })

    const scheduleToolFlush = (id: string, name: string) => {
      dirtyToolIdsRef.current.add(id)
      if (!toolFlushRef.current) {
        toolFlushRef.current = setTimeout(() => {
          for (const dirtyId of dirtyToolIdsRef.current) {
            const accumulated = toolOutputAccumRef.current.get(dirtyId)
            if (accumulated !== undefined) {
              updateLogEntry(dirtyId, name, summarizeToolOutput(accumulated, verbose ? 200 : 24))
            }
          }
          dirtyToolIdsRef.current.clear()
          toolFlushRef.current = null
        }, 50)
      }
    }

    await agent.run(userInput, {
      onTextDelta: (text) => {
        streamBufferRef.current += text
        if (!streamFlushRef.current) {
          streamFlushRef.current = setTimeout(() => {
            setStreamingText(streamBufferRef.current)
            streamFlushRef.current = null
          }, 50) // 50ms batch = ~20fps
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
        addLog({ type: 'tool', id, content: `Calling ${name}...`, toolName: name })
      },
      onToolResult: (id, name, result, isError) => {
        if (isError === undefined) {
          // Intermediate streaming chunk: accumulate and schedule batched flush
          const prev = toolOutputAccumRef.current.get(id) || ''
          toolOutputAccumRef.current.set(id, prev + result)
          scheduleToolFlush(id, name)
        } else {
          // Final result: clear accumulation, update directly
          // loop.ts already routes uiContent for tools that provide it
          toolOutputAccumRef.current.delete(id)
          updateLogEntry(id, name, result, isError)
        }
      },
      onTurnComplete: (_usage) => {
        // Flush any remaining buffered text
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

        // Flush thinking buffer
        if (thinkingFlushRef.current) {
          clearTimeout(thinkingFlushRef.current)
          thinkingFlushRef.current = null
        }
        setStreamingThinking(thinkingBufferRef.current)
        thinkingBufferRef.current = ''

        // Flush tool output buffer
        if (toolFlushRef.current) {
          clearTimeout(toolFlushRef.current)
          toolFlushRef.current = null
        }
        dirtyToolIdsRef.current.clear()

        setIsStreaming(false)
        setCacheHitRate(session.getCacheHitRate())

        // Cost estimate: ¥1/1M input_tokens, ¥4/1M output_tokens (DeepSeek V4 rough)
        const usage = session.getTotalUsage()
        const estimatedCost = (usage.input_tokens * 1 + usage.output_tokens * 4) / 1_000_000
        setCost(estimatedCost)
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
    <Box flexDirection="column" height="100%">
      <StatusBar
        model={model}
        cacheHitRate={cacheHitRate}
        totalCost={cost.toFixed(2)}
        currentTokens={currentTokens}
        maxTokens={maxTokens}
      />
      {pendingApproval && (
        <Box paddingX={2} borderStyle="single" borderColor="yellow">
          <Text bold color="yellow">Approve tool: {pendingApproval.name}?</Text>
          <Text> [y/n] </Text>
        </Box>
      )}
      {sessionPrompt === 'waiting' && (
        <Box paddingX={2} borderStyle="single" borderColor="cyan">
          <Text bold color="cyan">Previous session found.</Text>
          <Text> Press <Text bold>r</Text> to restore, any other key to start fresh </Text>
        </Box>
      )}
      <Box flexDirection="column" flexGrow={1}>
        {logs.map((log, i) => {
          if (log.type === 'tool') {
            return <ToolCard key={`${log.id ?? i}`} name={log.toolName ?? ''} result={log.content} isError={log.isError} verbose={verbose} />
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
      <InputBar onSubmit={handleSubmit} disabled={isStreaming || !!pendingApproval} />
    </Box>
  )
}
