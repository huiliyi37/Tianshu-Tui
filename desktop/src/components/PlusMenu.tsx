import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PlanModeState, AskModeState } from '../runtime/types'
import type { ComposerCommand } from '../lib/composer-commands'
import {
  abortSession,
  listModels, switchModel,
  listDomains, setDomain,
  listSkills, setSkillEnabled,
  getMcpStatus,
} from '../runtime/client'
import type { McpStatusResponse } from '../runtime/types'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  CommandDialog,
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command'
import { CheckIcon } from 'lucide-react'
import { useUiDispatch } from '../state/store'

// Cursor 3.0-style "+" menu. Root DropdownMenu consolidates mode / image / slash
// commands; Models / Skills / 星域 / MCP / Effort open a Command-dialog sub-panel
// (searchable list, current item checked, keyboard nav, live SSE re-fetch).
type Panel = 'models' | 'skills' | 'domain' | 'mcp' | 'commands' | 'effort'

/** Available reasoning effort levels, ordered from least to most reasoning. */
const EFFORT_LEVELS = ['off', 'low', 'medium', 'high', 'max', 'auto'] as const

/** A normalized list row shared by all selectable sub-panels. */
interface Row {
  key: string
  label: string
  desc?: string
  active: boolean
}

export function PlusMenu(props: {
  sessionId: string
  /** Bumped on model/domain/skills SSE so an open panel re-fetches. */
  menuRev?: number
  /** Whether the session is currently running (model switch needs abort first). */
  sessionRunning?: boolean
  planMode?: PlanModeState
  onSetPlanMode?: (state: PlanModeState) => void
  askMode?: AskModeState
  onSetAskMode?: (state: AskModeState) => void
  /** Current reasoning effort level (off/low/medium/high/max/auto). */
  effort?: string
  onSetEffort?: (effort: string) => void
  onPickImage: () => void
  imageDisabled?: boolean
  commands?: ComposerCommand[]
  onRunCommand: (cmd: ComposerCommand) => void
  /** Open the "派子代理" dispatch dialog (user-launched background subagent). */
  onDelegate?: () => void
  /** Send a slash workflow command (/council, /team) — opens the workflow prompt. */
  onWorkflow?: (cmd: string) => void
  onClose: () => void
  /** Controlled open state for the root dropdown. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  threadNonEmpty?: boolean
}) {
  const {
    sessionId, menuRev, sessionRunning, planMode, onSetPlanMode, askMode, onSetAskMode, effort, onSetEffort,
    onPickImage, imageDisabled, commands, onRunCommand, onDelegate, onWorkflow, onClose,
    open, onOpenChange, threadNonEmpty,
  } = props
  const { t } = useTranslation('composer')
  const planning = planMode === 'planning'
  const asking = askMode === 'asking'
  const modeValue = asking ? 'ask' : planning ? 'plan' : 'agent'
  const [panel, setPanel] = useState<Panel | null>(null)
  const dispatch = useUiDispatch()

  const closeSub = () => setPanel(null)
  const openSub = (p: Panel) => setPanel(p)
  const pick = (fn: () => void) => () => { fn(); onClose() }

  return (
    <>
      <DropdownMenu open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger
          className={`plus-btn ${open ? 'open' : ''}`}
          aria-label={t('plusMenu.add')}
          aria-haspopup="menu"
        >
          +
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" sideOffset={6} className="min-w-56">
          {(onSetPlanMode || onSetAskMode) && (
            <>
              <DropdownMenuRadioGroup
                value={modeValue}
                onValueChange={(v) => {
                  if (v === 'plan') {
                    onSetAskMode?.('off')
                    onSetPlanMode?.('planning')
                  } else if (v === 'ask') {
                    onSetPlanMode?.('off')
                    onSetAskMode?.('asking')
                  } else {
                    onSetPlanMode?.('off')
                    onSetAskMode?.('off')
                  }
                }}
              >
                <DropdownMenuRadioItem value="plan">
                  <span className="inline-flex w-4 justify-center text-muted-foreground" aria-hidden>◑</span>
                  <span>Plan</span>
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="ask">
                  <span className="inline-flex w-4 justify-center text-muted-foreground" aria-hidden>?</span>
                  <span>Ask</span>
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="agent">
                  <span className="inline-flex w-4 justify-center text-muted-foreground" aria-hidden>●</span>
                  <span>Agent</span>
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
            </>
          )}

          <DropdownMenuItem disabled={imageDisabled} onClick={pick(onPickImage)}>
            <span className="inline-flex w-4 justify-center text-muted-foreground" aria-hidden>⊞</span>
            <span>{t('plusMenu.image')}</span>
            <span className="ml-auto text-xs text-muted-foreground">PNG/JPEG/WebP/GIF</span>
          </DropdownMenuItem>

          {onDelegate && (
            <DropdownMenuItem onClick={pick(onDelegate)}>
              <span className="inline-flex w-4 justify-center text-muted-foreground" aria-hidden>⌗</span>
              <span>{t('plusMenu.delegate')}</span>
              <span className="ml-auto text-xs text-muted-foreground">{t('plusMenu.delegateDesc')}</span>
            </DropdownMenuItem>
          )}

          {onWorkflow && (
            <>
              <DropdownMenuItem onClick={pick(() => onWorkflow('/council'))}>
                <span className="inline-flex w-4 justify-center text-muted-foreground" aria-hidden>♟</span>
                <span>{t('plusMenu.council')}</span>
                <span className="ml-auto text-xs text-muted-foreground">{t('plusMenu.councilDesc')}</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={pick(() => onWorkflow('/team'))}>
                <span className="inline-flex w-4 justify-center text-muted-foreground" aria-hidden>⬡</span>
                <span>{t('plusMenu.team')}</span>
                <span className="ml-auto text-xs text-muted-foreground">{t('plusMenu.teamDesc')}</span>
              </DropdownMenuItem>
            </>
          )}

          {commands && commands.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => openSub('commands')}>
                <span className="inline-flex w-4 justify-center font-mono text-accent" aria-hidden>/</span>
                <span>{t('plusMenu.commands')}</span>
                <span className="ml-auto text-xs text-muted-foreground">▸</span>
              </DropdownMenuItem>
            </>
          )}

          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={pick(() => dispatch({ type: 'openConnect', open: true }))}>
            <span className="inline-flex w-4 justify-center text-muted-foreground" aria-hidden>◈</span>
            <span>{t('plusMenu.connect')}</span>
            <span className="ml-auto text-xs text-muted-foreground">{t('plusMenu.connectDesc')}</span>
          </DropdownMenuItem>
          {([
            { glyph: '◇', label: 'Models', panel: 'models' as const },
            { glyph: '✦', label: 'Skills', panel: 'skills' as const },
            { glyph: '✶', label: t('plusMenu.domainLabel'), panel: 'domain' as const },
            { glyph: '⚡', label: t('plusMenu.effortLabel'), panel: 'effort' as const },
            { glyph: '⚙', label: 'MCP Servers', panel: 'mcp' as const },
          ]).map((it) => (
            <DropdownMenuItem key={it.label} onClick={() => openSub(it.panel)}>
              <span className="inline-flex w-4 justify-center text-muted-foreground" aria-hidden>{it.glyph}</span>
              <span>{it.label}</span>
              <span className="ml-auto text-xs text-muted-foreground">▸</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {panel === 'models' && (
        <PickerPanel
          title="Models"
          sessionId={sessionId}
          menuRev={menuRev}
          mode="single"
          emptyHint={t('plusMenu.modelsEmpty')}
          onClose={closeSub}
          load={async (id) => (await listModels(id)).map<Row>((m) => ({
            key: m.id,
            label: m.alias || m.id,
            desc: m.contextWindow ? `${m.provider} · ${Math.round(m.contextWindow / 1000)}K` : m.provider,
            active: m.current,
          }))}
          apply={async (id, row) => {
            if (sessionRunning) {
              await abortSession(id)
              await new Promise((r) => setTimeout(r, 300))
            }
            await switchModel(id, row.key)
          }}
        />
      )}
      {panel === 'domain' && (
        <PickerPanel
          title={t('plusMenu.domainLabel')}
          sessionId={sessionId}
          menuRev={menuRev}
          mode="single"
          emptyHint={t('plusMenu.domainsEmpty')}
          onClose={closeSub}
          load={async (id) => (await listDomains(id)).map<Row>((d) => {
            const glyph = d.uiPersona?.glyph ? `${d.uiPersona.glyph} ` : ''
            // Auto shows its keyword fallback so it never reads as "no domain".
            const label = d.key === 'auto' ? `${glyph}${d.name} · ${t('plusMenu.autoDomainSuffix')}` : `${glyph}${d.name}`
            return { key: d.key, label, desc: d.meta || d.motto, active: d.current }
          })}
          apply={async (id, row) => { await setDomain(id, row.key) }}
          warning={threadNonEmpty ? `⚠ ${t('domainCacheWarning')}` : undefined}
        />
      )}
      {panel === 'effort' && onSetEffort && (
        <PickerPanel
          title={t('plusMenu.effortTitle')}
          sessionId={sessionId}
          menuRev={menuRev}
          mode="single"
          emptyHint={t('plusMenu.effortEmpty')}
          onClose={closeSub}
          load={async () => EFFORT_LEVELS.map<Row>((level) => ({
            key: level,
            label: t(`plusMenu.effort.${level}`),
            desc: t(`plusMenu.effortDesc.${level}`),
            active: effort === level,
          }))}
          apply={async (_id, row) => { onSetEffort(row.key) }}
        />
      )}
      {panel === 'skills' && (
        <PickerPanel
          title="Skills"
          sessionId={sessionId}
          menuRev={menuRev}
          mode="toggle"
          emptyHint={t('plusMenu.skillsEmpty')}
          onClose={closeSub}
          load={async (id) => (await listSkills(id)).map<Row>((s) => ({
            key: s.name,
            label: s.name,
            desc: s.description,
            active: s.enabled,
          }))}
          apply={async (id, row) => { await setSkillEnabled(id, row.key, !row.active) }}
        />
      )}
      {panel === 'commands' && commands && commands.length > 0 && (
        <PickerPanel
          title={t('plusMenu.commandsTitle')}
          sessionId={sessionId}
          menuRev={menuRev}
          mode="single"
          emptyHint={t('plusMenu.commandsEmpty')}
          onClose={closeSub}
          load={async () => commands.map<Row>((cmd) => ({
            key: cmd.name,
            label: cmd.name,
            desc: cmd.desc,
            active: false,
          }))}
          apply={async (_id, row) => {
            const cmd = commands.find((c) => c.name === row.key)
            if (cmd) onRunCommand(cmd)
          }}
        />
      )}
      {panel === 'mcp' && (
        <McpPanel sessionId={sessionId} menuRev={menuRev} onClose={closeSub} />
      )}
    </>
  )
}

/** MCP status dot + label for a single server state. */
function McpStatusBadge({ status, toolCount, error }: { status: string; toolCount: number; error?: string }) {
  const { t } = useTranslation('composer')
  const dot: Record<string, string> = {
    connected: '●', connecting: '◐', degraded: '◐', error: '✗', disconnected: '○',
  }
  const label: Record<string, string> = {
    connected: t('mcp.connected'),
    connecting: t('mcp.connecting'),
    degraded: t('mcp.degraded'),
    error: t('mcp.error'),
    disconnected: t('mcp.disconnected'),
  }
  const cls = status === 'connected' ? 'text-success' : status === 'error' ? 'text-destructive' : status === 'disconnected' ? 'text-muted-foreground' : 'text-warning'
  return (
    <span className={`flex items-center gap-1.5 text-xs ${cls}`} title={error ?? ''}>
      <span>{dot[status] ?? '○'}</span>
      <span>{label[status] ?? status}</span>
      {toolCount > 0 && <span className="text-muted-foreground">{toolCount} tools</span>}
    </span>
  )
}

/** MCP second-level panel: lists configured servers with connection status and tool count. */
function McpPanel(props: { sessionId: string; menuRev?: number; onClose: () => void }) {
  const { menuRev, onClose } = props
  const { t } = useTranslation('composer')
  const [status, setStatus] = useState<McpStatusResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const reqSeq = useRef(0)

  const fetch = useCallback(async () => {
    const seq = ++reqSeq.current
    setLoading(true)
    try {
      const s = await getMcpStatus()
      if (seq !== reqSeq.current) return
      setStatus(s)
      setError(null)
    } catch {
      if (seq !== reqSeq.current) return
      setError(t('mcp.statusError'))
    } finally {
      if (seq === reqSeq.current) setLoading(false)
    }
  }, [t])

  useEffect(() => { void fetch() }, [fetch, menuRev])

  return (
    <CommandDialog open title="MCP Servers" description={t('mcp.desc')} onOpenChange={(open) => { if (!open) onClose() }}>
      <Command shouldFilter>
        <CommandInput placeholder={t('mcp.filterPlaceholder')} />
        <CommandList>
          <CommandGroup heading="MCP Servers">
            {loading && <CommandEmpty>{t('loading')}</CommandEmpty>}
            {error && <CommandEmpty className="text-destructive">{error}</CommandEmpty>}
            {!loading && !error && status && status.servers.length === 0 && (
              <CommandEmpty>{t('mcp.empty')}</CommandEmpty>
            )}
            {!loading && status && status.servers.map((s) => (
              <CommandItem
                key={s.serverId}
                value={`${s.serverId} ${s.status} ${s.transport ?? ''}`}
                onSelect={() => {}}
              >
                <span className="flex-1 truncate">{s.serverId}</span>
                <span className="text-xs text-muted-foreground">{s.transport ?? '—'}</span>
                <McpStatusBadge status={s.status} toolCount={s.toolCount} error={s.error} />
              </CommandItem>
            ))}
          </CommandGroup>
          {!loading && status && status.servers.length > 0 && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              {t('mcp.toolsAvailable', { total: status.totalTools })}
            </div>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  )
}

/**
 * Second-level picker panel: a searchable, keyboard-navigable Command list.
 * `single` mode is a radio list (apply = switch to that row); `toggle` mode
 * flips each row's state and keeps the panel open. After any apply the list is
 * re-fetched so the checkmark reflects the server's authoritative state.
 */
function PickerPanel(props: {
  title: string
  sessionId: string
  menuRev?: number
  mode: 'single' | 'toggle'
  emptyHint: string
  onClose: () => void
  load: (sessionId: string) => Promise<Row[]>
  apply: (sessionId: string, row: Row) => Promise<void>
  warning?: string
}) {
  const { title, sessionId, menuRev, mode, emptyHint, onClose, load, apply, warning } = props
  const { t } = useTranslation('composer')
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const reqSeq = useRef(0)

  const refetch = useCallback(async () => {
    const seq = ++reqSeq.current
    try {
      const next = await load(sessionId)
      if (seq !== reqSeq.current) return
      setRows(next)
      setError(null)
    } catch {
      if (seq !== reqSeq.current) return
      setError(t('plusMenu.loadFailed'))
      setRows([])
    }
  }, [load, sessionId, t])

  useEffect(() => { void refetch() }, [refetch, menuRev])

  const filtered = useMemo(() => {
    const all = rows ?? []
    const q = query.trim().toLowerCase()
    if (!q) return all
    return all.filter((r) => r.label.toLowerCase().includes(q) || (r.desc ?? '').toLowerCase().includes(q))
  }, [rows, query])

  const handleSelect = useCallback(async (row: Row) => {
    setBusyKey(row.key)
    try {
      await apply(sessionId, row)
      await refetch()
      if (mode === 'single') onClose()
    } catch {
      setError(t('plusMenu.actionFailed'))
    } finally {
      setBusyKey(null)
    }
  }, [apply, mode, onClose, refetch, sessionId, t])

  return (
    <CommandDialog open title={title} description={t('plusMenu.searchAndSelect', { title })} onOpenChange={(open) => { if (!open) onClose() }}>
      <Command shouldFilter={false}>
        <CommandInput
          placeholder={t('plusMenu.searchPlaceholder')}
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          <CommandGroup heading={title}>
            {rows === null && <CommandEmpty>{t('loading')}</CommandEmpty>}
            {error && <CommandEmpty className="text-destructive">{error}</CommandEmpty>}
            {rows !== null && !error && filtered.map((row) => (
              <CommandItem
                key={row.key}
                value={`${row.key} ${row.label} ${row.desc ?? ''}`}
                disabled={busyKey === row.key}
                onSelect={() => void handleSelect(row)}
              >
                <span className="flex-1 truncate">{row.label}</span>
                {row.desc && (
                  <span className="truncate text-xs text-muted-foreground max-w-[180px]">{row.desc}</span>
                )}
                {mode === 'toggle' ? (
                  <span className={`text-xs ${row.active ? 'text-accent' : 'text-muted-foreground'}`}>
                    {row.active ? '●' : '○'}
                  </span>
                ) : (
                  row.active && <CheckIcon className="size-4 text-accent" />
                )}
              </CommandItem>
            ))}
            {rows !== null && !error && filtered.length === 0 && (
              <CommandEmpty>{query ? t('plusMenu.noMatch') : emptyHint}</CommandEmpty>
            )}
          </CommandGroup>
        </CommandList>
        {warning && (
          <div className="picker-panel-warning">
            {warning}
          </div>
        )}
      </Command>
    </CommandDialog>
  )
}
