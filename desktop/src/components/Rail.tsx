import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  LayoutDashboard, Clock, Bell, Puzzle, GitBranch, BarChart3,
  Network, Settings, Sun, Moon, Laptop, Scale, type LucideIcon,
} from 'lucide-react'
import type { Surface } from '../state/store'
import { loadThemePref, setThemePref, type ThemePref } from '../lib/theme'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const ICONS: Record<Surface, LucideIcon> = {
  workspace: LayoutDashboard,
  automations: Clock,
  attention: Bell,
  skills: Puzzle,
  git: GitBranch,
  insights: BarChart3,
  delegation: Network,
  council: Scale,
  settings: Settings,
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
  attentionCount?: number
}) {
  const { surface, onSurface, attentionCount } = props
  const { t: tNav } = useTranslation('nav')
  const { t: tTheme } = useTranslation('theme')
  const [theme, setTheme] = useState<ThemePref>(() => loadThemePref())

  const order: Surface[] = ['workspace', 'automations', 'attention', 'skills', 'git', 'insights', 'delegation', 'council', 'settings']

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
          <Tooltip key={s}>
            <TooltipTrigger
              className={`rail-item ${surface === s ? 'active' : ''}`}
              onClick={() => onSurface(s)}
            >
              <Icon icon={ICONS[s]} />
              {s === 'attention' && (attentionCount ?? 0) > 0 && (
                <span className="rail-badge">{(attentionCount ?? 0) > 9 ? '9+' : attentionCount ?? 0}</span>
              )}
            </TooltipTrigger>
            <TooltipContent side="right">{tNav(s)}</TooltipContent>
          </Tooltip>
        ))}
      </div>
      <div className="rail-foot">
        <Tooltip>
          <TooltipTrigger
            className="rail-item"
            onClick={cycleTheme}
          >
            <Icon icon={THEME_ICON[theme]} />
          </TooltipTrigger>
          <TooltipContent side="right">{`${tTheme('label')}：${tTheme(theme)}`}</TooltipContent>
        </Tooltip>
      </div>
    </nav>
  )
}
