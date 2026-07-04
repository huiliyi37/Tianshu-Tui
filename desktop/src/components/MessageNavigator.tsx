import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/** One jumpable user-message anchor. `renderedIndex` is the row index into the
 *  virtualized `rendered[]` list — the value passed to `scrollToIndex`. */
export interface TurnEntry {
  renderedIndex: number
  key: string
  text: string
  ts?: number
}

interface Props {
  turns: TurnEntry[]
  /** Rendered-row index of the user turn currently at/above the viewport top. */
  activeIndex: number | null
  onJump: (renderedIndex: number) => void
}

function relTime(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins}分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}天前`
  return `${Math.floor(days / 30)}个月前`
}

/** First non-empty line of a message, trimmed for the outline row. */
function preview(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? ''
  return line.length > 80 ? line.slice(0, 80) + '…' : line
}

/**
 * Floating "message navigator" — a table-of-contents of user turns. Lets the
 * user jump straight to any earlier message instead of scrolling. Reuses the
 * thread virtualizer via the `onJump(renderedIndex)` callback.
 *
 * Hidden entirely when there are fewer than 2 user turns (nothing to navigate).
 */
export function MessageNavigator({ turns, activeIndex, onJump }: Props) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<number>(0) // index into `turns`
  const panelRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  // When opening, start the selection at the turn nearest the current viewport
  // (the last turn whose row is at or above the viewport top).
  useEffect(() => {
    if (!open) return
    let activeTurn = -1
    if (activeIndex != null) {
      for (let i = turns.length - 1; i >= 0; i--) {
        if (turns[i]!.renderedIndex <= activeIndex) { activeTurn = i; break }
      }
    }
    setSelected(activeTurn >= 0 ? activeTurn : turns.length - 1)
  }, [open, activeIndex, turns])

  // Close on outside click / Escape while open.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  // Keep the selected row scrolled into view inside the panel.
  useLayoutEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-sel="${selected}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [open, selected])

  const jump = useCallback((i: number) => {
    const t = turns[i]
    if (!t) return
    onJump(t.renderedIndex)
    setOpen(false)
  }, [turns, onJump])

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); return }
    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault()
      setSelected((p) => Math.min(turns.length - 1, p + 1))
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault()
      setSelected((p) => Math.max(0, p - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      jump(selected)
    }
  }, [turns.length, selected, jump])

  if (turns.length < 2) return null

  return (
    <div className="msg-nav" ref={panelRef}>
      {open && (
        <div className="msg-nav-panel" role="dialog" aria-label="消息导航" onKeyDown={onKeyDown}>
          <div className="msg-nav-head">
            <span className="msg-nav-title">消息导航</span>
            <span className="msg-nav-count">{turns.length}</span>
          </div>
          <ul className="msg-nav-list" ref={listRef} tabIndex={-1}>
            {turns.map((t, i) => (
              <li key={t.key} data-sel={i}>
                <button
                  type="button"
                  className={`msg-nav-item${i === selected ? ' is-selected' : ''}${t.renderedIndex === activeIndex ? ' is-current' : ''}`}
                  onClick={() => jump(i)}
                  onMouseEnter={() => setSelected(i)}
                  title={t.text}
                >
                  <span className="msg-nav-idx">{i + 1}</span>
                  <span className="msg-nav-text">{preview(t.text)}</span>
                  {t.ts != null && <span className="msg-nav-time">{relTime(t.ts)}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <button
        type="button"
        className={`msg-nav-toggle${open ? ' is-open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-label="消息导航"
        aria-expanded={open}
        title="消息导航 · 跳转历史消息"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <line x1="8" y1="6" x2="21" y2="6" />
          <line x1="8" y1="12" x2="21" y2="12" />
          <line x1="8" y1="18" x2="21" y2="18" />
          <line x1="3" y1="6" x2="3.01" y2="6" />
          <line x1="3" y1="12" x2="3.01" y2="12" />
          <line x1="3" y1="18" x2="3.01" y2="18" />
        </svg>
      </button>
    </div>
  )
}
