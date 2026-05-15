import { useState, useCallback, useRef } from 'react'
import { Box, Text, useInput } from 'ink'
import { StatusBar } from './status-bar.js'
import { InputBar } from './input.js'
import { StreamOutput } from './stream.js'
import { ThinkingCollapser } from './thinking.js'
import { ToolCard } from './tool-card.js'
import { AgentLoop } from '../agent/loop.js'
import { SessionContext } from '../agent/context.js'

interface PendingApproval {
  id: string
  name: string
  input: Record<string, unknown>
  resolve: (approved: boolean) => void
}

interface AppProps {
  agent: AgentLoop
  session: SessionContext
  model: string
  maxTokens: number
}

interface LogEntry {
  type: 'text' | 'tool'
  id?: string
  content: string
  toolName?: string
  isError?: boolean
}

const MAX_VISIBLE_LOGS = 50

export function App({ agent, session, model, maxTokens }: AppProps) {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [streamingText, setStreamingText] = useState('')
  const [streamingThinking, setStreamingThinking] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [cost, setCost] = useState(0)
  const [cacheHitRate, setCacheHitRate] = useState(0)
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null)
  const logRef = useRef<LogEntry[]>([])
  const streamBufferRef = useRef('')
  const streamFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const addLog = useCallback((entry: LogEntry) => {
    logRef.current = [...logRef.current, entry]
    setLogs(logRef.current.slice(-MAX_VISIBLE_LOGS))
  }, [])

  const handleSubmit = useCallback(async (userInput: string) => {
    setIsStreaming(true)
    setStreamingText('')
    setStreamingThinking('')

    // Reset stream buffer
    streamBufferRef.current = ''
    if (streamFlushRef.current) {
      clearTimeout(streamFlushRef.current)
      streamFlushRef.current = null
    }

    addLog({ type: 'text', content: `> ${userInput}` })

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
        setStreamingThinking(thinking)
      },
      onToolUse: (id, name) => {
        addLog({ type: 'tool', id, content: `Calling ${name}...`, toolName: name })
      },
      onToolResult: (id, name, result, isError) => {
        addLog({ type: 'tool', id, content: result, toolName: name, isError })
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
        setStreamingThinking('')
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
  }, [agent, session, addLog])

  useInput((_input, _key) => {
    if (!pendingApproval) return
    // Only accept explicit y/n — never Enter (prevents accidental approval)
    if (_input.toLowerCase() === 'y') {
      pendingApproval.resolve(true)
      setPendingApproval(null)
    } else if (_input.toLowerCase() === 'n') {
      pendingApproval.resolve(false)
      setPendingApproval(null)
    }
  })

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
      <Box flexDirection="column" flexGrow={1}>
        {logs.map((log, i) => {
          if (log.type === 'tool') {
            return <ToolCard key={`${log.id ?? i}`} name={log.toolName ?? ''} result={log.content} isError={log.isError} />
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
