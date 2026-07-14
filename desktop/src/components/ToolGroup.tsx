import { memo, useState, useMemo, useEffect, Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '../i18n'
import type { ConvoBlock } from '../state/event-reducer'
import type { ToolDensity } from '../lib/persist'
import { FilePath } from './FilePath'
import { parseMcpToolName } from '../lib/approval-preview'
import { classifyBrowserDebugLine, parseNetworkLine } from '../../../src/tools/browser-debug/log-capture.js'
import type { ParsedNetworkRow } from '../../../src/tools/browser-debug/log-capture.js'
import { getArtifact } from '../runtime/client'
import { DiffView } from './DiffView'

const TOOL_BODY_MAX = 10000
/** Lines shown when collapsed (before "展开全文" button). */
const COLLAPSED_LINES = 50

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
  return block.toolName ?? (block.role ?? '').split(' · ')[1] ?? block.role ?? block.kind
}

const DIFF_TOOLS = new Set(['edit_file', 'write_file', 'apply_patch', 'hash_edit'])

/** True when tool output looks like a unified diff (edit/write uiContent). */
export function looksLikeUnifiedDiff(text: string): boolean {
  if (!text) return false
  return /^diff --git |^--- |^\+\+\+ |^@@ -\d+/m.test(text)
}

export function isInlineDiffTool(name: string): boolean {
  return DIFF_TOOLS.has(name.toLowerCase())
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
    ? `${text.slice(0, TOOL_BODY_MAX)}\n${i18n.t('threadView:tool.truncated', { count: text.length - TOOL_BODY_MAX })}`
    : text
}

/** Expandable output body: shows first N lines, "展开全文" reveals everything.
 *  Replaces the old hard truncation at 10k chars. */
function ExpandableBody({ text }: { text: string }) {
  const { t } = useTranslation('threadView')
  const lines = text.split('\n')
  const isLong = lines.length > COLLAPSED_LINES
  const [expanded, setExpanded] = useState(false)

  if (!isLong) return <pre className="tool-output-section">{text}</pre>

  const visible = expanded ? text : lines.slice(0, COLLAPSED_LINES).join('\n')
  return (
    <>
      <pre className="tool-output-section">{visible}</pre>
      {!expanded && (
        <button
          className="tool-expand-btn"
          onClick={() => setExpanded(true)}
        >
          {t('tool.expandAll', { count: lines.length })}
        </button>
      )}
      {expanded && (
        <button
          className="tool-expand-btn"
          onClick={() => setExpanded(false)}
        >
          {t('tool.collapse')}
        </button>
      )}
    </>
  )
}

/** Collapsible inline DiffView for edit/write/apply_patch uiContent. */
function InlineDiffBody({ text }: { text: string }) {
  const { t } = useTranslation('threadView')
  const [expanded, setExpanded] = useState(true)
  const stats = useMemo(() => {
    let add = 0
    let del = 0
    for (const line of text.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) add++
      else if (line.startsWith('-') && !line.startsWith('---')) del++
    }
    return { add, del }
  }, [text])
  return (
    <div className="tool-inline-diff">
      <button type="button" className="tool-diff-summary" onClick={() => setExpanded(v => !v)}>
        <span className="tool-diff-stat add">+{stats.add}</span>
        <span className="tool-diff-stat del">−{stats.del}</span>
        <span className="tool-diff-toggle">
          {expanded
            ? t('tool.collapseDiff', { defaultValue: 'Collapse diff' })
            : t('tool.expandDiff', { defaultValue: 'Expand diff' })}
        </span>
      </button>
      {expanded && (
        <div className="tool-diff-body">
          <DiffView raw={text} hideToolbar />
        </div>
      )}
    </div>
  )
}

function ResultBody({ result, name }: { result: ConvoBlock; name: string }) {
  if (isInlineDiffTool(name) && looksLikeUnifiedDiff(result.text)) {
    return <InlineDiffBody text={result.text} />
  }
  return <ExpandableBody text={result.text} />
}

// Leading file-path token: POSIX absolute (/…), Windows drive (C:\… or C:/…),
// or home-relative (~/…). Allows spaces inside directory/file names (common on
// Windows) but stops at shell operators/punctuation so `cd /a && ls` doesn't
// swallow the rest of the command.
const FILE_PATH_RE = /^(?:[a-zA-Z]:[\\/]|\/|~\/)(?:[^\s&|;<>()`"\\]+[\\/]?)+/

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
  const { t } = useTranslation('threadView')
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
    ? t('tool.densityFollow')
    : localDensity === 'compact'
      ? t('tool.densityCompact')
      : t('tool.densityDetailed')

  return (
    <div className={`tool-group ${effectiveDensity}`}>
      <button
        className="tool-group-summary"
        onClick={() => !compact && setCollapsed(c => !c)}
        aria-expanded={compact ? false : !collapsed}
        disabled={compact}
        title={compact ? t('tool.compactLocked') : undefined}
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

function PairedRowImpl({ entry, sessionId, onOpenImage }: {
  entry: PairedEntry
  sessionId?: string
  onOpenImage?: (src: string) => void
}) {
  const [open, setOpen] = useState(!!entry.result?.isError)
  const name = entry.name
  const status = entry.result?.isError ? 'err' : entry.result ? 'ok' : 'run'
  const isBrowserDebug = name === 'browser_debug' || name === 'computer_use'

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
            isBrowserDebug ? (
              <BrowserDebugBody result={entry.result} sessionId={sessionId} onOpenImage={onOpenImage} />
            ) : (
              <ResultBody result={entry.result} name={name} />
            )
          )}
        </div>
      )}
    </div>
  )
}

export const PairedRow = memo(PairedRowImpl, (a, b) =>
  a.entry.tool === b.entry.tool && a.entry.result === b.entry.result &&
  a.sessionId === b.sessionId && a.onOpenImage === b.onOpenImage
)

// ── BrowserDebugBody: rich render of browser_debug / computer_use output ──
// console/network lines get a severity class from the shared classifier; a
// screenshot result (`… → artifact <id>`) is fetched and inlined as an image.
// computer_use snapshots wrap the id in parens (`(screenshot → artifact <id>)`),
// so the id charset is restricted instead of \S+ (which would eat the `)`).
const SCREENSHOT_ARTIFACT_RE = /→ artifact ([\w.:-]+)/

function BrowserDebugBody({ result, sessionId, onOpenImage }: {
  result: ConvoBlock
  sessionId?: string
  onOpenImage?: (src: string) => void
}) {
  const text = truncateBody(result.text)
  const artifactId = useMemo(() => {
    const m = result.text.match(SCREENSHOT_ARTIFACT_RE)
    return m ? m[1]! : null
  }, [result.text])

  const [shotUrl, setShotUrl] = useState<string | null>(null)
  const [shotFailed, setShotFailed] = useState(false)
  useEffect(() => {
    if (!artifactId || !sessionId) return
    let cancelled = false
    getArtifact(sessionId, artifactId)
      .then(({ raw }) => { if (!cancelled && raw) setShotUrl(`data:image/png;base64,${raw}`) })
      .catch(() => { if (!cancelled) setShotFailed(true) })
    return () => { cancelled = true }
  }, [artifactId, sessionId])

  const lines = text.split('\n')

  if (artifactId) {
    // computer_use snapshot results carry the accessibility tree below the
    // artifact note — keep the tree readable instead of one giant muted line.
    const [head, ...rest] = lines
    return (
      <div className="tool-output-section bd-output">
        <div className="bd-line bd-muted">{head}</div>
        {shotUrl && !shotFailed && (
          <img
            className="msg-thumb bd-shot"
            src={shotUrl}
            alt="screenshot"
            loading="lazy"
            onClick={() => onOpenImage?.(shotUrl)}
            onError={() => setShotFailed(true)}
          />
        )}
        {rest.length > 0 && rest.map((line, i) => (
          <div key={i} className={`bd-line bd-${classifyBrowserDebugLine(line)}`}>{line || '\u00a0'}</div>
        ))}
      </div>
    )
  }
  const netRows = useMemo(() => parseNetworkRows(lines), [text])
  if (netRows) return <NetworkTable rows={netRows} />
  return (
    <div className="tool-output-section bd-output">
      {lines.map((line, i) => (
        <div key={i} className={`bd-line bd-${classifyBrowserDebugLine(line)}`}>{line || '\u00a0'}</div>
      ))}
    </div>
  )
}

// ── NetworkTable: structured render of `network` output ──
// The `network` action returns formatted lines; we parse them back into rows
// (parseNetworkLine, shared with the TUI formatter) and show a sortable table.
// A row captured with include_body carries a body that expands inline.

interface NetworkRow { row: ParsedNetworkRow; body?: string }

/** Parse `network` output lines into rows, or null if this isn't network output. */
function parseNetworkRows(lines: string[]): NetworkRow[] | null {
  const rows: NetworkRow[] = []
  for (const line of lines) {
    if (line.trim() === '') continue
    if (line.startsWith('  body:')) {
      const last = rows[rows.length - 1]
      if (last) last.body = line.slice('  body:'.length).trim()
      continue
    }
    const parsed = parseNetworkLine(line)
    if (!parsed) return null
    rows.push({ row: parsed })
  }
  return rows.length > 0 ? rows : null
}

function statusClass(r: ParsedNetworkRow): string {
  if (r.dir === 'failed') return 'bd-error'
  if (r.dir === 'pending') return 'bd-pending'
  const s = r.status ?? 0
  if (s >= 500) return 'bd-error'
  if (s >= 400) return 'bd-warn'
  if (s >= 200 && s < 300) return 'bd-ok'
  return 'bd-muted'
}

function statusLabel(r: ParsedNetworkRow): string {
  if (r.dir === 'failed') return '✗'
  if (r.dir === 'pending') return '…'
  return String(r.status ?? '')
}

type SortKey = 'status' | 'ms' | null

function NetworkTable({ rows }: { rows: NetworkRow[] }) {
  const [sort, setSort] = useState<SortKey>(null)
  const [openBody, setOpenBody] = useState<number | null>(null)

  const ordered = useMemo(() => {
    const withIdx = rows.map((r, i) => ({ r, i }))
    if (sort === 'status') withIdx.sort((a, b) => (a.r.row.status ?? 0) - (b.r.row.status ?? 0))
    else if (sort === 'ms') withIdx.sort((a, b) => (b.r.row.durationMs ?? 0) - (a.r.row.durationMs ?? 0))
    return withIdx
  }, [rows, sort])

  const toggle = (k: Exclude<SortKey, null>) => setSort(s => (s === k ? null : k))

  return (
    <div className="tool-output-section bd-net">
      <table className="bd-net-table">
        <thead>
          <tr>
            <th className="bd-net-sortable" onClick={() => toggle('status')}>Status{sort === 'status' ? ' ▲' : ''}</th>
            <th>Method</th>
            <th>URL</th>
            <th>Type</th>
            <th className="bd-net-sortable bd-net-num" onClick={() => toggle('ms')}>ms{sort === 'ms' ? ' ▼' : ''}</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map(({ r, i }) => (
            <Fragment key={i}>
              <tr
                className={`bd-net-row ${r.body ? 'bd-net-clickable' : ''}`}
                onClick={r.body ? () => setOpenBody(o => (o === i ? null : i)) : undefined}
              >
                <td className={`bd-net-status ${statusClass(r.row)}`}>{statusLabel(r.row)}</td>
                <td className="bd-net-method">{r.row.method}</td>
                <td className="bd-net-url" title={r.row.url}>{r.row.url}{r.row.errorText ? ` (${r.row.errorText})` : ''}</td>
                <td className="bd-net-type">{r.row.resourceType ?? ''}</td>
                <td className="bd-net-num">{r.row.durationMs ?? ''}</td>
              </tr>
              {r.body && openBody === i && (
                <tr className="bd-net-bodyrow">
                  <td colSpan={5}><pre className="bd-net-body">{r.body}</pre></td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}

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
      {open && (
        block.kind === 'result'
          ? <ResultBody result={block} name={name} />
          : <ExpandableBody text={block.text} />
      )}
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
