import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
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

/** Precomputed glance line — the selector-friendly projection of a ConvoBlock:
 *  text is already first-line-truncated, so two MiniLineData compare equal
 *  exactly when the rendered card body would look identical. */
export interface MiniLineData {
  key: string
  kind: ConvoBlock['kind']
  text: string
  role?: string
  isError?: boolean
}

const GLANCE_KINDS = new Set(['user', 'steer', 'assistant', 'thinking', 'tool', 'result'])

/** Project `view.blocks` into the last few glance lines (pure — usable inside
 *  a useSessionEventsSelector so streaming deltas that don't change the
 *  visible first lines skip the card re-render entirely). */
export function miniTail(blocks: ConvoBlock[]): MiniLineData[] {
  const out: MiniLineData[] = []
  for (let i = blocks.length - 1; i >= 0 && out.length < TAIL; i--) {
    const b = blocks[i]!
    if (!GLANCE_KINDS.has(b.kind)) continue
    out.push({ key: b.key, kind: b.kind, text: firstLine(b.text), role: b.role, isError: b.isError })
  }
  return out.reverse()
}

export function miniLinesEqual(a: MiniLineData[], b: MiniLineData[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    if (x.key !== y.key || x.kind !== y.kind || x.text !== y.text || x.role !== y.role || x.isError !== y.isError) {
      return false
    }
  }
  return true
}

function MiniLine({ line }: { line: MiniLineData }) {
  switch (line.kind) {
    case 'user':
    case 'steer':
      return (
        <div className="mini-line mini-user">
          <span className="mini-glyph">▸</span>
          <span className="mini-text">{line.text}</span>
        </div>
      )
    case 'assistant':
      return (
        <div className="mini-line mini-assistant">
          <span className="mini-text">{line.text}</span>
        </div>
      )
    case 'thinking':
      return (
        <div className="mini-line mini-thinking">
          <span className="mini-text">{line.text}</span>
        </div>
      )
    case 'tool':
      return (
        <div className="mini-line mini-tool">
          <span className="mini-glyph">⚙</span>
          <span className="mini-text">{nameOf(line.role)}</span>
        </div>
      )
    case 'result':
      return (
        <div className={`mini-line mini-result${line.isError ? ' is-error' : ''}`}>
          <span className="mini-glyph">{line.isError ? '✗' : '✓'}</span>
          <span className="mini-text">{nameOf(line.role) || line.text}</span>
        </div>
      )
    default:
      return null
  }
}

/**
 * Compact tail renderer for a session's glance lines — the body of a live
 * mission card. Plain text only (no markdown / virtualization); shows just the
 * last few lines and auto-scrolls to bottom as new ones arrive.
 */
export function MiniStream({ lines }: { lines: MiniLineData[] }) {
  const { t } = useTranslation('threadView')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  if (lines.length === 0) {
    return <div className="mini-stream mini-empty">{t('mini.waiting')}</div>
  }

  return (
    <div className="mini-stream" ref={ref}>
      {lines.map((l) => (
        <MiniLine key={l.key} line={l} />
      ))}
    </div>
  )
}
