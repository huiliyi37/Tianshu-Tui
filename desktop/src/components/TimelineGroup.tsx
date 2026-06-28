import { memo, useState, useMemo } from 'react'
import type { ConvoBlock } from '../state/event-reducer'
import { ChevronRight, ChevronDown } from 'lucide-react'

export function TimelineGroupImpl({ blocks, children }: { blocks: ConvoBlock[], children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(true)

  const summary = useMemo(() => {
    // just a simple count
    const tools = blocks.filter(b => b.kind === 'tool').length
    const thinking = blocks.filter(b => b.kind === 'thinking').length
    if (tools > 0 && thinking > 0) return `Worked for ${blocks.length} steps (Thinking + ${tools} tools)`
    if (tools > 0) return `Worked for ${blocks.length} steps (${tools} tools)`
    if (thinking > 0) return `Worked for ${blocks.length} steps (Thinking)`
    return `Worked for ${blocks.length} steps`
  }, [blocks])

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
          {children}
        </div>
      )}
    </div>
  )
}

export const TimelineGroup = memo(TimelineGroupImpl, (a, b) => 
  a.blocks.length === b.blocks.length && a.blocks.every((x, i) => x === b.blocks[i])
)
