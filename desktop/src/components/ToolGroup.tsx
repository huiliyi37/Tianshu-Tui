import { memo, useState, useMemo, useEffect } from 'react'
import type { ConvoBlock } from '../state/event-reducer'
import type { ToolDensity } from '../lib/persist'
import { FilePath } from './FilePath'
import { parseMcpToolName } from '../lib/approval-preview'

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
const RUN_TEST_TOOLS = new Set(['run_tests'])

/** Tool name from a `tool · X` / `result · X` role, falling back to the kind. */
export function toolNameOf(block: ConvoBlock): string {
  return (block.role ?? '').split(' · ')[1] ?? block.role ?? block.kind
}

/** Whether a tool/result block may fold into the compact read+search group. */
export function isCollapsibleTool(name: string): boolean {
  return COLLAPSIBLE.has(name.toLowerCase())
}

/** Whether a tool/result block is a run_tests call eligible for action grouping. */
export function isRunTestsTool(name: string): boolean {
  return RUN_TEST_TOOLS.has(name.toLowerCase())
}

function truncateBody(text: string): string {
  return text.length > TOOL_BODY_MAX
    ? `${text.slice(0, TOOL_BODY_MAX)}\n…(已截断 ${text.length - TOOL_BODY_MAX} 字)`
    : text
}

const FILE_PATH_RE = /^\/[\w./-]+/

function PreviewText({ text }: { text: string }) {
  const match = text.match(FILE_PATH_RE)
  if (match) return <FilePath path={match[0]} className="tool-preview" />
  return <span className="tool-preview">{text}</span>
}

// ── Pairing: merge tool_use + tool_result into single entries ───

export interface PairedEntry {
  tool?: ConvoBlock
  result?: ConvoBlock
  name: string
}

export function pairEntries(items: ConvoBlock[]): PairedEntry[] {
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
  // run_tests group — test-run summary (separate from explore group)
  const allRunTests = entries.length > 0 && entries.every(e => isRunTestsTool(e.name))
  if (allRunTests) {
    let passed = 0, failed = 0, pending = 0
    for (const e of entries) {
      if (!e.result) { pending++; continue }
      if (e.result.isError) failed++
      else passed++
    }
    const parts: string[] = []
    if (passed > 0) parts.push(`${passed} passed`)
    if (failed > 0) parts.push(`${failed} failed`)
    if (pending > 0) parts.push(`${pending} pending`)
    return `Ran ${entries.length} test${entries.length > 1 ? 's' : ''} · ${parts.join(', ')}`
  }

  // explore group — read/search/list summary
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
function ToolGroupImpl({ items, density = 'balanced' }: { items: ConvoBlock[]; density?: ToolDensity }) {
  // localDensity: per-group override (null = follow global). Cycles:
  //   null → compact → detailed → null
  const [localDensity, setLocalDensity] = useState<ToolDensity | null>(null)
  const effectiveDensity = localDensity ?? density
  const compact = effectiveDensity === 'compact'
  const [collapsed, setCollapsed] = useState(effectiveDensity !== 'detailed')
  const entries = useMemo(() => pairEntries(items), [items])
  const summary = useMemo(() => buildGroupSummary(entries), [entries])
  const hasPending = entries.some(e => !e.result)
  const hasError = entries.some(e => e.result?.isError)
  const dotClass = hasError ? 'err' : hasPending ? 'run' : 'ok'

  // Sync collapsed when effectiveDensity changes (user clicked the toggle).
  useEffect(() => {
    setCollapsed(effectiveDensity !== 'detailed')
  }, [effectiveDensity])

  const cycleDensity = () => {
    setLocalDensity(d => d === null ? 'compact' : d === 'compact' ? 'detailed' : null)
  }

  const toggleLabel = localDensity === null ? '◎' : localDensity === 'compact' ? '⊟' : '☰'
  const toggleTitle = localDensity === null
    ? '跟随全局密度 · 点击切换'
    : localDensity === 'compact'
      ? '紧凑 · 点击切换'
      : '详细 · 点击恢复全局'

  return (
    <div className={`tool-group ${effectiveDensity}`}>
      <button
        className="tool-group-summary"
        onClick={() => !compact && setCollapsed(c => !c)}
        aria-expanded={compact ? false : !collapsed}
        disabled={compact}
        title={compact ? '密度设为 compact，工具组已永久折叠。在 设置 > 工具密度 中调整。' : undefined}
      >
        {!compact && <span className={`chev ${collapsed ? '' : 'open'}`} aria-hidden>▸</span>}
        <span className={`tool-dot ${dotClass}`} aria-hidden />
        <span className="tool-group-label">{summary}</span>
        <span className="tool-group-count">{entries.length}</span>
        <span
          className="tool-density-toggle"
          onClick={(e) => { e.stopPropagation(); cycleDensity() }}
          title={toggleTitle}
          role="button"
          aria-label={toggleTitle}
        >{toggleLabel}</span>
      </button>
      {!collapsed && entries.map((e, i) => (
        <PairedRow key={e.tool?.key ?? e.result?.key ?? i} entry={e} />
      ))}
    </div>
  )
}

export const ToolGroup = memo(ToolGroupImpl, (a, b) =>
  a.density === b.density && a.items.length === b.items.length && a.items.every((x, i) => x === b.items[i])
)

function McpBadge({ name }: { name: string }) {
  const parsed = parseMcpToolName(name)
  if (!parsed) return null
  return <span className="mcp-badge" title={`MCP: ${parsed.serverId} · ${parsed.toolName}`}>[{parsed.serverId}]</span>
}

function PairedRowImpl({ entry }: { entry: PairedEntry }) {
  const [open, setOpen] = useState(!!entry.result?.isError)
  const name = entry.name
  const status = entry.result?.isError ? 'err' : entry.result ? 'ok' : 'run'

  // Build a smart preview for the tool row head.
  const previewText = useMemo(() => {
    if (!entry.tool) return ''
    const text = entry.tool.text
    if (name === 'bash') {
      const cmd = text.trim().split('\n')[0] ?? ''
      return cmd.length > 80 ? `${cmd.slice(0, 80)}…` : cmd
    }
    if (text.startsWith('{')) {
      try {
        const obj = JSON.parse(text)
        if (obj.path) return obj.path
        if (obj.TargetFile) return obj.TargetFile
        if (obj.pattern) return obj.pattern
        if (obj.query) return obj.query
      } catch (e) {}
    }
    const firstLine = text.split('\n', 1)[0] ?? ''
    return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine
  }, [entry.tool, name])

  return (
    <div className={`tool-row ${entry.result?.isError ? 'err' : ''}`}>
      <button className="tool-row-head" onClick={() => setOpen(o => !o)}>
        <span className={`tool-dot ${status}`} aria-hidden />
        <span className="tool-name">{name}</span>
        <McpBadge name={name} />
        {!open && previewText && <PreviewText text={previewText} />}
      </button>
      {open && (
        <div className="tool-body-wrap">
          {entry.tool && (
            <div className="tool-input-section">
              <span className="tool-prompt-sym">$</span>
              <pre className="tool-cmd">{entry.tool.text}</pre>
            </div>
          )}
          {entry.result && (
            <pre className="tool-output-section">{truncateBody(entry.result.text)}</pre>
          )}
        </div>
      )}
    </div>
  )
}

export const PairedRow = memo(PairedRowImpl, (a, b) =>
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
        <McpBadge name={name} />
        {!open && preview && <PreviewText text={preview} />}
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
  const shouldOpen = !!block.isError
  return (
    <div className="tool-card">
      <ToolRow block={block} defaultOpen={shouldOpen} />
    </div>
  )
}

export const ToolCard = memo(ToolCardImpl, (a, b) => a.block === b.block)
