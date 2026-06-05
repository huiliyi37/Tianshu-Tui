import { useInput } from 'ink'
import { createLogEntry } from '../log-state.js'
import { SessionPersist } from '../../agent/session-persist.js'
import { replayMessagesToLogEntries } from '../history-replay.js'
import { openInEditor } from '../external-editor.js'
import type { AgentLoop } from '../../agent/loop.js'
import type { SessionContext } from '../../agent/context.js'
import type { SurfaceRouterApi } from '../surface/types.js'

export interface UseGlobalInputDeps {
  agent: AgentLoop
  session: SessionContext
  maxTokens: number
  // States
  isStreaming: boolean
  setIsStreaming: (v: boolean) => void
  isStreamingRef: React.MutableRefObject<boolean>
  pendingApproval: PendingApproval | null
  setPendingApproval: (v: PendingApproval | null) => void
  pendingIntent: PendingIntent | null
  setPendingIntent: (v: PendingIntent | null) => void
  sessionPrompt: 'waiting' | 'done'
  setSessionPrompt: (v: 'waiting' | 'done') => void
  // Refs
  steerBuffer: React.MutableRefObject<import('../steer-buffer.js').SteerBuffer>
  lastCtrlCRef: React.MutableRefObject<number>
  lastEscRef: React.MutableRefObject<number>
  inputBarRef: React.MutableRefObject<{ clear: () => void; hasContent: () => boolean; setValue: (v: string) => void }>
  restorableRef: React.MutableRefObject<string[]>
  // Callbacks
  flushStreamingState: () => void
  flushStaticBatch: () => void
  pushStatic: (entry: import('../log-state.js').LogEntry) => void
  pushStaticBatch: (entries: readonly import('../log-state.js').LogEntry[]) => void
  setCacheHitRate: (v: number) => void
  setSummaryState: React.Dispatch<React.SetStateAction<import('../summary-state.js').SummaryState>>
  pushTokenHistory: (pct: number) => number[]
  handleSubmit: (text: string) => void
  // Surface
  activeOverlay: string | null
  surfaceRouter: SurfaceRouterApi
  surfacePush: (id: string) => void
  surfacePop: () => void
  isSurfaceVisible: (id: string) => boolean
}

interface PendingApproval {
  id: string
  name: string
  input: Record<string, unknown>
  resolve: (approved: boolean) => void
}

interface PendingIntent {
  intent: import('../../agent/intent-preview.js').IntentPreview
  resolve: (action: import('../../agent/intent-preview.js').IntentPreviewAction) => void
}

export function useGlobalInput(deps: UseGlobalInputDeps): void {
  const {
    agent, session, maxTokens,
    isStreaming, setIsStreaming, isStreamingRef,
    pendingApproval, setPendingApproval,
    pendingIntent, setPendingIntent,
    sessionPrompt, setSessionPrompt,
    steerBuffer, lastCtrlCRef, lastEscRef, inputBarRef, restorableRef,
    flushStreamingState, flushStaticBatch, pushStatic, pushStaticBatch,
    setCacheHitRate, setSummaryState, pushTokenHistory, handleSubmit,
    activeOverlay, surfaceRouter, surfacePush, surfacePop, isSurfaceVisible,
  } = deps

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
        flushStreamingState()
        flushStaticBatch()
        agent.abort()
        // Preserve queued guidance — do NOT drain on interrupt. drain() empties
        // the buffer but the interrupt path never re-injects it (addAnchor is
        // display-only; the real steer→model path is onSteerDrain → tool_result).
        // Leaving pending intact lets the next tool-using turn inject it.
        const ctrlPendingCount = steerBuffer.current.getPending().length
        if (ctrlPendingCount > 0) {
          pushStatic(createLogEntry({ type: 'system', content: `📨 ${ctrlPendingCount} queued message(s) preserved for next turn.` }))
        }
        setIsStreaming(false); isStreamingRef.current = false
        pushStatic(createLogEntry({ type: 'system', content: '⏹ Interrupted.' }))
        lastCtrlCRef.current = Date.now()
        return
      }
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
          flushStreamingState()
          flushStaticBatch()
          agent.abort()
          // Preserve queued guidance — see Ctrl+C handler above.
          const escPendingCount = steerBuffer.current.getPending().length
          if (escPendingCount > 0) {
            pushStatic(createLogEntry({ type: 'system', content: `📨 ${escPendingCount} queued message(s) preserved for next turn.` }))
          }
          setIsStreaming(false); isStreamingRef.current = false
          pushStatic(createLogEntry({ type: 'system', content: '⏹ Interrupted.' }))
          lastEscRef.current = 0
          surfacePush('rewind')
        } else {
          lastEscRef.current = now
          pushStatic(createLogEntry({ type: 'system', content: '(Esc again to rewind)' }))
        }
        return
      }
      if (lastEscRef.current && now - lastEscRef.current < 1000) {
        lastEscRef.current = 0
        surfacePush('rewind')
      } else {
        lastEscRef.current = now
      }
      return
    }

    if (sessionPrompt === 'waiting') {
      const sessions = restorableRef.current
      if (_input === 'r' && sessions.length > 0) {
        const id = sessions[0]!
        setSessionPrompt('done')
        pushStatic(createLogEntry({ type: 'system', content: `Restoring session ${id.slice(0, 8)}...` }))
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
}
