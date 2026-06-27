import { useState } from 'react'
import {
  LayoutDashboard, Clock, Bell, Puzzle, GitBranch, BarChart3,
  Network, Settings, Sun, Moon, Laptop, type LucideIcon,
} from 'lucide-react'
import type { Surface } from '../state/store'
import { loadThemePref, setThemePref, type ThemePref } from '../lib/theme'

const ICONS: Record<Surface, LucideIcon> = {
  workspace: LayoutDashboard,
  automations: Clock,
  attention: Bell,
  skills: Puzzle,
  git: GitBranch,
  insights: BarChart3,
  delegation: Network,
  settings: Settings,
}

const LABELS: Record<Surface, string> = {
  workspace: '工作台',
  automations: '自动化',
  attention: '需处理',
  skills: '技能',
  git: 'Git',
  insights: 'Insights',
  delegation: '委派树',
  settings: '设置',
}

const THEME_ICON: Record<ThemePref, LucideIcon> = {
  system: Laptop,
  light: Sun,
  dark: Moon,
}

/** Renders a lucide icon at the rail's standard size/color. */
function Icon({ icon: Ic }: { icon: LucideIcon }) {
  return <Ic size={18} strokeWidth={1.7} aria-hidden />
}

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

  const order: Surface[] = ['workspace', 'automations', 'attention', 'skills', 'git', 'insights', 'delegation', 'settings']

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
            <Icon icon={ICONS[s]} />
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
          <Icon icon={THEME_ICON[theme]} />
        </button>
      </div>
    </nav>
  )
}
