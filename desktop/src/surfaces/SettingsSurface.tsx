import { useState } from 'react'
import { useHealth } from '../state/queries'
import { loadThemePref, setThemePref, type ThemePref } from '../lib/theme'
import { AutonomyControl } from '../components/AutonomyControl'
import { coerceLevel, type AutonomyLevel } from '../lib/autonomy'
import { loadDefaultAutonomy, saveDefaultAutonomy } from '../lib/persist'

const THEME_LABEL: Record<ThemePref, string> = {
  system: '跟随系统',
  light: '亮色',
  dark: '暗色',
}

export function SettingsSurface() {
  const health = useHealth()
  const [theme, setTheme] = useState<ThemePref>(() => loadThemePref())
  const [autonomy, setAutonomy] = useState<AutonomyLevel>(() => coerceLevel(loadDefaultAutonomy()))

  const pick = (t: ThemePref) => {
    setTheme(t)
    setThemePref(t)
  }

  const pickAutonomy = (lvl: AutonomyLevel) => {
    setAutonomy(lvl)
    saveDefaultAutonomy(lvl)
  }

  return (
    <div className="single-pane settings">
      <div className="panel-header"><span>设置</span></div>

      <section className="settings-group">
        <h4>外观</h4>
        <div className="seg">
          {(['system', 'light', 'dark'] as ThemePref[]).map((t) => (
            <button
              key={t}
              className={`seg-item ${theme === t ? 'active' : ''}`}
              onClick={() => pick(t)}
            >
              {THEME_LABEL[t]}
            </button>
          ))}
        </div>
      </section>

      <section className="settings-group">
        <h4>新线程默认自治档位</h4>
        <AutonomyControl value={autonomy} onChange={pickAutonomy} />
        <div className="meta">自治档项目内全自动执行；项目外写入仍受沙箱限制，可随时回滚。</div>
      </section>

      <section className="settings-group">
        <h4>运行时 (sidecar)</h4>
        {health.isError ? (
          <div className="meta warn">sidecar 离线，重连中…</div>
        ) : (
          <dl className="kv">
            <div><dt>版本</dt><dd>{health.data?.version ?? '—'}</dd></div>
            <div><dt>会话数</dt><dd>{health.data?.sessionCount ?? 0}</dd></div>
            <div><dt>运行中</dt><dd>{health.data?.runningCount ?? 0}</dd></div>
            <div>
              <dt>运行时长</dt>
              <dd>{health.data ? `${Math.round(health.data.uptimeMs / 1000)}s` : '—'}</dd>
            </div>
          </dl>
        )}
      </section>
    </div>
  )
}
