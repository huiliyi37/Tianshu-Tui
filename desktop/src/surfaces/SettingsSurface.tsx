import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Palette, SlidersHorizontal, Plug, Cpu, type LucideIcon } from 'lucide-react'
import { useUiDispatch, useUiState } from '../state/store'
import { useHealth } from '../state/queries'
import { loadThemePref, setThemePref, type ThemePref } from '../lib/theme'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { AutonomyControl } from '../components/AutonomyControl'
import { coerceLevel, type AutonomyLevel } from '../lib/autonomy'
import { loadDefaultAutonomy, saveDefaultAutonomy, loadNotifPref, saveNotifPref, type ToolDensity, type NotifPref } from '../lib/persist'
import { ProviderSettings } from '../components/ProviderSettings'
import { McpSettings } from '../components/McpSettings'
import { getMcpStatus, addMcpServer, removeMcpServer, restartMcpServer } from '../runtime/client'
import type { McpStatusResponse, McpServerConfig } from '../runtime/types'
import { useWallpaper, type WallpaperFit } from '../components/WallpaperLayer'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
type SettingsCat = 'appearance' | 'behavior' | 'integrations' | 'system'

const SETTINGS_CATS: { id: SettingsCat; label: string; icon: LucideIcon }[] = [
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'behavior', label: '行为', icon: SlidersHorizontal },
  { id: 'integrations', label: '集成', icon: Plug },
  { id: 'system', label: '系统', icon: Cpu },
]

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
  const [activeCat, setActiveCat] = useState<SettingsCat>('appearance')
  const health = useHealth()
  const dispatch = useUiDispatch()
  const ui = useUiState()
  const [autonomy, setAutonomy] = useState<AutonomyLevel>(() => coerceLevel(loadDefaultAutonomy()))
  const [notifPref, setNotifPref] = useState<NotifPref>(() => loadNotifPref())
  const [theme, setTheme] = useState<ThemePref>(() => loadThemePref())

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
    <div className="settings-dual">
      {/* Left: category nav */}
      <nav className="settings-nav">
        {SETTINGS_CATS.map((c) => (
          <button
            key={c.id}
            className={`settings-nav-item ${activeCat === c.id ? 'active' : ''}`}
            onClick={() => setActiveCat(c.id)}
          >
            <c.icon size={16} strokeWidth={1.7} />
            <span>{c.label}</span>
          </button>
        ))}
      </nav>

      {/* Right: content */}
      <div className="settings-content">
        {activeCat === 'appearance' && (
          <>
            <section className="settings-group">
              <h4>主题</h4>
              <Select value={theme} onValueChange={(v) => pick(v as ThemePref)}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder="选择主题" />
                </SelectTrigger>
                <SelectContent>
                  {(['system', 'light', 'dark'] as ThemePref[]).map((t) => (
                    <SelectItem key={t} value={t}>{THEME_LABEL[t]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </section>
            <LanguageSection />
            <WallpaperSection />
          </>
        )}
        {activeCat === 'behavior' && (
          <>
            <section className="settings-group">
              <h4>新线程默认自治档位</h4>
              <AutonomyControl value={autonomy} onChange={pickAutonomy} />
              <div className="meta">自治档项目内全自动执行；项目外写入仍受沙箱限制，可随时回滚。</div>
            </section>
            <section className="settings-group">
              <h4>工具组密度</h4>
              <Select value={ui.toolDensity} onValueChange={(v) => pickDensity(v as ToolDensity)}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder="选择密度" />
                </SelectTrigger>
                <SelectContent>
                  {(['compact', 'balanced', 'detailed'] as ToolDensity[]).map((d) => (
                    <SelectItem key={d} value={d}>{DENSITY_LABEL[d]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="meta">控制 read/search 工具组的折叠行为。</div>
            </section>
            <section className="settings-group">
              <h4>通知</h4>
              <Select value={notifPref} onValueChange={(v) => pickNotif(v as NotifPref)}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder="选择通知策略" />
                </SelectTrigger>
                <SelectContent>
                  {(['never', 'background', 'always'] as NotifPref[]).map((n) => (
                    <SelectItem key={n} value={n}>{NOTIF_LABEL[n]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="meta">控制何时收到系统通知。</div>
            </section>
          </>
        )}
        {activeCat === 'integrations' && (
          <>
            <section className="settings-group">
              <h4>模型 Provider</h4>
              <ProviderSettings />
            </section>
            <section className="settings-group">
              <McpSettingsManager />
            </section>
          </>
        )}
        {activeCat === 'system' && (
          <>
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
          </>
        )}
      </div>
    </div>
  )
}

function UpdaterSection() {
  const [checking, setChecking] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [update, setUpdate] = useState<Update | null>(null)
  const [progress, setProgress] = useState<number | null>(null)

  const handleCheck = async () => {
    setChecking(true)
    setMessage(null)
    setUpdate(null)
    setProgress(null)
    try {
      const result = await check()
      if (result) {
        setUpdate(result)
        setMessage(`发现新版本 ${result.version}。`)
      } else {
        setMessage('当前已是最新版本。')
      }
    } catch (err) {
      setMessage(`检查更新失败：${(err as Error).message}（若刚配置签名，请确认 pubkey 与 endpoint 已填实）`)
    } finally {
      setChecking(false)
    }
  }

  const handleInstall = async () => {
    if (!update) return
    setInstalling(true)
    setProgress(0)
    setMessage(null)
    try {
      let total = 0
      let downloaded = 0
      // downloadAndInstall streams progress events; on completion resolves and
      // relaunch must run after the install finishes writing.
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            total = event.data.contentLength ?? 0
            break
          case 'Progress':
            downloaded += event.data.chunkLength ?? 0
            setProgress(total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null)
            break
          case 'Finished':
            // 进入"重启中"过渡态：installing=false + 完成提示，避免 relaunch 前
            // 盲等让用户以为卡住（与 UpdateBanner 一致）。
            setProgress(100)
            setInstalling(false)
            setMessage('安装完成，正在重启…')
            break
        }
      })
      await relaunch()
    } catch (err) {
      setMessage(`安装失败：${(err as Error).message}`)
    } finally {
      setInstalling(false)
    }
  }

  return (
    <section className="settings-group">
      <h4>更新</h4>
      <button className="btn" onClick={handleCheck} disabled={checking || installing}>
        {checking ? '检查中…' : '检查更新'}
      </button>
      {update && (
        <div className="updater-actions">
          <div className="meta">新版本 {update.version} 可用。</div>
          {update.body && <div className="meta">{update.body}</div>}
          <button className="btn" onClick={handleInstall} disabled={installing}>
            {installing ? (progress != null ? `下载中 ${progress}%` : '安装中…') : '下载并安装'}
          </button>
        </div>
      )}
      {installing && progress != null && (
        <div className="updater-progress">
          <div className="updater-progress-bar" style={{ width: `${progress}%` }} />
        </div>
      )}
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
  const { wallpaper, fit, pick, clear, changeFit } = useWallpaper()
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const FIT_LABEL: Record<WallpaperFit, string> = {
    cover: '填充',
    contain: '适应',
    center: '居中',
  }

  const handlePick = useCallback(
    async (f: File) => {
      setBusy(true)
      try {
        await pick(f)
      } finally {
        setBusy(false)
      }
    },
    [pick],
  )

  return (
    <section className="settings-group">
      <h4>壁纸与毛玻璃</h4>
      <div className="wallpaper-row">
        <div
          className="wallpaper-preview"
          style={wallpaper ? { backgroundImage: `url("${wallpaper.url}")` } : undefined}
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
              if (f) handlePick(f)
              e.target.value = ''
            }}
          />
          <button className="btn" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? '处理中…' : '选择图片'}
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
        壁纸经压缩后存在本地 IndexedDB，不会上传。
      </div>
    </section>
  )
}

/** Language selector — switches i18next locale, persisted to localStorage. */
function LanguageSection() {
  const { t } = useTranslation('language')
  const { i18n } = useTranslation()
  const langs = ['zh-CN', 'en'] as const
  return (
    <section className="settings-group">
      <h4>{t('label')}</h4>
      <Select value={i18n.language} onValueChange={(v) => { if (v) i18n.changeLanguage(v) }}>
        <SelectTrigger className="w-40">
          <SelectValue placeholder={t('label')} />
        </SelectTrigger>
        <SelectContent>
          {langs.map((l) => (
            <SelectItem key={l} value={l}>{t(l)}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </section>
  )
}
