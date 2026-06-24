import { useState } from 'react'
import type { Surface } from '../state/store'
import { loadThemePref, setThemePref, type ThemePref } from '../lib/theme'

// Minimal inline icons (stroke, currentColor) — keeps the Codex-clean look with
// zero icon-font dependency.
function Icon({ path }: { path: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={path} />
    </svg>
  )
}

const ICONS: Record<Surface, string> = {
  workspace: 'M4 5h16M4 5v14M4 19h16M14 5v14',
  automations: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
  attention: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.5 21a2 2 0 0 0 3 0',
  skills: 'M12 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM12 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0ZM15 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0Z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19 12a7 7 0 0 0-.1-1l2-1.6-2-3.4-2.3 1a7 7 0 0 0-1.7-1l-.4-2.4H9.5l-.4 2.4a7 7 0 0 0-1.7 1l-2.3-1-2 3.4 2 1.6a7 7 0 0 0 0 2l-2 1.6 2 3.4 2.3-1a7 7 0 0 0 1.7 1l.4 2.4h4.9l.4-2.4a7 7 0 0 0 1.7-1l2.3 1 2-3.4-2-1.6c.06-.33.1-.66.1-1Z',
}

const LABELS: Record<Surface, string> = {
  workspace: '工作台',
  automations: '自动化',
  attention: '需处理',
  skills: '技能',
  settings: '设置',
}

const SUN = 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4'
const MOON = 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z'
const AUTO = 'M12 3v3M12 18v3M3 12h3M18 12h3'

function nextTheme(p: ThemePref): ThemePref {
  return p === 'system' ? 'light' : p === 'light' ? 'dark' : 'system'
}

export function Rail(props: {
  surface: Surface
  onSurface: (s: Surface) => void
  attentionCount: number
}) {
  const { surface, onSurface, attentionCount } = props
  const [theme, setTheme] = useState<ThemePref>(() => loadThemePref())

  const order: Surface[] = ['workspace', 'automations', 'attention', 'skills', 'settings']

  const cycleTheme = () => {
    const t = nextTheme(theme)
    setTheme(t)
    setThemePref(t)
  }

  return (
    <nav className="rail">
      <div className="rail-brand" title="天枢 · Tianshu">枢</div>
      <div className="rail-items">
        {order.map((s) => (
          <button
            key={s}
            className={`rail-item ${surface === s ? 'active' : ''}`}
            title={LABELS[s]}
            onClick={() => onSurface(s)}
          >
            <Icon path={ICONS[s]} />
            {s === 'attention' && attentionCount > 0 && (
              <span className="rail-badge">{attentionCount > 9 ? '9+' : attentionCount}</span>
            )}
          </button>
        ))}
      </div>
      <div className="rail-foot">
        <button
          className="rail-item"
          title={`主题：${theme === 'system' ? '跟随系统' : theme === 'light' ? '亮色' : '暗色'}`}
          onClick={cycleTheme}
        >
          <Icon path={theme === 'system' ? AUTO : theme === 'light' ? SUN : MOON} />
        </button>
      </div>
    </nav>
  )
}
