import { useEffect, useRef } from 'react'
import type { ConvoBlock } from '../state/event-reducer'

/** How many tail blocks a mission card shows. Kept small — these are glances,
 *  not the full thread (open the workspace for that). */
const TAIL = 4
/** Truncate any single line so one verbose tool dump can't blow up a card. */
const MAX_CHARS = 120

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? ''
  return line.length > MAX_CHARS ? line.slice(0, MAX_CHARS - 1) + '…' : line
}

/** Strip the `tool · ` / `result · ` prefix the reducer bakes into `role`. */
function nameOf(role: string | undefined): string {
  if (!role) return ''
  const idx = role.indexOf('·')
  return idx >= 0 ? role.slice(idx + 1).trim() : role.trim()
}

function MiniLine({ block }: { block: ConvoBlock }) {
  switch (block.kind) {
    case 'user':
    case 'steer':
      return (
        <div className="mini-line mini-user">
          <span className="mini-glyph">▸</span>
          <span className="mini-text">{firstLine(block.text)}</span>
        </div>
      )
    case 'assistant':
      return (
        <div className="mini-line mini-assistant">
          <span className="mini-text">{firstLine(block.text)}</span>
        </div>
      )
    case 'thinking':
      return (
        <div className="mini-line mini-thinking">
          <span className="mini-text">{firstLine(block.text)}</span>
        </div>
      )
    case 'tool':
      return (
        <div className="mini-line mini-tool">
          <span className="mini-glyph">⚙</span>
          <span className="mini-text">{nameOf(block.role)}</span>
        </div>
      )
    case 'result':
      return (
        <div className={`mini-line mini-result${block.isError ? ' is-error' : ''}`}>
          <span className="mini-glyph">{block.isError ? '✗' : '✓'}</span>
          <span className="mini-text">{nameOf(block.role) || firstLine(block.text)}</span>
        </div>
      )
    default:
      return null
  }
}

/**
 * Compact tail renderer for a session's `view.blocks` — the body of a live
 * mission card. Plain text only (no markdown / virtualization); shows just the
 * last few blocks and auto-scrolls to bottom as new ones arrive.
 */
export function MiniStream({ blocks, rev }: { blocks: ConvoBlock[]; rev: number }) {
  const ref = useRef<HTMLDivElement>(null)
  // Only the visible kinds make sense at a glance; drop phase/turn/checkpoint noise.
  const tail = blocks
    .filter((b) =>
      b.kind === 'user' ||
      b.kind === 'steer' ||
      b.kind === 'assistant' ||
      b.kind === 'thinking' ||
      b.kind === 'tool' ||
      b.kind === 'result',
    )
    .slice(-TAIL)

  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [rev, tail.length])

  if (tail.length === 0) {
    return <div className="mini-stream mini-empty">等待输出…</div>
  }

  return (
    <div className="mini-stream" ref={ref}>
      {tail.map((b) => (
        <MiniLine key={b.key} block={b} />
      ))}
    </div>
  )
}
