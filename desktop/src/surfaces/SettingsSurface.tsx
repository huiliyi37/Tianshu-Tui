import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Palette, SlidersHorizontal, Plug, Cpu, type LucideIcon } from 'lucide-react'
import { useUiDispatch, useUiState } from '../state/store'
import { useHealth } from '../state/queries'
import { loadThemePref, setThemePref, type ThemePref } from '../lib/theme'
import { loadFontWeightPref, setFontWeightPref, type FontWeightPref } from '../lib/font-weight'
import { loadFontFamilyPref, setFontFamilyPref, type FontFamilyPref } from '../lib/font-family'
import { loadGlassConfig, saveGlassConfig, type GlassConfig } from '../lib/glass-custom'
import { useGlassMode } from '../lib/glass'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { AutonomyControl } from '../components/AutonomyControl'
import { GlassCustomPanel } from '../components/GlassCustomPanel'
import { FontSettingsPanel } from '../components/FontSettingsPanel'
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

const SETTINGS_CATS: { id: SettingsCat; icon: LucideIcon }[] = [
  { id: 'appearance', icon: Palette },
  { id: 'behavior', icon: SlidersHorizontal },
  { id: 'integrations', icon: Plug },
  { id: 'system', icon: Cpu },
]



export function SettingsSurface() {
  const { t } = useTranslation('settings')

  const THEME_LABEL: Record<ThemePref, string> = {
    system: t('theme.system'),
    light: t('theme.light'),
    dark: t('theme.dark'),
    nebula: t('theme.nebula'),
  }
  const DENSITY_LABEL: Record<ToolDensity, string> = {
    compact: t('densityCompact'),
    balanced: t('densityBalanced'),
    detailed: t('densityDetailed'),
  }
  const NOTIF_LABEL: Record<NotifPref, string> = {
    never: t('notifNever'),
    background: t('notifBackground'),
    always: t('notifAlways'),
  }
  const FONT_WEIGHT_LABEL: Record<FontWeightPref, string> = {
    normal: t('fontWeight.normal'),
    medium: t('fontWeight.medium'),
    bold: t('fontWeight.bold'),
  }

  const [activeCat, setActiveCat] = useState<SettingsCat>('appearance')
  const health = useHealth()
  const dispatch = useUiDispatch()
  const ui = useUiState()
  const [autonomy, setAutonomy] = useState<AutonomyLevel>(() => coerceLevel(loadDefaultAutonomy()))
  const [notifPref, setNotifPref] = useState<NotifPref>(() => loadNotifPref())
  const [theme, setTheme] = useState<ThemePref>(() => loadThemePref())
  const [fontWeight, setFontWeight] = useState<FontWeightPref>(() => loadFontWeightPref())
  const [fontFamily, setFontFamily] = useState<FontFamilyPref>(() => loadFontFamilyPref())
  const [glassConfig, setGlassConfig] = useState<GlassConfig>(() => loadGlassConfig())

  const pick = (t: ThemePref) => {
    setTheme(t)
    setThemePref(t)
  }

  const pickFontWeight = (w: FontWeightPref) => {
    setFontWeight(w)
    setFontWeightPref(w)
  }

  const pickFontFamily = (f: FontFamilyPref) => {
    setFontFamily(f)
    setFontFamilyPref(f)
  }

  const updateGlass = (updates: Partial<GlassConfig>) => {
    const next = { ...glassConfig, ...updates }
    setGlassConfig(next)
    saveGlassConfig(next)
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
            <span>{t(`cat.${c.id}`)}</span>
          </button>
        ))}
      </nav>

      {/* Right: content */}
      <div className="settings-content">
        {activeCat === 'appearance' && (
          <>
            <section className="settings-group">
              <h4>{t('themeLabel')}</h4>
              <Select value={theme} onValueChange={(v) => pick(v as ThemePref)}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder={t('themePlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {(['system', 'light', 'dark', 'nebula'] as ThemePref[]).map((t) => (
                    <SelectItem key={t} value={t}>{THEME_LABEL[t]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </section>
            <section className="settings-group">
              <h4>{t('fontWeightLabel')}</h4>
              <Select value={fontWeight} onValueChange={(v) => pickFontWeight(v as FontWeightPref)}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder={t('fontWeightPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {(['normal', 'medium', 'bold'] as FontWeightPref[]).map((w) => (
                    <SelectItem key={w} value={w}>{FONT_WEIGHT_LABEL[w]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="meta">{t('fontWeightHint')}</div>
            </section>
            <FontSettingsPanel value={fontFamily} onChange={pickFontFamily} />
            <LanguageSection />
            <WallpaperSection glassConfig={glassConfig} updateGlass={updateGlass} />
          </>
        )}
        {activeCat === 'behavior' && (
          <>
            <section className="settings-group">
              <h4>{t('autonomy')}</h4>
              <AutonomyControl value={autonomy} onChange={pickAutonomy} />
              <div className="meta">{t('autonomyHint')}</div>
            </section>
            <section className="settings-group">
              <h4>{t('toolDensity')}</h4>
              <Select value={ui.toolDensity} onValueChange={(v) => pickDensity(v as ToolDensity)}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder={t('densityPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {(['compact', 'balanced', 'detailed'] as ToolDensity[]).map((d) => (
                    <SelectItem key={d} value={d}>{DENSITY_LABEL[d]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="meta">{t('toolDensityHint')}</div>
            </section>
            <section className="settings-group">
              <h4>{t('notifications')}</h4>
              <Select value={notifPref} onValueChange={(v) => pickNotif(v as NotifPref)}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder={t('notifPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {(['never', 'background', 'always'] as NotifPref[]).map((n) => (
                    <SelectItem key={n} value={n}>{NOTIF_LABEL[n]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="meta">{t('notifHint')}</div>
            </section>
          </>
        )}
        {activeCat === 'integrations' && (
          <>
            <section className="settings-group">
              <h4>{t('provider')}</h4>
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
              <h4>{t('runtime')}</h4>
              {health.isError ? (
                <div className="meta warn">{t('sidecarOffline')}</div>
              ) : (
                <dl className="kv">
                  <div><dt>{t('runtimeVersion')}</dt><dd>{health.data?.version ?? '—'}</dd></div>
                  <div><dt>{t('runtimeSessions')}</dt><dd>{health.data?.sessionCount ?? 0}</dd></div>
                  <div><dt>{t('runtimeRunning')}</dt><dd>{health.data?.runningCount ?? 0}</dd></div>
                  <div>
                    <dt>{t('runtimeUptime')}</dt>
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
  const { t } = useTranslation('settings')
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
        setMessage(t('updateAvailable', { version: result.version }))
      } else {
        setMessage(t('updateLatest'))
      }
    } catch (err) {
      setMessage(t('updateCheckFailed', { error: (err as Error).message }))
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
            setMessage(t('updateInstallingComplete'))
            break
        }
      })
      await relaunch()
    } catch (err) {
      setMessage(t('updateInstallFailed', { error: (err as Error).message }))
    } finally {
      setInstalling(false)
    }
  }

  return (
    <section className="settings-group">
      <h4>{t('update')}</h4>
      <button className="btn" onClick={handleCheck} disabled={checking || installing}>
        {checking ? t('updateChecking') : t('updateCheck')}
      </button>
      {update && (
        <div className="updater-actions">
          <div className="meta">{t('updateAvailableShort', { version: update.version })}</div>
          {update.body && <div className="meta">{update.body}</div>}
          <button className="btn" onClick={handleInstall} disabled={installing}>
            {installing ? (progress != null ? t('updateDownloading', { progress }) : t('updateInstalling')) : t('updateDownload')}
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
function WallpaperSection({
  glassConfig,
  updateGlass,
}: {
  glassConfig: GlassConfig
  updateGlass: (updates: Partial<GlassConfig>) => void
}) {
  const { t } = useTranslation('settings')
  const { wallpaper, fit, pick, clear, changeFit } = useWallpaper()
  const [glassMode, setGlassMode] = useGlassMode()
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const FIT_LABEL: Record<WallpaperFit, string> = {
    cover: t('wallpaperFitCover'),
    contain: t('wallpaperFitContain'),
    center: t('wallpaperFitCenter'),
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
      <h4>{t('wallpaper')}</h4>
      <div className="wallpaper-row">
        <div
          className="wallpaper-preview"
          style={wallpaper ? { backgroundImage: `url("${wallpaper.url}")` } : undefined}
        >
          {!wallpaper && <span className="wallpaper-empty">{t('wallpaperEmpty')}</span>}
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
            {busy ? t('wallpaperProcessing') : t('selectImage')}
          </button>
          {wallpaper && (
            <button className="btn btn-danger" onClick={clear}>
              {t('clearWallpaper')}
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
      <div className="settings-field">
        <label className="field-check">
          <input
            type="checkbox"
            checked={glassMode}
            onChange={(e) => setGlassMode(e.target.checked)}
          />
          <span>{t('glassMode')}</span>
        </label>
      </div>

      {glassMode && <GlassCustomPanel config={glassConfig} onChange={updateGlass} />}

      <div className="meta" style={{ marginTop: '12px' }}>
        {t('wallpaperHint')}
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
