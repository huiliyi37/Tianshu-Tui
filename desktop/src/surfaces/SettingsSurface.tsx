import { useState } from 'react'
import { useHealth } from '../state/queries'
import { loadThemePref, setThemePref, type ThemePref } from '../lib/theme'

const THEME_LABEL: Record<ThemePref, string> = {
  system: '跟随系统',
  light: '亮色',
  dark: '暗色',
}

export function SettingsSurface() {
  const health = useHealth()
  const [theme, setTheme] = useState<ThemePref>(() => loadThemePref())

  const pick = (t: ThemePref) => {
    setTheme(t)
    setThemePref(t)
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
