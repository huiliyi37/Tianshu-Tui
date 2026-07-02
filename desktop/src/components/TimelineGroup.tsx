import { memo, useState, useMemo, useEffect, Children } from 'react'
import type { ConvoBlock } from '../state/event-reducer'
import { ChevronRight, ChevronDown } from 'lucide-react'

// A timeline run is collapsed by default (one tiny row). When expanded, only the
// trailing window of steps is mounted so a long tool+thinking run doesn't inflate
// into one giant DOM subtree inside a single virtual row — the outer virtualizer
// measures/repaints the whole row on each change, so an unbounded expanded run
// janks hard. The streaming tail is always within the window; "show earlier"
// reveals the rest on demand.
const TIMELINE_WINDOW = 30

export function TimelineGroupImpl({ blocks, children, forceOpen }: { blocks: ConvoBlock[], children: React.ReactNode, forceOpen?: boolean }) {
  const [collapsed, setCollapsed] = useState(!forceOpen)
  const [showAll, setShowAll] = useState(false)

  // P1-2 verbose view mode expands all runs; leaving it re-collapses them.
  // Manual toggles still work in between (this only fires on mode change).
  useEffect(() => {
    if (forceOpen !== undefined) setCollapsed(!forceOpen)
  }, [forceOpen])

  const summary = useMemo(() => {
    // just a simple count
    const tools = blocks.filter(b => b.kind === 'tool').length
    const thinking = blocks.filter(b => b.kind === 'thinking').length
    if (tools > 0 && thinking > 0) return `Worked for ${blocks.length} steps (Thinking + ${tools} tools)`
    if (tools > 0) return `Worked for ${blocks.length} steps (${tools} tools)`
    if (thinking > 0) return `Worked for ${blocks.length} steps (Thinking)`
    return `Worked for ${blocks.length} steps`
  }, [blocks])

  const childArray = Children.toArray(children)
  const hiddenCount = childArray.length - TIMELINE_WINDOW
  const windowed = !showAll && hiddenCount > 0
  const shown = windowed ? childArray.slice(childArray.length - TIMELINE_WINDOW) : childArray

  return (
    <div className={`timeline-group ${collapsed ? 'collapsed' : 'open'}`}>
      <button className="timeline-summary" onClick={() => setCollapsed(!collapsed)}>
        <span className="tl-icon">
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </span>
        <span className="tl-label">{summary}</span>
        <span className="tl-line" />
      </button>
      {!collapsed && (
        <div className="timeline-body">
          {windowed && (
            <button className="timeline-more" onClick={() => setShowAll(true)}>
              显示更早的 {hiddenCount} 步
            </button>
          )}
          {shown}
        </div>
      )}
    </div>
  )
}

export const TimelineGroup = memo(TimelineGroupImpl, (a, b) =>
  a.forceOpen === b.forceOpen && a.blocks.length === b.blocks.length && a.blocks.every((x, i) => x === b.blocks[i])
)
