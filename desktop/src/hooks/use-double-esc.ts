import { useEffect, useRef } from 'react'

interface UseDoubleEscOptions {
  /** Called when ESC is pressed twice within `intervalMs`. */
  onDoubleEsc: () => void
  /** Called on a single ESC (e.g. clear input). Optional. */
  onSingleEsc?: () => void
  /** Max interval between the two ESC presses. Default 400ms. */
  intervalMs?: number
  /** Whether the double-ESC detection is active. Default true. */
  enabled?: boolean
}

/**
 * Detects double-ESC within a time window.
 * First ESC → onSingleEsc (if provided) + record timestamp.
 * Second ESC within intervalMs → onDoubleEsc + reset.
 */
export function useDoubleEsc({ onDoubleEsc, onSingleEsc, intervalMs = 400, enabled = true }: UseDoubleEscOptions) {
  const lastEscAt = useRef(0)

  useEffect(() => {
    if (!enabled) return

    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return

      const now = Date.now()
      if (now - lastEscAt.current < intervalMs) {
        // Double-ESC
        lastEscAt.current = 0
        onDoubleEsc()
      } else {
        // First ESC
        lastEscAt.current = now
        onSingleEsc?.()
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onDoubleEsc, onSingleEsc, intervalMs, enabled])
}
