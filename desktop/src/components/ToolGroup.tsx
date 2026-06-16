import { memo, useState } from 'react'
import type { ConvoBlock } from '../state/event-reducer'

const TOOL_BODY_MAX = 10000

// Cursor 3.0-style compact tool stream. A run of consecutive tool/result blocks
// renders as a tight bordered group; each row is a single line (status dot +
// name + first-line preview) that expands inline to the full payload.
function ToolGroupImpl({ items }: { items: ConvoBlock[] }) {
  return (
    <div className="tool-group">
      {items.map((b) => <ToolRow key={b.key} block={b} />)}
    </div>
  )
}

// groupBlocks rebuilds the `items` array every frame, so reference comparison
// would always miss. Compare contents instead: the group's ConvoBlocks keep
// identity during streaming (immutable reducer), so this is O(rows) and small.
export const ToolGroup = memo(ToolGroupImpl, (a, b) =>
  a.items.length === b.items.length && a.items.every((x, i) => x === b.items[i])
)

function ToolRowImpl({ block }: { block: ConvoBlock }) {
  const [open, setOpen] = useState(false)
  const isResult = block.kind === 'result'
  const name = (block.role ?? block.kind).split(' · ')[1] ?? block.role ?? block.kind
  const firstLine = block.text.split('\n', 1)[0] ?? ''
  const preview = firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine
  const status = block.isError ? 'err' : isResult ? 'ok' : 'run'
  const body =
    block.text.length > TOOL_BODY_MAX
      ? `${block.text.slice(0, TOOL_BODY_MAX)}\n…(已截断 ${block.text.length - TOOL_BODY_MAX} 字)`
      : block.text

  return (
    <div className={`tool-row ${block.isError ? 'err' : ''}`}>
      <button className="tool-row-head" onClick={() => setOpen((o) => !o)}>
        <span className={`tool-dot ${status}`} aria-hidden />
        <span className={`chev ${open ? 'open' : ''}`} aria-hidden>▸</span>
        <span className="tool-name">{isResult ? `↳ ${name}` : name}</span>
        {!open && preview && <span className="tool-preview">{preview}</span>}
      </button>
      {open && <pre className="tool-body">{body}</pre>}
    </div>
  )
}

const ToolRow = memo(ToolRowImpl, (a, b) => a.block === b.block)
