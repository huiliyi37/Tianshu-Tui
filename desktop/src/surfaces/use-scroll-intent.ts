import { useCallback, useRef } from 'react'

/** Keys that trigger native upward scroll in the messages container. */
const NATIVE_SCROLL_UP_KEYS = ['PageUp', 'Home', 'ArrowUp']

/**
 * Tracks synchronous "user wants to scroll up" intent for a streaming chat view.
 *
 * Problem: React state updates (e.g. `scrolledUp`) are asynchronous. When a
 * streaming token batch arrives in the same frame as a user scroll-up gesture,
 * the auto-scroll effect may read the stale state and yank the view back to the
 * bottom. This hook uses a mutable ref to capture intent synchronously, before
 * React commits any state.
 *
 * Covers:
 * - Wheel / trackpad up (`onWheel`)
 * - Native keyboard scroll-up keys (`onKeyDown`)
 * - Scrollbar drag or any other non-wheel upward scroll (`onScroll` detects
 *   decreasing scrollTop)
 */
export function useUserScrollIntent() {
  /** Synchronous flag: true the instant any upward gesture is detected. */
  const userIntentUpRef = useRef(false)
  /** Last seen scrollTop, used by onScroll to detect upward movement. */
  const lastScrollTopRef = useRef(0)

  /**
   * Wheel/trackpad intent. Set synchronously so the auto-scroll effect (which
   * may run in the same frame) sees the intent immediately.
   *
   * If the container is already at the very top we do NOT set the flag: there
   * is no content above to read, so new streaming content should still auto-scroll.
   */
  const onWheel = useCallback((e: { deltaY: number }, currentScrollTop: number) => {
    if (e.deltaY < 0 && currentScrollTop > 0) {
      userIntentUpRef.current = true
    }
  }, [])

  /**
   * Scroll event intent. Detects upward movement from any source (scrollbar drag,
   * touch, programmatic-but-user-initiated, etc.) by comparing scrollTop with the
   * previous value. Clears intent only when the user scrolls back DOWN to near the
   * bottom — if they are scrolling up while still in the near-bottom zone we keep
   * the intent so auto-scroll does not fight the gesture.
   */
  const onScroll = useCallback((currentScrollTop: number, nearBottom: boolean) => {
    const prevScrollTop = lastScrollTopRef.current
    lastScrollTopRef.current = currentScrollTop
    if (nearBottom && currentScrollTop > prevScrollTop) {
      // Scrolling down back to the bottom: explicit clear wins.
      userIntentUpRef.current = false
    } else if (currentScrollTop < prevScrollTop) {
      // Any upward movement sets intent (including near-bottom upward nudges).
      userIntentUpRef.current = true
    }
  }, [])

  /**
   * Keyboard intent. Native scroll-up keys (PageUp, Home, ArrowUp) move the view
   * upward without firing `onWheel`, so we capture them here synchronously.
   * Alt+ArrowUp is reserved for message-block navigation and is ignored.
   */
  const onKeyDown = useCallback((e: { key: string; altKey: boolean }) => {
    if (NATIVE_SCROLL_UP_KEYS.includes(e.key) && !e.altKey) {
      userIntentUpRef.current = true
    }
  }, [])

  /** Explicitly clear intent, e.g. when the user clicks "scroll to bottom". */
  const clearIntent = useCallback(() => {
    userIntentUpRef.current = false
  }, [])

  return {
    userIntentUpRef,
    onWheel,
    onScroll,
    onKeyDown,
    clearIntent,
  }
}
