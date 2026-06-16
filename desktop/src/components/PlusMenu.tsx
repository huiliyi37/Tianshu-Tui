import { useEffect } from 'react'
import type { PlanModeState } from '../runtime/types'
import type { ComposerCommand } from '../lib/composer-commands'

// Cursor 3.0-style "+" menu: a categorized popover that consolidates the
// composer's actions (mode / image / slash commands) into one discoverable
// surface. Models / Skills / MCP are shown disabled — the desktop runtime has
// no backend for them yet, so they are placeholders for a later phase.
export function PlusMenu(props: {
  planMode?: PlanModeState
  onSetPlanMode?: (state: PlanModeState) => void
  onPickImage: () => void
  imageDisabled?: boolean
  commands?: ComposerCommand[]
  onRunCommand: (cmd: ComposerCommand) => void
  onClose: () => void
}) {
  const { planMode, onSetPlanMode, onPickImage, imageDisabled, commands, onRunCommand, onClose } = props
  const planning = planMode === 'planning'

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const pick = (fn: () => void) => () => { fn(); onClose() }

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
          { glyph: '◇', label: 'Models' },
          { glyph: '✦', label: 'Skills' },
          { glyph: '⚙', label: 'MCP Servers' },
        ]).map((it) => (
          <button key={it.label} className="plus-menu-item disabled" role="menuitem" disabled title="暂未接入">
            <span className="pm-glyph" aria-hidden>{it.glyph}</span>
            <span className="pm-label">{it.label}</span>
            <span className="pm-trailing pm-hint">暂未接入</span>
            <span className="pm-chev" aria-hidden>▸</span>
          </button>
        ))}
      </div>
    </div>
  )
}
