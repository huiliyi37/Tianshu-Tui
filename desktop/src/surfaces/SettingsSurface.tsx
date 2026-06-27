import { useState, useEffect, useCallback, useRef } from 'react'
import { useHealth } from '../state/queries'
import { useUiDispatch, useUiState } from '../state/store'
import { loadThemePref, setThemePref, type ThemePref } from '../lib/theme'
import { check } from '@tauri-apps/plugin-updater'
import { AutonomyControl } from '../components/AutonomyControl'
import { coerceLevel, type AutonomyLevel } from '../lib/autonomy'
import { loadDefaultAutonomy, saveDefaultAutonomy, loadNotifPref, saveNotifPref, type ToolDensity, type NotifPref } from '../lib/persist'
import { ProviderSettings } from '../components/ProviderSettings'
import { McpSettings } from '../components/McpSettings'
import { getMcpStatus, addMcpServer, removeMcpServer, restartMcpServer } from '../runtime/client'
import type { McpStatusResponse, McpServerConfig } from '../runtime/types'
import { useWallpaperControl, type WallpaperFit } from '../components/WallpaperLayer'

const THEME_LABEL: Record<ThemePref, string> = {
  system: '跟随系统',
  light: '亮色',
  dark: '暗色',
}

const DENSITY_LABEL: Record<ToolDensity, string> = {
  compact: '紧凑',
  balanced: '均衡',
  detailed: '详细',
}

const NOTIF_LABEL: Record<NotifPref, string> = {
  never: '从不',
  background: '仅后台',
  always: '始终',
}

export function SettingsSurface() {
  const health = useHealth()
  const ui = useUiState()
  const dispatch = useUiDispatch()
  const [theme, setTheme] = useState<ThemePref>(() => loadThemePref())
  const [autonomy, setAutonomy] = useState<AutonomyLevel>(() => coerceLevel(loadDefaultAutonomy()))
  const [notifPref, setNotifPref] = useState<NotifPref>(() => loadNotifPref())

  const pick = (t: ThemePref) => {
    setTheme(t)
    setThemePref(t)
  }

  const pickAutonomy = (lvl: AutonomyLevel) => {
    setAutonomy(lvl)
    saveDefaultAutonomy(lvl)
  }

  const pickDensity = (d: ToolDensity) => {
    dispatch({ type: 'setToolDensity', density: d })
  }

  const pickNotif = (n: NotifPref) => {
    setNotifPref(n)
    saveNotifPref(n)
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

      <WallpaperSection />

      <section className="settings-group">
        <h4>新线程默认自治档位</h4>
        <AutonomyControl value={autonomy} onChange={pickAutonomy} />
        <div className="meta">自治档项目内全自动执行；项目外写入仍受沙箱限制，可随时回滚。</div>
      </section>

      <section className="settings-group">
        <h4>工具组密度</h4>
        <div className="seg">
          {(['compact', 'balanced', 'detailed'] as ToolDensity[]).map((d) => (
            <button
              key={d}
              className={`seg-item ${ui.toolDensity === d ? 'active' : ''}`}
              onClick={() => pickDensity(d)}
            >
              {DENSITY_LABEL[d]}
            </button>
          ))}
        </div>
        <div className="meta">控制 read/search 工具组的折叠行为：紧凑（永久折叠）、均衡（默认折叠可展开）、详细（默认展开）。</div>
      </section>

      <section className="settings-group">
        <h4>通知</h4>
        <div className="seg">
          {(['never', 'background', 'always'] as NotifPref[]).map((n) => (
            <button
              key={n}
              className={`seg-item ${notifPref === n ? 'active' : ''}`}
              onClick={() => pickNotif(n)}
            >
              {NOTIF_LABEL[n]}
            </button>
          ))}
        </div>
        <div className="meta">控制何时收到系统通知：从不（完全静默）、仅后台（窗口失焦时提醒）、始终（全部提醒）。</div>
      </section>

      <section className="settings-group">
        <h4>模型 Provider</h4>
        <ProviderSettings />
      </section>

      <section className="settings-group">
        <McpSettingsManager />
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

      <UpdaterSection />
    </div>
  )
}

function UpdaterSection() {
  const [checking, setChecking] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const handleCheck = async () => {
    setChecking(true)
    setMessage(null)
    try {
      const result = await check()
      if (result) {
        setMessage(`发现新版本 ${result.version}，请前往发布页下载。`)
      } else {
        setMessage('当前已是最新版本（或更新服务器未配置）。')
      }
    } catch (err) {
      setMessage(`检查更新失败：${(err as Error).message}（更新服务器尚未配置）`)
    } finally {
      setChecking(false)
    }
  }

  return (
    <section className="settings-group">
      <h4>更新</h4>
      <button className="btn" onClick={handleCheck} disabled={checking}>
        {checking ? '检查中…' : '检查更新'}
      </button>
      {message && <div className="meta">{message}</div>}
    </section>
  )
}

/** Inner component that manages MCP status polling and delegates to McpSettings UI. */
function McpSettingsManager() {
  const [mcpStatus, setMcpStatus] = useState<McpStatusResponse | null>(null)
  const [mcpLoading, setMcpLoading] = useState(true)
  const [mcpError, setMcpError] = useState<string | null>(null)

  const fetchStatus = useCallback(() => {
    getMcpStatus()
      .then((s) => { setMcpStatus(s); setMcpError(null) })
      .catch((err) => setMcpError((err as Error).message))
      .finally(() => setMcpLoading(false))
  }, [])

  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  const handleAdd = useCallback((config: McpServerConfig) => {
    addMcpServer(config)
      .then(() => fetchStatus())
      .catch((err) => setMcpError((err as Error).message))
  }, [fetchStatus])

  const handleRemove = useCallback((serverId: string) => {
    removeMcpServer(serverId)
      .then(() => fetchStatus())
      .catch((err) => setMcpError((err as Error).message))
  }, [fetchStatus])

  const handleRestart = useCallback((serverId: string) => {
    restartMcpServer(serverId)
      .then(() => fetchStatus())
      .catch((err) => setMcpError((err as Error).message))
  }, [fetchStatus])

  return (
    <McpSettings
      status={mcpStatus}
      statusLoading={mcpLoading}
      statusError={mcpError}
      onAdd={handleAdd}
      onRemove={handleRemove}
      onRestart={handleRestart}
    />
  )
}

/** Wallpaper & frosted glass settings section. */
function WallpaperSection() {
  const { wallpaper, fit, pick, clear, changeFit } = useWallpaperControl()
  const fileRef = useRef<HTMLInputElement>(null)

  const FIT_LABEL: Record<WallpaperFit, string> = {
    cover: '填充',
    contain: '适应',
    center: '居中',
  }

  return (
    <section className="settings-group">
      <h4>壁纸与毛玻璃</h4>
      <div className="wallpaper-row">
        <div
          className="wallpaper-preview"
          style={wallpaper ? { backgroundImage: `url("${wallpaper}")` } : undefined}
        >
          {!wallpaper && <span className="wallpaper-empty">无壁纸</span>}
        </div>
        <div className="wallpaper-controls">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden-file-input"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) pick(f)
              e.target.value = ''
            }}
          />
          <button className="btn" onClick={() => fileRef.current?.click()}>
            选择图片
          </button>
          {wallpaper && (
            <button className="btn btn-danger" onClick={clear}>
              清除壁纸
            </button>
          )}
          {wallpaper && (
            <div className="seg">
              {(['cover', 'contain', 'center'] as WallpaperFit[]).map((f) => (
                <button
                  key={f}
                  className={`seg-item ${fit === f ? 'active' : ''}`}
                  onClick={() => changeFit(f)}
                >
                  {FIT_LABEL[f]}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="meta">
        设置壁纸后，界面自动切换为半透明毛玻璃效果（类似 macOS vibrancy）。
        壁纸仅存储在本地，不会上传。
      </div>
    </section>
  )
}
