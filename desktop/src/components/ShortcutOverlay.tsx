import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'

// P1-6 — shortcut cheatsheet overlay (Cmd+/ toggles). Static reference table;
// the actual bindings live in use-global-shortcuts.ts and Composer.tsx.

const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent)
const MOD = IS_MAC ? '⌘' : 'Ctrl'

interface ShortcutRow {
  keys: string[]
  desc: string
}

function buildGroups(t: TFunction<'shell'>): Array<{ title: string; rows: ShortcutRow[] }> {
  return [
    {
      title: t('shortcuts.groupGlobal'),
      rows: [
        { keys: [`${MOD}+K`], desc: t('shortcuts.commandPalette') },
        { keys: [`${MOD}+/`], desc: t('shortcuts.cheatsheet') },
        { keys: [`${MOD}+N`], desc: t('shortcuts.newSession') },
        { keys: [`${MOD}+1…9`], desc: t('shortcuts.switchSurface') },
        { keys: [`${MOD}+,`], desc: t('shortcuts.settings') },
      ],
    },
    {
      title: t('shortcuts.groupSession'),
      rows: [
        { keys: ['Ctrl+Tab', `${MOD}+Shift+]`], desc: t('shortcuts.nextTab') },
        { keys: ['Ctrl+Shift+Tab', `${MOD}+Shift+[`], desc: t('shortcuts.prevTab') },
        { keys: [`${MOD}+W`], desc: t('shortcuts.closeTab') },
        { keys: [`${MOD}+B`], desc: t('shortcuts.toggleSidebar') },
        { keys: [`${MOD}+Shift+B`], desc: t('shortcuts.toggleReview') },
        { keys: [`${MOD}+J`, 'Ctrl+`'], desc: t('shortcuts.toggleTerminal') },
        { keys: [`${MOD}+;`], desc: t('shortcuts.sideQuestion') },
        { keys: [`${MOD}+.`], desc: t('shortcuts.zenMode') },
        { keys: [`${MOD}+O`], desc: t('shortcuts.viewModeCycle') },
        { keys: [t('shortcuts.msgNavKey')], desc: t('shortcuts.msgNav') },
      ],
    },
    {
      title: t('shortcuts.groupComposer'),
      rows: [
        { keys: ['Enter'], desc: t('shortcuts.send') },
        { keys: ['Shift+Enter'], desc: t('shortcuts.newline') },
        { keys: ['Shift+Tab'], desc: t('shortcuts.planToggle') },
        { keys: ['Esc'], desc: t('shortcuts.clearInput') },
        { keys: ['Esc Esc'], desc: t('shortcuts.rewind') },
        { keys: ['@'], desc: t('shortcuts.fileRef') },
        { keys: ['/'], desc: t('shortcuts.slashMenu') },
      ],
    },
    {
      title: t('shortcuts.groupFeatures'),
      rows: [
        { keys: [t('shortcuts.plusMenuKey')], desc: t('shortcuts.plusMenu') },
        { keys: ['/effort'], desc: t('shortcuts.effort') },
        { keys: [t('shortcuts.clickFileKey')], desc: t('shortcuts.clickFile') },
        { keys: ['Insights'], desc: t('shortcuts.insights') },
        { keys: ['/council'], desc: t('shortcuts.council') },
        { keys: ['/team'], desc: t('shortcuts.team') },
      ],
    },
  ]
}

export function ShortcutOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation('shell')
  const groups = useMemo(() => buildGroups(t), [t])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="shortcut-overlay-backdrop" onClick={onClose} role="presentation">
      <div
        className="shortcut-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={t('shortcuts.ariaLabel')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shortcut-overlay-head">
          <h3>{t('shortcuts.title')}</h3>
          <button className="icon-btn" onClick={onClose} aria-label={t('common:close')}>✕</button>
        </div>
        <div className="shortcut-overlay-body">
          {groups.map((g) => (
            <section key={g.title} className="shortcut-group">
              <h4>{g.title}</h4>
              {g.rows.map((row) => (
                <div key={row.desc} className="shortcut-row">
                  <span className="shortcut-keys">
                    {row.keys.map((k, i) => (
                      <span key={k}>
                        {i > 0 && <span className="shortcut-or">{t('shortcuts.or')}</span>}
                        <kbd>{k}</kbd>
                      </span>
                    ))}
                  </span>
                  <span className="shortcut-desc">{row.desc}</span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
