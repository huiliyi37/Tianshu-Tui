import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Home, LayoutDashboard, LayoutGrid, Clock, Bell, Puzzle, GitBranch, BarChart3,
  Network, Settings, Sun, Moon, Laptop, Scale, Plug, Sparkles, Flower2, Zap, Apple, type LucideIcon,
} from 'lucide-react'
import type { Surface } from '../state/store'
import { loadThemePref, setThemePref, type ThemePref } from '../lib/theme'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const ICONS: Record<Surface, LucideIcon> = {
  home: Home,
  workspace: LayoutDashboard,
  mission: LayoutGrid,
  automations: Clock,
  attention: Bell,
  skills: Puzzle,
  git: GitBranch,
  insights: BarChart3,
  delegation: Network,
  council: Scale,
  hooks: Plug,
  settings: Settings,
}

// Partial (not exhaustive) so adding a new ThemePref never breaks typecheck —
// unknown themes fall back to the system glyph at the call site.
const THEME_ICON: Partial<Record<ThemePref, LucideIcon>> = {
  system: Laptop,
  light: Sun,
  dark: Moon,
  nebula: Sparkles,
  sakura: Flower2,
  cyberpunk: Zap,
  cupertino: Apple,
}

const THEME_CYCLE: ThemePref[] = ['system', 'light', 'dark', 'nebula', 'sakura', 'cyberpunk', 'cupertino']

/** Renders a lucide icon at the rail's standard size/color. */
function Icon({ icon: Ic }: { icon: LucideIcon }) {
  return <Ic size={18} strokeWidth={1.7} aria-hidden />
}

function nextTheme(p: ThemePref): ThemePref {
  const i = THEME_CYCLE.indexOf(p)
  return THEME_CYCLE[(i + 1) % THEME_CYCLE.length]!
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

  const order: Surface[] = ['home', 'workspace', 'mission', 'automations', 'attention', 'skills', 'git', 'insights', 'delegation', 'council', 'hooks', 'settings']

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
            <Icon icon={THEME_ICON[theme] ?? Laptop} />
          </TooltipTrigger>
          <TooltipContent side="right">{`${tTheme('label')}：${tTheme(theme)}`}</TooltipContent>
        </Tooltip>
      </div>
    </nav>
  )
}
