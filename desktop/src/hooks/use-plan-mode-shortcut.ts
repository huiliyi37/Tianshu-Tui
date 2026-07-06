import { useEffect } from 'react'

/**
 * Global Shift+Tab → toggle Plan/Agent mode (Cursor parity). The composer
 * textarea already handles Shift+Tab locally (and calls preventDefault), so
 * this window-level fallback covers the rest of the surface — checking
 * `defaultPrevented` avoids double-toggling, and other editable elements are
 * skipped so focus-back navigation inside inputs keeps working.
 */
export function usePlanModeShortcut(onToggle: (() => void) | undefined, enabled = true) {
  useEffect(() => {
    if (!enabled || !onToggle) return

    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !e.shiftKey || e.defaultPrevented) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      e.preventDefault()
      onToggle()
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onToggle, enabled])
}
