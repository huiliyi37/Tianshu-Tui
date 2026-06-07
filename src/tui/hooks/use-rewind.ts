import { useCallback } from 'react'
import { createLogEntry } from '../log-state.js'
import type { RewindEntry } from '../rewind-list.js'
import type { SessionContext } from '../../agent/context.js'
import type { RingBuffer } from '../ring-buffer.js'
import type { LogEntry } from '../log-state.js'
import type { CommittedLog } from '../committed-log.js'

export interface UseRewindDeps {
  session: SessionContext
  historyBufferRef: React.MutableRefObject<RingBuffer<LogEntry>>
  committedLogRef: React.MutableRefObject<CommittedLog>
  totalItemsPushedRef: React.MutableRefObject<number>
  setHistoryVersion: React.Dispatch<React.SetStateAction<number>>
  inputBarRef: React.MutableRefObject<{ setValue: (v: string) => void }>
  pushStatic: (entry: LogEntry) => void
}

export function useRewind(deps: UseRewindDeps) {
  const { session, historyBufferRef, committedLogRef, totalItemsPushedRef, setHistoryVersion, inputBarRef, pushStatic } = deps

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
    const msgs = session.getMessages()
    session.replaceMessages(msgs.slice(0, entry.index))

    const items = historyBufferRef.current.items()
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
    // Rebuild committed-log to match the truncated ring buffer. reset() also
    // clears dedup so the kept prefix can be re-appended. Rewind is the one
    // sanctioned exception to the append-only invariant (an explicit redraw).
    committedLogRef.current.reset()
    for (let i = 0; i < cutIdx; i++) {
      committedLogRef.current.append(items[i]!)
    }
    // Reset totalItemsPushedRef to match new buffer size.
    totalItemsPushedRef.current = cutIdx
    setHistoryVersion(v => v + 1)

    inputBarRef.current.setValue(entry.content)
    pushStatic(createLogEntry({ type: 'system', content: `⏪ Rewound — message restored to input.` }))
  }, [session, historyBufferRef, committedLogRef, setHistoryVersion, inputBarRef, pushStatic])

  return { getRewindEntries, handleRewind }
}
