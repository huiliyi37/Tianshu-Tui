import { memo, useState, useMemo } from 'react'
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

const SEARCH_TOOLS = new Set(['grep', 'glob', 'semantic_search', 'repo_map', 'repo_graph', 'related_tests', 'inspect_project'])
const LIST_TOOLS = new Set(['ls'])

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

// ── Pairing: merge tool_use + tool_result into single entries ───

interface PairedEntry {
  tool?: ConvoBlock
  result?: ConvoBlock
  name: string
}

function pairEntries(items: ConvoBlock[]): PairedEntry[] {
  const entries: PairedEntry[] = []
  for (const b of items) {
    const name = toolNameOf(b)
    if (b.kind === 'tool') {
      entries.push({ tool: b, name })
    } else if (b.kind === 'result') {
      let matched = false
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i]!
        if (e.tool && !e.result && e.name === name) {
          e.result = b
          matched = true
          break
        }
      }
      if (!matched) entries.push({ result: b, name })
    }
  }
  return entries
}

function buildGroupSummary(entries: PairedEntry[]): string {
  let reads = 0, searches = 0, lists = 0, pending = 0
  for (const e of entries) {
    const name = e.name.toLowerCase()
    if (!e.result) { pending++; continue }
    if (SEARCH_TOOLS.has(name)) searches++
    else if (LIST_TOOLS.has(name)) lists++
    else reads++
  }
  const parts: string[] = []
  if (reads > 0) parts.push(`Read ${reads} file${reads > 1 ? 's' : ''}`)
  if (searches > 0) parts.push(`Searched ${searches} pattern${searches > 1 ? 's' : ''}`)
  if (lists > 0) parts.push(`Listed ${lists} dir${lists > 1 ? 's' : ''}`)
  if (pending > 0) parts.push(`${pending} pending`)
  return parts.length > 0 ? parts.join(', ') : '…'
}

// ── ToolGroup: Cursor 3.0-style compact group with summary header ──

function ToolGroupImpl({ items }: { items: ConvoBlock[] }) {
  const [collapsed, setCollapsed] = useState(true)
  const entries = useMemo(() => pairEntries(items), [items])
  const summary = useMemo(() => buildGroupSummary(entries), [entries])
  const hasPending = entries.some(e => !e.result)

  return (
    <div className="tool-group">
      <button
        className="tool-group-summary"
        onClick={() => setCollapsed(c => !c)}
        aria-expanded={!collapsed}
      >
        <span className={`chev ${collapsed ? '' : 'open'}`} aria-hidden>▸</span>
        <span className={`tool-dot ${hasPending ? 'run' : 'ok'}`} aria-hidden />
        <span className="tool-group-label">{summary}</span>
        <span className="tool-group-count">{entries.length}</span>
      </button>
      {!collapsed && entries.map((e, i) => (
        <PairedRow key={e.tool?.key ?? e.result?.key ?? i} entry={e} />
      ))}
    </div>
  )
}

export const ToolGroup = memo(ToolGroupImpl, (a, b) =>
  a.items.length === b.items.length && a.items.every((x, i) => x === b.items[i])
)

function PairedRowImpl({ entry }: { entry: PairedEntry }) {
  const [open, setOpen] = useState(false)
  const name = entry.name
  const text = entry.result?.text ?? entry.tool?.text ?? ''
  const firstLine = text.split('\n', 1)[0] ?? ''
  const preview = firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine
  const status = entry.result?.isError ? 'err' : entry.result ? 'ok' : 'run'

  return (
    <div className={`tool-row ${entry.result?.isError ? 'err' : ''}`}>
      <button className="tool-row-head" onClick={() => setOpen(o => !o)}>
        <span className={`tool-dot ${status}`} aria-hidden />
        <span className="tool-name">{name}</span>
        {!open && preview && <span className="tool-preview">{preview}</span>}
      </button>
      {open && <pre className="tool-body">{truncateBody(text)}</pre>}
    </div>
  )
}

const PairedRow = memo(PairedRowImpl, (a, b) =>
  a.entry.tool === b.entry.tool && a.entry.result === b.entry.result
)

// ── ToolRow: single block row (used by ToolCard for action tools) ──

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
// default, so bash / edit / write / delegate payloads and errors are visible
// without a click — matching the TUI's "action tools break the group".
// Exception: successful run_tests results default to collapsed — the summary
// line ("✓ N passed") is already complete; expanding just adds noise. This
// aligns with Cursor's "Collapse Auto-Run Commands" and reduces the visual
// clutter of repeated targeted test runs stacking up in the thread.
function ToolCardImpl({ block }: { block: ConvoBlock }) {
  const name = toolNameOf(block)
  const isSuccessfulRunTests =
    block.kind === 'result' && !block.isError && name.toLowerCase() === 'run_tests'
  return (
    <div className="tool-card">
      <ToolRow block={block} defaultOpen={!isSuccessfulRunTests} />
    </div>
  )
}

export const ToolCard = memo(ToolCardImpl, (a, b) => a.block === b.block)
