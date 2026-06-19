import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PlanModeState } from '../runtime/types'
import type { ComposerCommand } from '../lib/composer-commands'
import {
  abortSession,
  listModels, switchModel,
  listDomains, setDomain,
  listSkills, setSkillEnabled,
} from '../runtime/client'

// Cursor 3.0-style "+" menu. Root popover consolidates mode / image / slash
// commands; Models / Skills / 星域 open second-level panels (searchable list,
// current item checked, keyboard nav, live SSE re-fetch) wired to the runtime.
type Panel = 'root' | 'models' | 'skills' | 'domain'

/** A normalized list row shared by all three sub-panels. */
interface Row {
  /** Stable selection key (model id / domain key / skill name). */
  key: string
  label: string
  desc?: string
  /** Single-select: the current choice. Toggle: enabled. */
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
  onPickImage: () => void
  imageDisabled?: boolean
  commands?: ComposerCommand[]
  onRunCommand: (cmd: ComposerCommand) => void
  onClose: () => void
}) {
  const {
    sessionId, menuRev, sessionRunning, planMode, onSetPlanMode,
    onPickImage, imageDisabled, commands, onRunCommand, onClose,
  } = props
  const planning = planMode === 'planning'
  const [panel, setPanel] = useState<Panel>('root')

  // Esc: a sub-panel returns to root; the root closes the menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (panel !== 'root') { e.stopPropagation(); setPanel('root') }
      else onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [panel, onClose])

  const pick = (fn: () => void) => () => { fn(); onClose() }

  if (panel === 'models') {
    return (
      <SubPanel
        title="Models"
        sessionId={sessionId}
        menuRev={menuRev}
        mode="single"
        emptyHint="未发现可用模型"
        onBack={() => setPanel('root')}
        load={async (id) => (await listModels(id)).map<Row>((m) => ({
          key: m.id,
          label: m.alias || m.id,
          desc: m.contextWindow ? `${m.provider} · ${Math.round(m.contextWindow / 1000)}K` : m.provider,
          active: m.current,
        }))}
        apply={async (id, row) => {
          if (sessionRunning) {
            await abortSession(id)
            await new Promise(r => setTimeout(r, 300))
          }
          await switchModel(id, row.key)
        }}
      />
    )
  }
  if (panel === 'domain') {
    return (
      <SubPanel
        title="星域 Domain"
        sessionId={sessionId}
        menuRev={menuRev}
        mode="single"
        emptyHint="未发现星域"
        onBack={() => setPanel('root')}
        load={async (id) => (await listDomains(id)).map<Row>((d) => ({
          key: d.key,
          label: d.name,
          desc: d.meta || d.motto,
          active: d.current,
        }))}
        apply={async (id, row) => { await setDomain(id, row.key) }}
      />
    )
  }
  if (panel === 'skills') {
    return (
      <SubPanel
        title="Skills"
        sessionId={sessionId}
        menuRev={menuRev}
        mode="toggle"
        emptyHint="未加载任何技能"
        onBack={() => setPanel('root')}
        load={async (id) => (await listSkills(id)).map<Row>((s) => ({
          key: s.name,
          label: s.name,
          desc: s.description,
          active: s.enabled,
        }))}
        apply={async (id, row) => { await setSkillEnabled(id, row.key, !row.active) }}
      />
    )
  }

  return (
    <div className="plus-menu" role="menu">
      {onSetPlanMode && (
        <div className="plus-menu-section">
          <div className="plus-menu-title">模式</div>
          <button className="plus-menu-item" role="menuitemradio" aria-checked={planning} onClick={pick(() => onSetPlanMode('planning'))}>
            <span className="pm-glyph" aria-hidden>◑</span>
            <span className="pm-label">Plan</span>
            <span className="pm-trailing">{planning ? '✓' : ''}</span>
          </button>
          <button className="plus-menu-item" role="menuitemradio" aria-checked={!planning} onClick={pick(() => onSetPlanMode('off'))}>
            <span className="pm-glyph" aria-hidden>●</span>
            <span className="pm-label">Agent</span>
            <span className="pm-trailing">{!planning ? '✓' : ''}</span>
          </button>
        </div>
      )}

      <div className="plus-menu-section">
        <button className="plus-menu-item" role="menuitem" disabled={imageDisabled} onClick={pick(onPickImage)}>
          <span className="pm-glyph" aria-hidden>⊞</span>
          <span className="pm-label">图片</span>
          <span className="pm-trailing pm-hint">PNG/JPEG/WebP/GIF</span>
        </button>
      </div>

      {commands && commands.length > 0 && (
        <div className="plus-menu-section">
          <div className="plus-menu-title">命令</div>
          {commands.map((cmd) => (
            <button key={cmd.name} className="plus-menu-item" role="menuitem" onClick={pick(() => onRunCommand(cmd))}>
              <span className="pm-glyph mono" aria-hidden>/</span>
              <span className="pm-label">{cmd.name.replace(/^\//, '')}</span>
              <span className="pm-trailing pm-hint">{cmd.desc}</span>
            </button>
          ))}
        </div>
      )}

      <div className="plus-menu-section">
        {([
          { glyph: '◇', label: 'Models', panel: 'models' as const },
          { glyph: '✦', label: 'Skills', panel: 'skills' as const },
          { glyph: '✶', label: '星域 Domain', panel: 'domain' as const },
        ]).map((it) => (
          <button
            key={it.label}
            className="plus-menu-item"
            role="menuitem"
            aria-haspopup="menu"
            onClick={() => setPanel(it.panel)}
          >
            <span className="pm-glyph" aria-hidden>{it.glyph}</span>
            <span className="pm-label">{it.label}</span>
            <span className="pm-chev" aria-hidden>▸</span>
          </button>
        ))}
        <button className="plus-menu-item disabled" role="menuitem" disabled title="暂未接入">
          <span className="pm-glyph" aria-hidden>⚙</span>
          <span className="pm-label">MCP Servers</span>
          <span className="pm-trailing pm-hint">暂未接入</span>
        </button>
      </div>
    </div>
  )
}

/**
 * Second-level panel: a searchable, keyboard-navigable list. `single` mode is a
 * radio list (apply = switch to that row); `toggle` mode flips each row's state
 * (apply = enable/disable) and keeps the panel open. After any apply the list is
 * re-fetched so the checkmark/switch reflects the server's authoritative state.
 */
function SubPanel(props: {
  title: string
  sessionId: string
  menuRev?: number
  mode: 'single' | 'toggle'
  emptyHint: string
  onBack: () => void
  load: (sessionId: string) => Promise<Row[]>
  apply: (sessionId: string, row: Row) => Promise<void>
}) {
  const { title, sessionId, menuRev, mode, emptyHint, onBack, load, apply } = props
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
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
      setError('加载失败，请重试')
      setRows([])
    }
  }, [load, sessionId])

  // Fetch on mount + whenever a relevant SSE event bumps menuRev.
  useEffect(() => { void refetch() }, [refetch, menuRev])
  useEffect(() => { searchRef.current?.focus() }, [])

  const filtered = useMemo(() => {
    const all = rows ?? []
    const q = query.trim().toLowerCase()
    if (!q) return all
    return all.filter((r) => r.label.toLowerCase().includes(q) || (r.desc ?? '').toLowerCase().includes(q))
  }, [rows, query])

  useEffect(() => { setIndex(0) }, [query, rows])

  const onApply = useCallback(async (row: Row) => {
    setBusyKey(row.key)
    try {
      await apply(sessionId, row)
      await refetch()
    } catch {
      setError('操作失败，请重试')
    } finally {
      setBusyKey(null)
    }
  }, [apply, refetch, sessionId])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, Math.max(0, filtered.length - 1))) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); const row = filtered[index]; if (row) void onApply(row) }
  }

  return (
    <div className="plus-menu plus-submenu" role="menu">
      <div className="plus-sub-head">
        <button className="plus-back" onClick={onBack} aria-label="返回" title="返回">‹</button>
        <span className="plus-sub-title">{title}</span>
      </div>
      <div className="plus-sub-search">
        <input
          ref={searchRef}
          className="plus-search-input"
          placeholder="搜索…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="plus-sub-list" role="listbox">
        {rows === null && <div className="plus-sub-state">加载中…</div>}
        {error && <div className="plus-sub-state error">{error}</div>}
        {rows !== null && !error && filtered.length === 0 && (
          <div className="plus-sub-state">{query ? '无匹配项' : emptyHint}</div>
        )}
        {filtered.map((row, i) => (
          <button
            key={row.key}
            role={mode === 'toggle' ? 'menuitemcheckbox' : 'menuitemradio'}
            aria-checked={row.active}
            className={`plus-menu-item plus-row ${i === index ? 'active' : ''}`}
            onMouseEnter={() => setIndex(i)}
            onClick={() => void onApply(row)}
            disabled={busyKey === row.key}
          >
            <span className="pm-label">
              {row.label}
              {row.desc && <span className="pm-row-desc">{row.desc}</span>}
            </span>
            {mode === 'toggle'
              ? <span className={`pm-switch ${row.active ? 'on' : 'off'}`} aria-hidden>{row.active ? '●' : '○'}</span>
              : <span className="pm-trailing">{row.active ? '✓' : ''}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}
