import { memo, useState } from 'react'
import type { ConvoBlock } from '../state/event-reducer'

const TOOL_BODY_MAX = 10000

// Mirror of the TUI classifier (src/tui/format/collapsed-read-search.ts):
// only exploration tools (read / search / list) fold into the compact group.
// Action tools (bash / edit / write / run_tests / delegate / …) and errored
// results break the fold and render expanded as standalone cards.
const COLLAPSIBLE = new Set([
  // read 族
  'read_file', 'read', 'read-file', 'read_policy', 'read_section', 'file_info',
  // search 族
  'grep', 'glob', 'semantic_search', 'repo_map', 'repo_graph',
  'related_tests', 'inspect_project', 'ls',
])

/** Tool name from a `tool · X` / `result · X` role, falling back to the kind. */
export function toolNameOf(block: ConvoBlock): string {
  return (block.role ?? '').split(' · ')[1] ?? block.role ?? block.kind
}

/** Whether a tool/result block may fold into the compact read+search group. */
export function isCollapsibleTool(name: string): boolean {
  return COLLAPSIBLE.has(name.toLowerCase())
}

function truncateBody(text: string): string {
  return text.length > TOOL_BODY_MAX
    ? `${text.slice(0, TOOL_BODY_MAX)}\n…(已截断 ${text.length - TOOL_BODY_MAX} 字)`
    : text
}

// Cursor 3.0-style compact tool stream. A run of consecutive collapsible
// tool/result blocks renders as a tight bordered group; each row is a single
// line (status dot + name + first-line preview) that expands inline.
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

function ToolRowImpl({ block, defaultOpen = false }: { block: ConvoBlock; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const isResult = block.kind === 'result'
  const name = toolNameOf(block)
  const firstLine = block.text.split('\n', 1)[0] ?? ''
  const preview = firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine
  const status = block.isError ? 'err' : isResult ? 'ok' : 'run'

  return (
    <div className={`tool-row ${block.isError ? 'err' : ''}`}>
      <button className="tool-row-head" onClick={() => setOpen((o) => !o)}>
        <span className={`tool-dot ${status}`} aria-hidden />
        <span className={`chev ${open ? 'open' : ''}`} aria-hidden>▸</span>
        <span className="tool-name">{isResult ? `↳ ${name}` : name}</span>
        {!open && preview && <span className="tool-preview">{preview}</span>}
      </button>
      {open && <pre className="tool-body">{truncateBody(block.text)}</pre>}
    </div>
  )
}

const ToolRow = memo(ToolRowImpl, (a, b) => a.block === b.block && a.defaultOpen === b.defaultOpen)

// Standalone action-tool card: rendered OUTSIDE the read/search fold and open by
// default, so bash / edit / write / run_tests / delegate payloads and errors are
// visible without a click — matching the TUI's "action tools break the group".
function ToolCardImpl({ block }: { block: ConvoBlock }) {
  return (
    <div className="tool-card">
      <ToolRow block={block} defaultOpen />
    </div>
  )
}

export const ToolCard = memo(ToolCardImpl, (a, b) => a.block === b.block)
